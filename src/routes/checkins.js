'use strict';

// Check-ins: private per-user data (F5) with an optional proof photo (F8).
//
// Visibility: owner and admins only — even when the habit itself is public.
// Writes:     only the owner (admins may delete for moderation).
// One check-in per habit per day, enforced by UNIQUE(habit_id, checkin_date).

const express = require('express');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { photoUpload, EXTENSIONS } = require('../middleware/upload');
const { moderationAudit } = require('../services/auditLog');
const schedule = require('../services/schedule');
const { conflict, notFound } = require('../utils/httpError');

const SELECT_CHECKIN = `SELECT id, habit_id, user_id, checkin_date, note, created_at,
                               photo_data IS NOT NULL AS has_photo
                          FROM checkins`;

function serializeCheckin(row) {
  return {
    id: row.id,
    habit_id: row.habit_id,
    checkin_date: row.checkin_date,
    note: row.note,
    has_photo: row.has_photo === 1,
    photo_url: row.has_photo === 1 ? `/api/checkins/${row.id}/photo` : null,
    created_at: row.created_at,
  };
}

const findCheckin = (id) => db.get(`${SELECT_CHECKIN} WHERE id = ?`, [id]);

// UNIQUE(habit_id, checkin_date) violation -> 409 instead of 500.
async function uniqueDay(promise) {
  try {
    return await promise;
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw conflict('There is already a check-in for this habit on that day');
    throw err;
  }
}

// ---- /api/habits/:id/checkins -------------------------------------------

const habitCheckins = express.Router({ mergeParams: true });
habitCheckins.use(requireAuth);

// The streak is derived from private check-ins, so it is only returned here
// (owner and admins), never on the public habit record.
habitCheckins.get('/', authorize('habit', 'listCheckins'), async (req, res) => {
  const [rows, dates] = await Promise.all([
    db.all(`${SELECT_CHECKIN} WHERE habit_id = ? ORDER BY checkin_date DESC LIMIT 400`, [req.resource.id]),
    db.all('SELECT checkin_date FROM checkins WHERE habit_id = ?', [req.resource.id]),
  ]);
  res.json({
    checkins: rows.map(serializeCheckin),
    streak: schedule.streaks(req.resource, dates.map((d) => d.checkin_date)),
  });
});

// Accepts JSON, or multipart/form-data when a photo is attached.
// authorize() runs BEFORE the body is parsed: non-owners are refused without
// their upload ever being read.
habitCheckins.post(
  '/',
  authorize('habit', 'addCheckin'),
  photoUpload,
  validate({ body: schemas.checkinCreate }),
  async (req, res) => {
    const { checkin_date, note } = req.valid.body;
    const { lastInsertRowid } = await uniqueDay(
      db.run(
        `INSERT INTO checkins (habit_id, user_id, checkin_date, note, photo_data, photo_mime)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.resource.id, req.user.id, checkin_date, note, req.photo?.data ?? null, req.photo?.mime ?? null],
      ),
    );
    res.status(201).json({ checkin: serializeCheckin(await findCheckin(lastInsertRowid)) });
  },
);

// ---- /api/checkins/:id ---------------------------------------------------

const checkins = express.Router();
checkins.use(requireAuth);

checkins.get('/:id', authorize('checkin', 'read'), async (req, res) => {
  res.json({ checkin: serializeCheckin(await findCheckin(req.resource.id)) });
});

checkins.patch('/:id', authorize('checkin', 'update'), validate({ body: schemas.checkinUpdate }), async (req, res) => {
  const updates = req.valid.body;
  // Column names come from the strict schema's fixed key set, never from raw input.
  const columns = Object.keys(updates);
  await uniqueDay(
    db.run(`UPDATE checkins SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
      ...columns.map((c) => updates[c]),
      req.resource.id,
    ]),
  );
  res.json({ checkin: serializeCheckin(await findCheckin(req.resource.id)) });
});

checkins.delete('/:id', authorize('checkin', 'delete'), async (req, res) => {
  const c = req.resource;
  await db.batch([
    ...moderationAudit(req.user, c.user_id, 'checkin.delete', 'checkin', c.id, { owner_id: c.user_id, habit_id: c.habit_id }),
    ['DELETE FROM checkins WHERE id = ?', [c.id]],
  ]);
  res.status(204).end();
});

// Replace or add the proof photo.
checkins.put('/:id/photo', authorize('checkin', 'update'), photoUpload, async (req, res) => {
  if (!req.photo) return res.status(400).json({ error: 'A photo file is required (field "photo")' });
  await db.run('UPDATE checkins SET photo_data = ?, photo_mime = ? WHERE id = ?', [
    req.photo.data,
    req.photo.mime,
    req.resource.id,
  ]);
  res.json({ checkin: serializeCheckin(await findCheckin(req.resource.id)) });
});

checkins.delete('/:id/photo', authorize('checkin', 'update'), async (req, res) => {
  await db.run('UPDATE checkins SET photo_data = NULL, photo_mime = NULL WHERE id = ?', [req.resource.id]);
  res.status(204).end();
});

// Serves the photo only after the same ownership check as the check-in itself.
// Headers make sure the browser can only ever treat the bytes as an image:
// a fixed whitelisted Content-Type, nosniff, inline disposition with a
// server-generated filename, and a sandboxing CSP in case it is opened directly.
checkins.get('/:id/photo', authorize('checkin', 'read'), async (req, res) => {
  const row = await db.get('SELECT photo_data, photo_mime FROM checkins WHERE id = ?', [req.resource.id]);
  if (!row?.photo_data || !EXTENSIONS[row.photo_mime]) throw notFound('This check-in has no photo');

  res.set({
    'Content-Type': row.photo_mime,
    'Content-Disposition': `inline; filename="checkin-${req.resource.id}.${EXTENSIONS[row.photo_mime]}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, no-store',
  });
  res.send(Buffer.from(row.photo_data));
});

module.exports = { habitCheckins, checkins };
