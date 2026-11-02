'use strict';

// Group challenges with a leaderboard (F13).
//
//   GET    /api/challenges                   current, upcoming and recently ended
//   GET    /api/challenges/:id               details + leaderboard
//   POST   /api/challenges/:id/join          { habit_id, share_progress: true }
//   DELETE /api/challenges/:id/membership    leave
//   (admins create and delete challenges under /api/admin/challenges)
//
// Privacy and abuse rules:
//   - Only admins create challenges: no user-generated challenge spam.
//   - Joining requires explicit consent (share_progress must be literally
//     true). The leaderboard then shows the member's username and the NUMBER
//     of days the linked habit was completed inside the challenge period —
//     never dates, notes or photos. Leaving removes the member at once.
//   - The linked habit must be the member's own active habit (checked here
//     and by a database trigger).

const express = require('express');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { limiters } = require('../middleware/rateLimit');
const { badRequest, conflict } = require('../utils/httpError');

const todayIso = () => new Date().toISOString().slice(0, 10);

const router = express.Router();
router.use(requireAuth);

function serializeChallenge(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    start_date: row.start_date,
    end_date: row.end_date,
    member_count: row.member_count ?? 0,
    ...(row.my_habit_id !== undefined && { joined: row.my_habit_id !== null, my_habit_id: row.my_habit_id }),
  };
}

const SELECT_CHALLENGE = `
  SELECT ch.*,
         (SELECT COUNT(*) FROM challenge_members m WHERE m.challenge_id = ch.id) AS member_count,
         (SELECT m.habit_id FROM challenge_members m WHERE m.challenge_id = ch.id AND m.user_id = ?1) AS my_habit_id
    FROM challenges ch`;

router.get('/', async (req, res) => {
  const rows = await db.all(
    `${SELECT_CHALLENGE}
      WHERE ch.end_date >= date('now', '-30 days')
      ORDER BY ch.start_date DESC, ch.id DESC LIMIT 100`,
    [req.user.id],
  );
  res.json({ challenges: rows.map(serializeChallenge) });
});

router.get('/:id', limiters.listReads, authorize('challenge', 'read'), validate({ query: schemas.leaderboardQuery }), async (req, res) => {
  const { limit } = req.valid.query;
  const ch = await db.get(`${SELECT_CHALLENGE} WHERE ch.id = ?2`, [req.user.id, req.resource.id]);
  // Days completed inside the challenge window (up to today), per member.
  const board = await db.all(
    `SELECT u.username, m.user_id,
            (SELECT COUNT(*) FROM checkins c JOIN habits h ON h.id = c.habit_id
              WHERE c.habit_id = m.habit_id AND c.amount >= h.target_count
                AND c.checkin_date BETWEEN ?2 AND MIN(?3, date('now', '+1 day'))) AS days
       FROM challenge_members m JOIN users u ON u.id = m.user_id
      WHERE m.challenge_id = ?1
      ORDER BY days DESC, m.joined_at ASC`,
    [ch.id, ch.start_date, ch.end_date],
  );
  let rank = 0;
  let prev = null;
  const ranked = board.map((row, i) => {
    if (row.days !== prev) rank = i + 1;
    prev = row.days;
    return { rank, username: row.username, days: row.days, is_me: row.user_id === req.user.id };
  });
  res.json({
    challenge: serializeChallenge(ch),
    leaderboard: ranked.slice(0, limit),
    limit,
    me: ranked.find((r) => r.is_me) ?? null,
  });
});

router.post('/:id/join', authorize('challenge', 'read'), validate({ body: schemas.challengeJoin }), async (req, res) => {
  const ch = req.resource;
  if (ch.end_date < todayIso()) throw badRequest('This challenge has ended');
  const habit = await db.get('SELECT id FROM habits WHERE id = ? AND user_id = ? AND archived_at IS NULL', [
    req.valid.body.habit_id,
    req.user.id,
  ]);
  // Same answer whether the habit is someone else's or does not exist.
  if (!habit) throw badRequest('Pick one of your active habits');
  try {
    await db.run('INSERT INTO challenge_members (challenge_id, user_id, habit_id) VALUES (?, ?, ?)', [ch.id, req.user.id, habit.id]);
  } catch (err) {
    if (/UNIQUE|PRIMARY/.test(err.message)) throw conflict('You already joined this challenge');
    throw err;
  }
  res.status(201).json({ joined: true });
});

router.delete('/:id/membership', authorize('challenge', 'read'), async (req, res) => {
  await db.run('DELETE FROM challenge_members WHERE challenge_id = ? AND user_id = ?', [req.resource.id, req.user.id]);
  res.status(204).end();
});

module.exports = router;
