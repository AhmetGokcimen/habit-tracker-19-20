'use strict';

// Admin-only endpoints (F2). requireRole('admin') guards the whole router;
// the role is read from the database on every request (see authenticate.js),
// never from the token or the request body.
//
// Safety rules:
//   - an admin cannot change their own role or delete their own account;
//   - the last admin can never be demoted or deleted (also a DB trigger);
//   - every role change and user deletion is written to admin_audit_log in the
//     same atomic batch as the change itself.

const express = require('express');
const config = require('../config');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireRole } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { limiters } = require('../middleware/rateLimit');
const { auditStatement, recentEntries } = require('../services/auditLog');
const { forbidden, conflict } = require('../utils/httpError');

const router = express.Router();
router.use(requireRole('admin'));

const LAST_ADMIN = 'cannot remove the last admin';

async function lastAdminGuard(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err.message.includes(LAST_ADMIN)) throw conflict('The last admin cannot be demoted or deleted');
    throw err;
  }
}

router.get('/users', async (_req, res) => {
  const users = await db.all(
    `SELECT u.id, u.username, u.email, u.role, u.created_at,
            (SELECT COUNT(*) FROM habits h WHERE h.user_id = u.id) AS habit_count,
            (SELECT COUNT(*) FROM checkins c WHERE c.user_id = u.id) AS checkin_count,
            (SELECT COUNT(*) FROM comments m WHERE m.user_id = u.id) AS comment_count
       FROM users u ORDER BY u.id LIMIT 1000`,
  );
  res.json({ users });
});

router.patch('/users/:id/role', authorize('user', 'read'), validate({ body: schemas.roleUpdate }), async (req, res) => {
  const target = req.resource;
  const { role } = req.valid.body;

  if (target.id === req.user.id) throw forbidden('You cannot change your own role');
  if (target.role !== role) {
    await lastAdminGuard(
      db.batch([
        ['UPDATE users SET role = ? WHERE id = ?', [role, target.id]],
        // A demoted admin is signed out everywhere (e.g. a compromised account).
        ...(role === 'user' ? [['UPDATE sessions SET revoked = 1 WHERE user_id = ?', [target.id]]] : []),
        auditStatement(req.user, 'user.role_change', 'user', target.id, {
          username: target.username,
          from: target.role,
          to: role,
        }),
      ]),
    );
  }
  res.json({ user: { id: target.id, username: target.username, role } });
});

router.delete('/users/:id', authorize('user', 'read'), async (req, res) => {
  const target = req.resource;
  if (target.id === req.user.id) throw forbidden('You cannot delete your own account');

  const id = target.id;
  await lastAdminGuard(
    db.batch([
      auditStatement(req.user, 'user.delete', 'user', id, {
        username: target.username,
        email: target.email,
        role: target.role,
      }),
      ['DELETE FROM comments WHERE user_id = ? OR habit_id IN (SELECT id FROM habits WHERE user_id = ?)', [id, id]],
      ['DELETE FROM reactions WHERE user_id = ? OR habit_id IN (SELECT id FROM habits WHERE user_id = ?)', [id, id]],
      ['DELETE FROM challenge_members WHERE user_id = ? OR habit_id IN (SELECT id FROM habits WHERE user_id = ?)', [id, id]],
      ['DELETE FROM streak_freezes WHERE user_id = ?', [id]],
      ['DELETE FROM checkins WHERE user_id = ?', [id]],
      ['DELETE FROM habits WHERE user_id = ?', [id]],
      ['DELETE FROM follows WHERE follower_id = ? OR followee_id = ?', [id, id]],
      ['DELETE FROM login_trusted_ips WHERE user_id = ?', [id]],
      // Removing the session rows invalidates the user's tokens immediately.
      ['DELETE FROM sessions WHERE user_id = ?', [id]],
      ['DELETE FROM users WHERE id = ?', [id]],
    ]),
  );
  res.status(204).end();
});

// ---- challenges (F13) ---------------------------------------------------------

router.post('/challenges', validate({ body: schemas.challengeCreate }), async (req, res) => {
  const { title, description, category, start_date, end_date } = req.valid.body;
  // The audit entry is written in the same atomic batch, right after the
  // insert, and records the new challenge's id via last_insert_rowid().
  const [inserted] = await db.batch([
    [
      'INSERT INTO challenges (title, description, category, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [title, description, category, start_date, end_date, req.user.id],
    ],
    [
      `INSERT INTO admin_audit_log (actor_id, actor_username, action, target_type, target_id, details)
       VALUES (?, ?, 'challenge.create', 'challenge', last_insert_rowid(), ?)`,
      [req.user.id, req.user.username, JSON.stringify({ title, start_date, end_date })],
    ],
  ]);
  res.status(201).json({ challenge: { id: Number(inserted.lastInsertRowid), title, description, category, start_date, end_date } });
});

router.delete('/challenges/:id', authorize('challenge', 'delete'), async (req, res) => {
  const ch = req.resource;
  await db.batch([
    auditStatement(req.user, 'challenge.delete', 'challenge', ch.id, { title: ch.title }),
    ['DELETE FROM challenge_members WHERE challenge_id = ?', [ch.id]],
    ['DELETE FROM challenges WHERE id = ?', [ch.id]],
  ]);
  res.status(204).end();
});

router.get('/audit-log', async (_req, res) => {
  res.json({ entries: await recentEntries() });
});

// Simple usage report.
router.get('/stats', async (_req, res) => {
  const totals = await db.get(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins,
            (SELECT COUNT(*) FROM habits) AS habits,
            (SELECT COUNT(*) FROM habits WHERE is_public = 1) AS public_habits,
            (SELECT COUNT(*) FROM checkins) AS checkins,
            (SELECT COUNT(*) FROM comments) AS comments`,
  );
  const byCategory = await db.all('SELECT category, COUNT(*) AS habits FROM habits GROUP BY category ORDER BY habits DESC');
  res.json({ totals, by_category: byCategory });
});

// Proof-photo storage: the service-wide total (the one-row photo_storage
// counter that the upload cap is checked against) and the 10 accounts storing
// the most, so an admin can see when the cap is near and who fills it.
// Admin-only like the rest of this router; it scans every check-in, so it
// also counts against the per-user budget for heavy reads.
const TOP_PHOTO_USERS = 10;
const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

router.get('/photo-storage', limiters.heavyReads, async (_req, res) => {
  const [counter, topUsers] = await Promise.all([
    db.get('SELECT bytes FROM photo_storage WHERE id = 1'),
    db.all(
      `SELECT u.id, u.username, COUNT(*) AS photo_count, SUM(length(c.photo_data)) AS photo_bytes
         FROM checkins c JOIN users u ON u.id = c.user_id
        WHERE c.photo_data IS NOT NULL
        GROUP BY u.id
        ORDER BY photo_bytes DESC, u.id
        LIMIT ?`,
      [TOP_PHOTO_USERS],
    ),
  ]);
  const usedBytes = counter?.bytes ?? 0;
  res.json({
    storage: {
      used_bytes: usedBytes,
      cap_bytes: config.photoTotalCapBytes,
      used_percent: percent(usedBytes, config.photoTotalCapBytes),
      per_user_quota_bytes: config.photoQuotaBytes,
    },
    top_users: topUsers.map((u) => ({
      id: u.id,
      username: u.username,
      photo_count: u.photo_count,
      photo_bytes: u.photo_bytes,
      quota_percent: percent(u.photo_bytes, config.photoQuotaBytes),
    })),
  });
});

module.exports = router;
