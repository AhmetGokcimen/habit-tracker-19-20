'use strict';

// Habits: full CRUD with ownership (F4) and public search/filter (F7).
// Every route requires login; every route that takes an :id goes through
// authorize(), which loads the record and applies the policy table.

const express = require('express');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { moderationAudit } = require('../services/auditLog');
const { badRequest } = require('../utils/httpError');
const schedule = require('../services/schedule');
const { freezesByHabit, freezesLeft } = require('../services/freezes');

const router = express.Router();
router.use(requireAuth);

const PAGE_SIZE = 20;

// Explicit allow-list of fields sent to clients (never emails or hashes).
// The reminder time reveals a daily routine, so only the owner gets it.
function serializeHabit(row, viewer = null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    is_public: row.is_public === 1,
    schedule: schedule.fromRow(row),
    target_count: row.target_count,
    unit: row.unit,
    owner: { id: row.user_id, username: row.owner_username },
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived: row.archived_at !== null && row.archived_at !== undefined,
    ...(viewer && viewer.id === row.user_id && { reminder_time: row.reminder_time ?? null }),
    ...(row.comment_count !== undefined && { comment_count: row.comment_count }),
    ...(row.reaction_count !== undefined && { reaction_count: row.reaction_count }),
    ...(row.checkin_count !== undefined && { checkin_count: row.checkin_count }),
    ...(row.last_checkin !== undefined && { last_checkin: row.last_checkin }),
    ...(row.recent_dates !== undefined && { recent_checkins: row.recent_dates ? row.recent_dates.split(',').sort() : [] }),
  };
}

// Escapes LIKE wildcards so user input is matched literally ("%" means "%").
const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

// F7: search public habits by text and/or category. Fully parameterized.
router.get('/', validate({ query: schemas.habitSearch }), async (req, res) => {
  const { q, category, page } = req.valid.query;
  const pattern = q ? `%${escapeLike(q)}%` : null;

  const rows = await db.all(
    `SELECT h.*, u.username AS owner_username,
            (SELECT COUNT(*) FROM comments c WHERE c.habit_id = h.id) AS comment_count,
            (SELECT COUNT(*) FROM reactions r WHERE r.habit_id = h.id) AS reaction_count
       FROM habits h JOIN users u ON u.id = h.user_id
      WHERE h.is_public = 1 AND h.archived_at IS NULL
        AND (?1 IS NULL OR h.category = ?1)
        AND (?2 IS NULL OR h.title LIKE ?2 ESCAPE '\\' OR h.description LIKE ?2 ESCAPE '\\')
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT ?3 OFFSET ?4`,
    [category ?? null, pattern, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE],
  );

  res.json({
    habits: rows.slice(0, PAGE_SIZE).map(serializeHabit),
    page,
    has_more: rows.length > PAGE_SIZE,
  });
});

// The caller's own habits (public and private), with private check-in stats
// and streaks computed from the full history.
router.get('/mine', validate({ query: schemas.mineQuery }), async (req, res) => {
  const archived = req.valid.query.archived === '1';
  const [rows, dates, freezes, left] = await Promise.all([
    db.all(
      `SELECT h.*, u.username AS owner_username,
              (SELECT COUNT(*) FROM checkins c WHERE c.habit_id = h.id) AS checkin_count,
              (SELECT MAX(checkin_date) FROM checkins c WHERE c.habit_id = h.id) AS last_checkin,
              (SELECT group_concat(checkin_date) FROM checkins c
                WHERE c.habit_id = h.id AND c.checkin_date >= date('now', '-40 days')
                  AND c.amount >= h.target_count) AS recent_dates,
              (SELECT group_concat(id || ':' || checkin_date || ':' || amount) FROM checkins c
                WHERE c.habit_id = h.id AND c.checkin_date >= date('now', '-2 days')) AS latest_entries
         FROM habits h JOIN users u ON u.id = h.user_id
        WHERE h.user_id = ? AND (h.archived_at IS NOT NULL) = ?
        ORDER BY h.position, h.created_at DESC, h.id DESC`,
      [req.user.id, archived ? 1 : 0],
    ),
    db.all(
      `SELECT c.habit_id, c.checkin_date FROM checkins c JOIN habits h ON h.id = c.habit_id
        WHERE c.user_id = ? AND c.amount >= h.target_count`,
      [req.user.id],
    ),
    freezesByHabit(req.user.id),
    freezesLeft(req.user.id),
  ]);

  const byHabit = groupDates(dates);
  const thisWeek = schedule.weekIndex(schedule.todayNumber());
  const recentStart = schedule.isoDate(schedule.todayNumber() - 40);
  res.json({
    freezes_left: left,
    habits: rows.map((row) => {
      const done = byHabit.get(row.id) ?? [];
      const frozen = freezes.get(row.id) ?? [];
      return {
        ...serializeHabit(row, req.user),
        streak: schedule.streaks(row, done, frozen),
        recent_freezes: frozen.filter((d) => d >= recentStart).sort(),
        // Ids of the last few check-ins, so the dashboard can undo today's.
        latest_checkins: (row.latest_entries ? row.latest_entries.split(',') : []).map((e) => {
          const [id, date, amount] = e.split(':');
          return { id: Number(id), checkin_date: date, amount: Number(amount) };
        }),
        week_count: done.filter((d) => schedule.weekIndex(schedule.dayNumber(d)) === thisWeek).length,
      };
    }),
  });
});

function groupDates(rows) {
  const map = new Map();
  for (const { habit_id, checkin_date } of rows) {
    if (!map.has(habit_id)) map.set(habit_id, []);
    map.get(habit_id).push(checkin_date);
  }
  return map;
}

router.post('/', validate({ body: schemas.habitCreate }), async (req, res) => {
  const { title, description, category, is_public, reminder_time, target_count, unit } = req.valid.body;
  const { frequency, days_mask, weekly_target } = schedule.toColumns(req.valid.body.schedule);
  // Owner is always the authenticated user, never a value from the request.
  // New habits go to the top of the owner's list.
  const { lastInsertRowid } = await db.run(
    `INSERT INTO habits (user_id, title, description, category, is_public, frequency, days_mask, weekly_target,
                         reminder_time, target_count, unit, position)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
             (SELECT COALESCE(MIN(position), 1) - 1 FROM habits WHERE user_id = ?1))`,
    [req.user.id, title, description, category, is_public ? 1 : 0, frequency, days_mask, weekly_target,
      reminder_time, target_count, unit],
  );
  const row = await db.get(
    'SELECT h.*, u.username AS owner_username FROM habits h JOIN users u ON u.id = h.user_id WHERE h.id = ?',
    [lastInsertRowid],
  );
  res.status(201).json({ habit: serializeHabit(row, req.user) });
});

// Reorder: the body must list exactly the caller's active habits. Every
// UPDATE is also scoped to user_id, so foreign ids can never be touched.
router.put('/order', validate({ body: schemas.habitOrder }), async (req, res) => {
  const { ids } = req.valid.body;
  const own = await db.all('SELECT id FROM habits WHERE user_id = ? AND archived_at IS NULL', [req.user.id]);
  const ownIds = new Set(own.map((r) => r.id));
  if (ids.length !== ownIds.size || !ids.every((id) => ownIds.has(id))) {
    throw badRequest('Send the complete list of your active habits');
  }
  await db.batch(ids.map((id, i) => ['UPDATE habits SET position = ? WHERE id = ? AND user_id = ?', [i, id, req.user.id]]));
  res.status(204).end();
});

router.get('/:id', authorize('habit', 'read'), async (req, res) => {
  const owner = await db.get('SELECT username FROM users WHERE id = ?', [req.resource.user_id]);
  res.json({ habit: serializeHabit({ ...req.resource, owner_username: owner.username }, req.user) });
});

router.patch('/:id', authorize('habit', 'update'), validate({ body: schemas.habitUpdate }), async (req, res) => {
  const { schedule: newSchedule, archived, ...updates } = req.valid.body;
  if ('is_public' in updates) updates.is_public = updates.is_public ? 1 : 0;
  if (archived !== undefined) {
    // Keep the original archive date when archiving twice.
    updates.archived_at = archived ? req.resource.archived_at ?? new Date().toISOString().slice(0, 10) : null;
  }
  if (newSchedule) Object.assign(updates, schedule.toColumns(newSchedule));

  // Column names come from the strict schema's fixed key set (and toColumns),
  // never from raw input.
  const columns = Object.keys(updates);
  const statements = [
    [
      `UPDATE habits SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      [...columns.map((c) => updates[c]), req.resource.id],
    ],
  ];
  // Raising a target must not turn days that were complete into partial ones.
  const oldTarget = req.resource.target_count;
  if (updates.target_count && updates.target_count !== oldTarget) {
    statements.push([
      'UPDATE checkins SET amount = MAX(amount, ?) WHERE habit_id = ? AND amount >= ?',
      [updates.target_count, req.resource.id, oldTarget],
    ]);
  }
  await db.batch(statements);
  const row = await db.get(
    'SELECT h.*, u.username AS owner_username FROM habits h JOIN users u ON u.id = h.user_id WHERE h.id = ?',
    [req.resource.id],
  );
  res.json({ habit: serializeHabit(row, req.user) });
});

router.delete('/:id', authorize('habit', 'delete'), async (req, res) => {
  const { id, user_id, title } = req.resource;
  // Explicit, atomic cascade (does not depend on the foreign_keys pragma).
  await db.batch([
    ...moderationAudit(req.user, user_id, 'habit.delete', 'habit', id, { owner_id: user_id, title }),
    ['DELETE FROM comments WHERE habit_id = ?', [id]],
    ['DELETE FROM streak_freezes WHERE habit_id = ?', [id]],
    ['DELETE FROM reactions WHERE habit_id = ?', [id]],
    ['DELETE FROM challenge_members WHERE habit_id = ?', [id]],
    ['DELETE FROM checkins WHERE habit_id = ?', [id]],
    ['DELETE FROM habits WHERE id = ?', [id]],
  ]);
  res.status(204).end();
});

module.exports = router;
