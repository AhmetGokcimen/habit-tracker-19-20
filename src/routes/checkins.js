'use strict';

// Check-ins: private per-user data (F5) with an optional proof photo (F8).
//
// Visibility: owner and admins only — even when the habit itself is public.
// Writes:     only the owner (admins may delete for moderation).
// One check-in per habit per day, enforced by UNIQUE(habit_id, checkin_date).

const express = require('express');
const config = require('../config');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { photoUpload, EXTENSIONS, PHOTO_MAX_AGE_DAYS, photoAllowedOn } = require('../middleware/upload');
const { moderationAudit } = require('../services/auditLog');
const schedule = require('../services/schedule');
const { freezesLeft } = require('../services/freezes');
const { HttpError, badRequest, conflict, notFound } = require('../utils/httpError');
const { limiters } = require('../middleware/rateLimit');

const SELECT_CHECKIN = `SELECT id, habit_id, user_id, checkin_date, note, created_at, amount,
                               photo_data IS NOT NULL AS has_photo
                          FROM checkins`;

function serializeCheckin(row) {
  return {
    id: row.id,
    habit_id: row.habit_id,
    checkin_date: row.checkin_date,
    note: row.note,
    amount: row.amount,
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

// ---- proof-photo limits (H-2) ------------------------------------------------

// Uploads are rate limited before their body is read. Every multipart request
// counts (the frontend sends JSON when there is no photo).
const uploadLimit = (req, res, next) => (req.is('multipart/form-data') ? limiters.photoUploads(req, res, next) : next());

const MB = 1024 * 1024;
const photoTooOld = () => badRequest(`Proof photos can be added only for the last ${PHOTO_MAX_AGE_DAYS} days`);
const photoQuotaFull = () =>
  conflict(`Your photo storage is full (${config.photoQuotaBytes / MB} MB). Remove an old proof photo first.`);
// 507 Insufficient Storage: the service-wide cap, not something the user did.
const photoStorageFull = () =>
  new HttpError(507, 'Photo uploads are paused because storage is full. Nothing was saved — you can check in without a photo.');

// Both limits are checked INSIDE the write statement (SQLite runs it as one
// atomic step), so parallel uploads cannot exceed either one together.
// The global total comes from the one-row photo_storage counter (no scan).
const PHOTO_FITS_ON_INSERT = `
  (SELECT COALESCE(SUM(length(photo_data)), 0) FROM checkins WHERE user_id = ?2) + length(?5) <= ?8
  AND (SELECT bytes FROM photo_storage WHERE id = 1) + length(?5) <= ?9`;
// On replace, the check-in's own current photo is not counted.
const PHOTO_FITS_ON_REPLACE = `
  (SELECT COALESCE(SUM(length(photo_data)), 0) FROM checkins WHERE user_id = ?4 AND id <> ?3) + length(?1) <= ?5
  AND (SELECT bytes FROM photo_storage WHERE id = 1) - COALESCE(length(photo_data), 0) + length(?1) <= ?6`;

// After a refused write: which limit was it? (Only used for the message.)
async function photoRefusal(size, replacingCheckinId = null) {
  const [{ bytes } = {}, current] = await Promise.all([
    db.get('SELECT bytes FROM photo_storage WHERE id = 1'),
    replacingCheckinId === null
      ? { n: 0 }
      : db.get('SELECT COALESCE(length(photo_data), 0) AS n FROM checkins WHERE id = ?', [replacingCheckinId]),
  ]);
  return bytes !== undefined && bytes - current.n + size <= config.photoTotalCapBytes ? photoQuotaFull() : photoStorageFull();
}

// The date is checked before an upload body is read.
const recentCheckinOnly = (req, _res, next) => next(photoAllowedOn(req.resource.checkin_date) ? undefined : photoTooOld());

// ---- /api/habits/:id/checkins -------------------------------------------

const habitCheckins = express.Router({ mergeParams: true });
habitCheckins.use(requireAuth);

// The streak is derived from private check-ins, so it is only returned here
// (owner and admins), never on the public habit record.
habitCheckins.get('/', authorize('habit', 'listCheckins'), async (req, res) => {
  const [rows, dates, freezes, left] = await Promise.all([
    db.all(`${SELECT_CHECKIN} WHERE habit_id = ? ORDER BY checkin_date DESC LIMIT 400`, [req.resource.id]),
    db.all('SELECT checkin_date FROM checkins WHERE habit_id = ? AND amount >= ?', [req.resource.id, req.resource.target_count]),
    db.all('SELECT freeze_date FROM streak_freezes WHERE habit_id = ? ORDER BY freeze_date', [req.resource.id]),
    freezesLeft(req.resource.user_id),
  ]);
  const frozen = freezes.map((f) => f.freeze_date);
  res.json({
    checkins: rows.map(serializeCheckin),
    freezes: frozen,
    freezes_left: left,
    streak: schedule.streaks(req.resource, dates.map((d) => d.checkin_date), frozen),
  });
});

// Accepts JSON, or multipart/form-data when a photo is attached.
// authorize() runs BEFORE the body is parsed: non-owners are refused without
// their upload ever being read.
habitCheckins.post(
  '/',
  authorize('habit', 'addCheckin'),
  uploadLimit,
  photoUpload,
  validate({ body: schemas.checkinCreate }),
  async (req, res) => {
    const { checkin_date, note } = req.valid.body;
    if (req.photo && !photoAllowedOn(checkin_date)) throw photoTooOld();
    const amount = req.valid.body.amount ?? req.resource.target_count;
    const photo = req.photo?.data ?? null;
    const { changes, lastInsertRowid } = await uniqueDay(
      db.run(
        `INSERT INTO checkins (habit_id, user_id, checkin_date, note, photo_data, photo_mime, amount)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE ?5 IS NULL OR (${PHOTO_FITS_ON_INSERT})`,
        [req.resource.id, req.user.id, checkin_date, note, photo, req.photo?.mime ?? null, amount,
          config.photoQuotaBytes, config.photoTotalCapBytes],
      ),
    );
    if (changes === 0) throw await photoRefusal(photo.length);
    res.status(201).json({ checkin: serializeCheckin(await findCheckin(lastInsertRowid)) });
  },
);

// Measurable habits: add or remove some amount for a day in ONE atomic step,
// so quick taps or parallel requests never lose an update. Reaching 0 removes
// the day's check-in.
habitCheckins.post(
  '/progress',
  authorize('habit', 'addCheckin'),
  validate({ body: schemas.checkinProgress }),
  async (req, res) => {
    const { checkin_date, delta } = req.valid.body;
    const habitId = req.resource.id;
    if (delta > 0) {
      await db.run(
        `INSERT INTO checkins (habit_id, user_id, checkin_date, amount) VALUES (?1, ?2, ?3, MIN(?4, 100000))
         ON CONFLICT (habit_id, checkin_date) DO UPDATE SET amount = MIN(checkins.amount + ?4, 100000)`,
        [habitId, req.user.id, checkin_date, delta],
      );
    } else {
      await db.batch([
        ['DELETE FROM checkins WHERE habit_id = ? AND checkin_date = ? AND amount + ? < 1', [habitId, checkin_date, delta]],
        ['UPDATE checkins SET amount = amount + ? WHERE habit_id = ? AND checkin_date = ?', [delta, habitId, checkin_date]],
      ]);
    }
    const row = await db.get(`${SELECT_CHECKIN} WHERE habit_id = ? AND checkin_date = ?`, [habitId, checkin_date]);
    res.json({ checkin: row ? serializeCheckin(row) : null, target_count: req.resource.target_count });
  },
);

// One year of this habit for the chain calendar (owner/admin, like the history).
habitCheckins.get('/year', limiters.heavyReads, authorize('habit', 'listCheckins'), validate({ query: schemas.chainQuery }), async (req, res) => {
  const year = req.valid.query.year ?? new Date().getUTCFullYear();
  const range = [req.resource.id, `${year}-01-01`, `${year}-12-31`];
  const [entries, frozen] = await Promise.all([
    db.all('SELECT checkin_date, amount FROM checkins WHERE habit_id = ? AND checkin_date BETWEEN ? AND ? ORDER BY checkin_date', range),
    db.all('SELECT freeze_date FROM streak_freezes WHERE habit_id = ? AND freeze_date BETWEEN ? AND ? ORDER BY freeze_date', range),
  ]);
  const target = req.resource.target_count;
  res.json({
    year,
    done: entries.filter((r) => r.amount >= target).map((r) => r.checkin_date),
    partial: entries.filter((r) => r.amount < target).map((r) => r.checkin_date),
    frozen: frozen.map((r) => r.freeze_date),
  });
});

// ---- /api/checkins/:id ---------------------------------------------------

const checkins = express.Router();
checkins.use(requireAuth);

checkins.get('/:id', authorize('checkin', 'read'), async (req, res) => {
  res.json({ checkin: serializeCheckin(await findCheckin(req.resource.id)) });
});

checkins.patch('/:id', authorize('checkin', 'update'), validate({ body: schemas.checkinUpdate }), async (req, res) => {
  const updates = req.valid.body;
  // A check-in with a photo cannot be moved outside the photo window.
  if (updates.checkin_date && req.resource.photo_mime && !photoAllowedOn(updates.checkin_date)) throw photoTooOld();
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

// Replace or add the proof photo (recent check-ins only, within both limits).
checkins.put('/:id/photo', authorize('checkin', 'update'), recentCheckinOnly, uploadLimit, photoUpload, async (req, res) => {
  if (!req.photo) return res.status(400).json({ error: 'A photo file is required (field "photo")' });
  const { changes } = await db.run(
    `UPDATE checkins SET photo_data = ?1, photo_mime = ?2 WHERE id = ?3 AND ${PHOTO_FITS_ON_REPLACE}`,
    [req.photo.data, req.photo.mime, req.resource.id, req.user.id, config.photoQuotaBytes, config.photoTotalCapBytes],
  );
  if (changes === 0) throw await photoRefusal(req.photo.data.length, req.resource.id);
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
