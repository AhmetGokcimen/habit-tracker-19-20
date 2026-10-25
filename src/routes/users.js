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
const schedule = require('../services/schedule');
const { freezesByHabit } = require('../services/freezes');
const { evaluateBadges } = require('../services/badges');
const progress = require('../services/progress');
const { CATEGORIES } = schemas;

const router = express.Router();
router.use(requireAuth);

router.get('/me', async (req, res) => {
  const id = req.user.id;
  const [account, counts, dates, habits, freezes] = await Promise.all([
    db.get('SELECT id, username, email, role, created_at FROM users WHERE id = ?', [id]),
    db.get(
      `SELECT (SELECT COUNT(*) FROM habits WHERE user_id = ?1) AS habits,
              (SELECT COUNT(*) FROM habits WHERE user_id = ?1 AND is_public = 1) AS public_habits,
              (SELECT COUNT(*) FROM checkins WHERE user_id = ?1) AS checkins,
              (SELECT COUNT(*) FROM checkins WHERE user_id = ?1 AND photo_data IS NOT NULL) AS photos,
              (SELECT COUNT(*) FROM comments WHERE user_id = ?1) AS comments,
              (SELECT COUNT(*) FROM streak_freezes WHERE user_id = ?1) AS freezes`,
      [id],
    ),
    db.all(
      `SELECT c.habit_id, c.checkin_date FROM checkins c JOIN habits h ON h.id = c.habit_id
        WHERE c.user_id = ? AND c.amount >= h.target_count ORDER BY c.habit_id, c.checkin_date`,
      [id],
    ),
    db.all('SELECT id, frequency, days_mask, weekly_target FROM habits WHERE user_id = ?', [id]),
    freezesByHabit(id),
  ]);

  const byHabit = new Map();
  for (const { habit_id, checkin_date } of dates) {
    if (!byHabit.has(habit_id)) byHabit.set(habit_id, []);
    byHabit.get(habit_id).push(checkin_date);
  }
  // Day streaks only: a weekly habit's streak is counted in weeks.
  let longestStreak = 0;
  let bestCurrentStreak = 0;
  for (const habit of habits) {
    const s = schedule.streaks(habit, byHabit.get(habit.id) ?? [], freezes.get(habit.id) ?? []);
    if (s.unit !== 'days') continue;
    longestStreak = Math.max(longestStreak, s.longest);
    bestCurrentStreak = Math.max(bestCurrentStreak, s.current);
  }

  const stats = { ...counts, longest_streak: longestStreak, best_current_streak: bestCurrentStreak };
  res.json({ user: account, stats, badges: evaluateBadges(stats) });
});

// Personal statistics over the last 30 / 90 / 365 days (own data only).
router.get('/me/stats', validate({ query: schemas.statsQuery }), async (req, res) => {
  const range = Number(req.valid.query.range);
  const to = schedule.todayNumber();
  const from = to - range + 1;
  const data = await progress.load(req.user.id, from, to);
  const daily = progress.days(data, from, to);
  const habits = progress.perHabit(data, from, to);

  const byWeekday = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, due: 0, done: 0 }));
  for (const d of daily) {
    const w = byWeekday[schedule.isoWeekday(schedule.dayNumber(d.date)) - 1];
    w.due += d.due;
    w.done += d.done;
  }
  const byCategory = CATEGORIES.map((category) => ({
    category,
    done: habits.filter((h) => h.category === category).reduce((sum, h) => sum + h.done, 0),
  })).filter((c) => c.done > 0);

  const due = daily.reduce((s, d) => s + d.due, 0);
  const done = daily.reduce((s, d) => s + d.done, 0);
  res.json({
    range,
    from: schedule.isoDate(from),
    to: schedule.isoDate(to),
    totals: { due, done, rate: due === 0 ? null : Math.round((done / due) * 100) },
    daily,
    by_weekday: byWeekday.map((w) => ({ ...w, rate: w.due === 0 ? null : Math.round((w.done / w.due) * 100) })),
    by_category: byCategory,
    habits,
  });
});

// Year calendar of overall daily progress ("don't break the chain").
router.get('/me/chain', validate({ query: schemas.chainQuery }), async (req, res) => {
  const today = schedule.todayNumber();
  const year = req.valid.query.year ?? new Date().getUTCFullYear();
  const from = schedule.dayNumber(`${year}-01-01`);
  // One day of slack for users ahead of UTC.
  const to = Math.min(schedule.dayNumber(`${year}-12-31`), today + 1);
  const days = to < from ? [] : progress.days(await progress.load(req.user.id, from, to), from, to);
  res.json({ year, days });
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
