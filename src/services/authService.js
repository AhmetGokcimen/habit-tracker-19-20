'use strict';

// Password hashing and session (JWT) lifecycle.
//
// A session = a signed HS256 JWT in an HttpOnly cookie + a row in `sessions`.
// The JWT alone is never trusted: authenticate() also requires the jti row to
// exist, be unrevoked and unexpired, and re-reads the user's role from the DB.

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db');

const JWT_ALGORITHM = 'HS256';
const JWT_ISSUER = 'habit-tracker';

// Hash of a random value, compared against when the username does not exist so
// that "unknown user" and "wrong password" take the same time (no user enumeration
// through response timing).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), config.bcryptRounds);

function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptRounds);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash || DUMMY_HASH).then((ok) => ok && Boolean(hash));
}

function createSession(userId) {
  const jti = crypto.randomUUID();
  const ttlSeconds = config.sessionTtlMinutes * 60;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const db = getDb();

  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
  db.prepare('INSERT INTO sessions (jti, user_id, expires_at) VALUES (?, ?, ?)').run(jti, userId, expiresAt);

  const token = jwt.sign({ sub: String(userId) }, config.jwtSecret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: ttlSeconds,
    issuer: JWT_ISSUER,
    jwtid: jti,
  });
  return { token, maxAgeMs: ttlSeconds * 1000 };
}

// Returns { user, jti } for a valid, live session, or null.
function resolveSession(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;

  let payload;
  try {
    // algorithms is pinned so "alg: none" / algorithm-confusion tokens are rejected.
    payload = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM], issuer: JWT_ISSUER });
  } catch {
    return null;
  }
  if (typeof payload.jti !== 'string' || typeof payload.sub !== 'string') return null;

  const row = getDb()
    .prepare(
      `SELECT u.id, u.username, u.role, s.jti
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.jti = ? AND s.revoked = 0 AND s.expires_at > ?`,
    )
    .get(payload.jti, Math.floor(Date.now() / 1000));

  if (!row || String(row.id) !== payload.sub) return null;
  return { user: { id: row.id, username: row.username, role: row.role }, jti: row.jti };
}

function revokeSession(jti) {
  getDb().prepare('UPDATE sessions SET revoked = 1 WHERE jti = ?').run(jti);
}

function revokeAllSessionsForUser(userId) {
  getDb().prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(userId);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessionsForUser,
};
