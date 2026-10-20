'use strict';

// Password hashing and session (JWT) lifecycle.
//
// A session = a signed HS256 JWT in an HttpOnly cookie + a row in `sessions`.
// The JWT alone is never trusted: resolveSession() also requires the jti row to
// exist, be unrevoked and unexpired, and re-reads the user's role from the DB.

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

const JWT_ALGORITHM = 'HS256';
const JWT_ISSUER = 'habit-tracker';

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Hash of a random value, compared against when the username does not exist so
// that "unknown user" and "wrong password" take the same time (no user
// enumeration through response timing). Computed lazily, once per process.
let dummyHash;
function getDummyHash() {
  dummyHash ??= bcrypt.hash(crypto.randomBytes(16).toString('hex'), config.bcryptRounds);
  return dummyHash;
}

function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptRounds);
}

async function verifyPassword(plain, hash) {
  const ok = await bcrypt.compare(plain, hash || (await getDummyHash()));
  return ok && Boolean(hash);
}

async function createSession(userId) {
  const jti = crypto.randomUUID();
  const ttlSeconds = config.sessionTtlMinutes * 60;
  const expiresAt = nowSeconds() + ttlSeconds;

  await db.batch([
    ['DELETE FROM sessions WHERE expires_at < ?', [nowSeconds()]],
    ['INSERT INTO sessions (jti, user_id, expires_at) VALUES (?, ?, ?)', [jti, userId, expiresAt]],
  ]);

  const token = jwt.sign({ sub: String(userId) }, config.jwtSecret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: ttlSeconds,
    issuer: JWT_ISSUER,
    jwtid: jti,
  });
  return { token, maxAgeMs: ttlSeconds * 1000 };
}

// Returns { user, jti } for a valid, live session, or null.
async function resolveSession(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;

  let payload;
  try {
    // algorithms is pinned so "alg: none" / algorithm-confusion tokens are rejected.
    payload = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM], issuer: JWT_ISSUER });
  } catch {
    return null;
  }
  if (typeof payload.jti !== 'string' || typeof payload.sub !== 'string') return null;

  const row = await db.get(
    `SELECT u.id, u.username, u.role, s.jti
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.jti = ? AND s.revoked = 0 AND s.expires_at > ?`,
    [payload.jti, nowSeconds()],
  );

  if (!row || String(row.id) !== payload.sub) return null;
  return { user: { id: row.id, username: row.username, role: row.role }, jti: row.jti };
}

function revokeSession(jti) {
  return db.run('UPDATE sessions SET revoked = 1 WHERE jti = ?', [jti]);
}

function revokeAllSessionsForUser(userId) {
  return db.run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', [userId]);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessionsForUser,
};
