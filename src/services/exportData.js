'use strict';

// "Download my data": everything the signed-in user created, as JSON or CSV.
// Every query is scoped to the caller's own user id. Photo bytes are not
// included (only whether a check-in has one).

const db = require('../db');
const schedule = require('./schedule');

async function collect(userId) {
  const [user, habits, checkins, freezes, comments] = await Promise.all([
    db.get('SELECT username, email, role, created_at FROM users WHERE id = ?', [userId]),
    db.all(
      `SELECT id, title, description, category, is_public, frequency, days_mask, weekly_target, target_count, unit,
              reminder_time, archived_at, created_at, updated_at
         FROM habits WHERE user_id = ? ORDER BY id`,
      [userId],
    ),
    db.all(
      `SELECT c.habit_id, h.title AS habit_title, h.category, h.target_count, h.unit,
              c.checkin_date, c.amount, c.note, c.photo_data IS NOT NULL AS has_photo, c.created_at
         FROM checkins c JOIN habits h ON h.id = c.habit_id
        WHERE c.user_id = ? ORDER BY c.checkin_date, h.id`,
      [userId],
    ),
    db.all('SELECT habit_id, freeze_date, created_at FROM streak_freezes WHERE user_id = ? ORDER BY freeze_date', [userId]),
    db.all('SELECT habit_id, body, created_at, updated_at FROM comments WHERE user_id = ? ORDER BY id', [userId]),
  ]);

  return {
    exported_at: new Date().toISOString(),
    account: user,
    habits: habits.map(({ frequency, days_mask, weekly_target, is_public, ...h }) => ({
      ...h,
      is_public: is_public === 1,
      schedule: schedule.fromRow({ frequency, days_mask, weekly_target }),
    })),
    checkins: checkins.map(({ has_photo, ...c }) => ({ ...c, has_photo: has_photo === 1 })),
    streak_freezes: freezes,
    comments,
  };
}

// Spreadsheet apps execute cells that start with = + - @ (and tab / CR,
// which some of them strip first) as formulas: "CSV injection". Such cells
// are prefixed with an apostrophe so they stay plain text.
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function checkinsCsv(data) {
  const header = ['date', 'habit', 'category', 'amount', 'target', 'unit', 'note', 'has_photo'];
  const rows = data.checkins.map((c) => [
    c.checkin_date,
    c.habit_title,
    c.category,
    c.amount,
    c.target_count,
    c.unit,
    c.note,
    c.has_photo ? 'yes' : 'no',
  ]);
  // CRLF line endings and a BOM so spreadsheet apps read UTF-8 correctly.
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { collect, checkinsCsv, csvCell };
