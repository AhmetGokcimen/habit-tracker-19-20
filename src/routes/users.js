'use strict';

// The signed-in user's own account ("/me" only — there is no :id here, so
// these routes cannot be pointed at another user).

const express = require('express');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/authenticate');
const { limiters } = require('../middleware/rateLimit');
const { hashPassword, verifyPassword } = require('../services/authService');
const { badRequest } = require('../utils/httpError');

const router = express.Router();
router.use(requireAuth);

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (isoDate) => Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS;

// Longest run of consecutive days, and the run that is still alive
// (its last day is today or yesterday, UTC).
function streaks(sortedDates) {
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const date of sortedDates) {
    const n = dayNumber(date);
    run = prev !== null && n - prev === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = n;
  }
  const today = Math.floor(Date.now() / DAY_MS);
  const current = prev !== null && today - prev <= 1 ? run : 0;
  return { longest, current };
}

router.get('/me', async (req, res) => {
  const id = req.user.id;
  const [account, counts, dates] = await Promise.all([
    db.get('SELECT id, username, email, role, created_at FROM users WHERE id = ?', [id]),
    db.get(
      `SELECT (SELECT COUNT(*) FROM habits WHERE user_id = ?1) AS habits,
              (SELECT COUNT(*) FROM habits WHERE user_id = ?1 AND is_public = 1) AS public_habits,
              (SELECT COUNT(*) FROM checkins WHERE user_id = ?1) AS checkins,
              (SELECT COUNT(*) FROM checkins WHERE user_id = ?1 AND photo_data IS NOT NULL) AS photos,
              (SELECT COUNT(*) FROM comments WHERE user_id = ?1) AS comments`,
      [id],
    ),
    db.all('SELECT habit_id, checkin_date FROM checkins WHERE user_id = ? ORDER BY habit_id, checkin_date', [id]),
  ]);

  const byHabit = new Map();
  for (const { habit_id, checkin_date } of dates) {
    if (!byHabit.has(habit_id)) byHabit.set(habit_id, []);
    byHabit.get(habit_id).push(checkin_date);
  }
  let longestStreak = 0;
  let bestCurrentStreak = 0;
  for (const list of byHabit.values()) {
    const s = streaks(list);
    longestStreak = Math.max(longestStreak, s.longest);
    bestCurrentStreak = Math.max(bestCurrentStreak, s.current);
  }

  res.json({
    user: account,
    stats: { ...counts, longest_streak: longestStreak, best_current_streak: bestCurrentStreak },
  });
});

router.post(
  '/me/password',
  limiters.passwordChange,
  validate({ body: schemas.passwordChange }),
  async (req, res) => {
    const { current_password, new_password } = req.valid.body;
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);

    if (!(await verifyPassword(current_password, row?.password_hash))) {
      throw badRequest('Current password is incorrect', [
        { field: 'current_password', message: 'Current password is incorrect' },
      ]);
    }

    const hash = await hashPassword(new_password);
    // Change the password and sign out every OTHER session in one atomic step;
    // the session used for the change stays valid.
    await db.batch([
      ['UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]],
      ['UPDATE sessions SET revoked = 1 WHERE user_id = ? AND jti <> ?', [req.user.id, req.sessionJti]],
    ]);
    res.status(204).end();
  },
);

module.exports = router;
