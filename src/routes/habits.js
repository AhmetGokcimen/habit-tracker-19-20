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
    owner: { id: row.user_id, username: row.owner_username },
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(viewer && viewer.id === row.user_id && { reminder_time: row.reminder_time ?? null }),
    ...(row.comment_count !== undefined && { comment_count: row.comment_count }),
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
            (SELECT COUNT(*) FROM comments c WHERE c.habit_id = h.id) AS comment_count
       FROM habits h JOIN users u ON u.id = h.user_id
      WHERE h.is_public = 1
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
router.get('/mine', async (req, res) => {
  const [rows, dates, freezes, left] = await Promise.all([
    db.all(
      `SELECT h.*, u.username AS owner_username,
              (SELECT COUNT(*) FROM checkins c WHERE c.habit_id = h.id) AS checkin_count,
              (SELECT MAX(checkin_date) FROM checkins c WHERE c.habit_id = h.id) AS last_checkin,
              (SELECT group_concat(checkin_date) FROM checkins c
                WHERE c.habit_id = h.id AND c.checkin_date >= date('now', '-40 days')) AS recent_dates
         FROM habits h JOIN users u ON u.id = h.user_id
        WHERE h.user_id = ?
        ORDER BY h.created_at DESC, h.id DESC`,
      [req.user.id],
    ),
    db.all('SELECT habit_id, checkin_date FROM checkins WHERE user_id = ?', [req.user.id]),
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
  const { title, description, category, is_public, reminder_time } = req.valid.body;
  const { frequency, days_mask, weekly_target } = schedule.toColumns(req.valid.body.schedule);
  // Owner is always the authenticated user, never a value from the request.
  const { lastInsertRowid } = await db.run(
    `INSERT INTO habits (user_id, title, description, category, is_public, frequency, days_mask, weekly_target, reminder_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, title, description, category, is_public ? 1 : 0, frequency, days_mask, weekly_target, reminder_time],
  );
  const row = await db.get(
    'SELECT h.*, u.username AS owner_username FROM habits h JOIN users u ON u.id = h.user_id WHERE h.id = ?',
    [lastInsertRowid],
  );
  res.status(201).json({ habit: serializeHabit(row, req.user) });
});

router.get('/:id', authorize('habit', 'read'), async (req, res) => {
  const owner = await db.get('SELECT username FROM users WHERE id = ?', [req.resource.user_id]);
  res.json({ habit: serializeHabit({ ...req.resource, owner_username: owner.username }, req.user) });
});

router.patch('/:id', authorize('habit', 'update'), validate({ body: schemas.habitUpdate }), async (req, res) => {
  const { schedule: newSchedule, ...updates } = req.valid.body;
  if ('is_public' in updates) updates.is_public = updates.is_public ? 1 : 0;
  if (newSchedule) Object.assign(updates, schedule.toColumns(newSchedule));

  // Column names come from the strict schema's fixed key set (and toColumns),
  // never from raw input.
  const columns = Object.keys(updates);
  await db.run(
    `UPDATE habits SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    [...columns.map((c) => updates[c]), req.resource.id],
  );
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
    ['DELETE FROM checkins WHERE habit_id = ?', [id]],
    ['DELETE FROM habits WHERE id = ?', [id]],
  ]);
  res.status(204).end();
});

module.exports = router;
