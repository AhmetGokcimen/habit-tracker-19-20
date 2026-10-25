'use strict';

// Streak-freeze allowance and lookups (see routes/freezes.js).

const db = require('../db');

const FREEZES_PER_MONTH = 2;

/** Freezes still available in the given "YYYY-MM" month (default: current UTC month). */
async function freezesLeft(userId, month = new Date().toISOString().slice(0, 7)) {
  const row = await db.get(
    'SELECT COUNT(*) AS used FROM streak_freezes WHERE user_id = ? AND substr(freeze_date, 1, 7) = ?',
    [userId, month],
  );
  return Math.max(0, FREEZES_PER_MONTH - row.used);
}

/** Map habit_id -> [freeze dates] for every habit of the user. */
async function freezesByHabit(userId) {
  const rows = await db.all('SELECT habit_id, freeze_date FROM streak_freezes WHERE user_id = ?', [userId]);
  const map = new Map();
  for (const { habit_id, freeze_date } of rows) {
    if (!map.has(habit_id)) map.set(habit_id, []);
    map.get(habit_id).push(freeze_date);
  }
  return map;
}

module.exports = { FREEZES_PER_MONTH, freezesLeft, freezesByHabit };
