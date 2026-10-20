'use strict';

const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { SESSION_COOKIE, requireAuth } = require('../middleware/authenticate');
const { hashPassword, verifyPassword, createSession, revokeSession } = require('../services/authService');
const { unauthorized, conflict } = require('../utils/httpError');

const cookieOptions = {
  httpOnly: true, // not readable from JavaScript -> an XSS cannot steal the session
  sameSite: 'strict', // not sent on cross-site requests -> CSRF
  secure: config.isProduction, // HTTPS-only in production
  path: '/',
};

function startSession(res, user) {
  const { token, maxAgeMs } = createSession(user.id);
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: maxAgeMs });
}

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role });

function authRouter(limiters) {
  const router = express.Router();

  router.post('/register', limiters.register, validate({ body: schemas.register }), async (req, res, next) => {
    try {
      const { username, email, password } = req.valid.body;
      const db = getDb();
      const taken = db
        .prepare('SELECT 1 FROM users WHERE username = ? OR email = ?')
        .get(username, email);
      if (taken) throw conflict('Username or email is already registered');

      const hash = await hashPassword(password);
      // Role is hard-coded: self-registration can never create an admin.
      const { lastInsertRowid } = db
        .prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'user')")
        .run(username, email, hash);

      const user = { id: Number(lastInsertRowid), username, role: 'user' };
      startSession(res, user);
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message)) {
        return next(conflict('Username or email is already registered'));
      }
      next(err);
    }
  });

  router.post('/login', limiters.login, validate({ body: schemas.login }), async (req, res, next) => {
    try {
      const { username, password } = req.valid.body;
      const user = getDb()
        .prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?')
        .get(username);

      // Same message and (via the dummy hash) same timing for "no such user"
      // and "wrong password", so accounts cannot be enumerated.
      const ok = await verifyPassword(password, user?.password_hash);
      if (!user || !ok) throw unauthorized('Invalid username or password');

      startSession(res, user);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireAuth, (req, res) => {
    revokeSession(req.sessionJti);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  return router;
}

module.exports = { authRouter };
