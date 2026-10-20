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
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireRole } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
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
      ['DELETE FROM checkins WHERE user_id = ?', [id]],
      ['DELETE FROM habits WHERE user_id = ?', [id]],
      // Removing the session rows invalidates the user's tokens immediately.
      ['DELETE FROM sessions WHERE user_id = ?', [id]],
      ['DELETE FROM users WHERE id = ?', [id]],
    ]),
  );
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

module.exports = router;
