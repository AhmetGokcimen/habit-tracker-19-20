'use strict';

// Per-day and per-habit progress of ONE user over a date range, used by the
// statistics page and the "don't break the chain" calendar. Every query is
// scoped to the given user id; callers pass req.user.id, never request input.

const db = require('../db');
const schedule = require('./schedule');

/**
 * @param userId  the signed-in user
 * @param from    first day number (inclusive)
 * @param to      last day number (inclusive)
 * @returns { habits, done: Map<habitId, Set<dayNumber>>, frozen: Map<habitId, Set<dayNumber>> }
 */
async function load(userId, from, to) {
  const [habits, checkins, freezes] = await Promise.all([
    db.all('SELECT * FROM habits WHERE user_id = ? ORDER BY id', [userId]),
    // Only completed days (amount reached the target) count as done.
    db.all(
      `SELECT c.habit_id, c.checkin_date FROM checkins c JOIN habits h ON h.id = c.habit_id
        WHERE c.user_id = ? AND c.amount >= h.target_count AND c.checkin_date BETWEEN ? AND ?`,
      [userId, schedule.isoDate(from), schedule.isoDate(to)],
    ),
    db.all('SELECT habit_id, freeze_date FROM streak_freezes WHERE user_id = ? AND freeze_date BETWEEN ? AND ?', [
      userId,
      schedule.isoDate(from),
      schedule.isoDate(to),
    ]),
  ]);
  const group = (rows, key) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.habit_id)) map.set(row.habit_id, new Set());
      map.get(row.habit_id).add(schedule.dayNumber(row[key]));
    }
    return map;
  };
  return { habits, done: group(checkins, 'checkin_date'), frozen: group(freezes, 'freeze_date') };
}

const createdDay = (habit) => schedule.dayNumber(habit.created_at.slice(0, 10));
const lastDay = (habit) => (habit.archived_at ? schedule.dayNumber(habit.archived_at.slice(0, 10)) : Infinity);

/**
 * One entry per day: how many habits were due and how many of those were done.
 * Weekly habits have no fixed days: they only count on days they were done.
 * Frozen days count as "kept".
 */
function days({ habits, done, frozen }, from, to) {
  const out = [];
  for (let n = from; n <= to; n++) {
    let due = 0;
    let kept = 0;
    let frozenCount = 0;
    for (const h of habits) {
      if (n < createdDay(h) || n > lastDay(h)) continue;
      const isDone = done.get(h.id)?.has(n) ?? false;
      if (h.frequency === 'weekly' ? !isDone : !schedule.isDueOn(h, n) && !isDone) continue;
      due += 1;
      if (isDone) kept += 1;
      else if (frozen.get(h.id)?.has(n)) frozenCount += 1;
    }
    out.push({ date: schedule.isoDate(n), due, done: kept, frozen: frozenCount });
  }
  return out;
}

/** Completion rate per habit over the range: done / expected. */
function perHabit({ habits, done }, from, to) {
  return habits.map((h) => {
    const start = Math.max(from, createdDay(h));
    const end = Math.min(to, lastDay(h));
    const doneDays = [...(done.get(h.id) ?? [])].filter((n) => n >= start && n <= end);
    let expected = 0;
    let counted = 0;
    if (h.frequency === 'weekly') {
      for (let w = schedule.weekIndex(start); w <= schedule.weekIndex(end); w++) {
        const inWeek = doneDays.filter((n) => schedule.weekIndex(n) === w).length;
        expected += h.weekly_target;
        counted += Math.min(inWeek, h.weekly_target);
      }
    } else {
      for (let n = start; n <= end; n++) if (schedule.isDueOn(h, n)) expected += 1;
      counted = Math.min(doneDays.length, expected);
    }
    return {
      id: h.id,
      title: h.title,
      archived: h.archived_at !== null,
      category: h.category,
      done: doneDays.length,
      expected,
      rate: expected === 0 ? null : Math.round((counted / expected) * 100),
    };
  });
}

module.exports = { load, days, perHabit };
