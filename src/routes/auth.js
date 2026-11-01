'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { limiters, rememberLoginIp } = require('../middleware/rateLimit');
const { SESSION_COOKIE, requireAuth } = require('../middleware/authenticate');
const { hashPassword, verifyPassword, createSession, revokeSession } = require('../services/authService');
const { auditStatement } = require('../services/auditLog');
const { clientIp } = require('../utils/clientIp');
const { unauthorized, conflict } = require('../utils/httpError');

const router = express.Router();

const cookieOptions = {
  httpOnly: true, // not readable from JavaScript -> an XSS cannot steal the session
  sameSite: 'strict', // not sent on cross-site requests -> CSRF
  secure: config.isProduction, // HTTPS-only in production
  path: '/',
};

async function startSession(res, user) {
  const { token, maxAgeMs } = await createSession(user.id);
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: maxAgeMs });
}

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role });

router.post('/register', limiters.register, validate({ body: schemas.register }), async (req, res) => {
  const { username, email, password } = req.valid.body;
  // Only the username is checked: usernames are public anyway, while emails are
  // private and must not be confirmable through this endpoint.
  const taken = await db.get('SELECT 1 FROM users WHERE username = ?', [username]);
  if (taken) throw conflict('That username is taken');

  const hash = await hashPassword(password);
  let lastInsertRowid;
  try {
    // Role is hard-coded: self-registration can never create an admin.
    ({ lastInsertRowid } = await db.run(
      "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'user')",
      [username, email, hash],
    ));
  } catch (err) {
    // Two concurrent registrations for the same name: the UNIQUE constraint decides.
    if (/UNIQUE/.test(err.message)) throw conflict('That username is taken');
    throw err;
  }

  const user = { id: lastInsertRowid, username, role: 'user' };
  await startSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

router.post(
  '/login',
  limiters.loginAll,
  limiters.loginIp,
  limiters.loginAccountIp,
  limiters.loginAccountDaily,
  validate({ body: schemas.login }),
  async (req, res) => {
    const { username, password } = req.valid.body;
    const user = await db.get('SELECT id, username, role, password_hash FROM users WHERE username = ?', [username]);

    // Same message and (via the dummy hash) same timing for "no such user"
    // and "wrong password", so accounts cannot be enumerated.
    const ok = await verifyPassword(password, user?.password_hash);
    if (!user || !ok) throw unauthorized('Invalid username or password');

    // Only a correct password (that passed every limiter) makes a network trusted.
    // This is a convenience: if it fails, the login still succeeds. The log
    // line carries only the error code, never the address or its hash.
    try {
      await rememberLoginIp(user.id, req);
    } catch (err) {
      console.error('Could not record trusted login network:', err.code || err.name);
    }
    await startSession(res, user);
    // Admin sign-ins are audited, so use of an admin account is always traceable.
    if (user.role === 'admin') {
      const [sql, args] = auditStatement(user, 'admin.login', 'user', user.id, { ip: clientIp(req) });
      await db.run(sql, args);
    }
    res.json({ user: publicUser(user) });
  },
);

router.post('/logout', requireAuth, async (req, res) => {
  await revokeSession(req.sessionJti);
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
