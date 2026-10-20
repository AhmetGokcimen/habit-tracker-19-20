'use strict';

// Database-backed fixed-window rate limiter.
//
// In-memory counters reset on every serverless cold start and are not shared
// between instances, so the counters live in the `rate_limits` table instead.
// Each hit is ONE atomic upsert: it either starts a new window (hits = 1) or
// increments the current one, and returns the new count. Concurrent requests
// therefore cannot race past the limit.

const db = require('../db');

const HIT_SQL = `
  INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1)
  ON CONFLICT (bucket) DO UPDATE SET
    hits = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.hits + 1 ELSE 1 END,
    window_start = excluded.window_start
  RETURNING hits`;

const REFUND_SQL = 'UPDATE rate_limits SET hits = hits - 1 WHERE bucket = ? AND window_start = ? AND hits > 0';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

async function hit(bucket, windowStart) {
  const row = await db.get(HIT_SQL, [bucket, windowStart]);
  return row.hits;
}

async function pruneOccasionally(now) {
  if (Math.random() < 0.01) {
    await db.run('DELETE FROM rate_limits WHERE window_start < ?', [now - STALE_AFTER_MS]);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.name             bucket prefix, e.g. "login-ip"
 * @param {number} opts.windowMs         window length
 * @param {number} opts.limit            max hits per window
 * @param {(req) => string|null} opts.key  per-client key; null skips limiting
 * @param {boolean} [opts.skipSuccessfulRequests]  refund the hit if the response is < 400
 */
function rateLimit({ name, windowMs, limit, key, skipSuccessfulRequests = false }) {
  return async (req, res, next) => {
    const clientKey = key(req);
    if (clientKey === null) return next();

    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const bucket = `${name}:${clientKey}`;
    const hits = await hit(bucket, windowStart);
    await pruneOccasionally(now);

    res.set('RateLimit-Policy', `${limit};w=${Math.round(windowMs / 1000)}`);
    if (hits > limit) {
      res.set('Retry-After', String(Math.ceil((windowStart + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts, please try again later' });
    }

    if (skipSuccessfulRequests) {
      res.on('finish', () => {
        if (res.statusCode < 400) db.run(REFUND_SQL, [bucket, windowStart]).catch(() => {});
      });
    }
    next();
  };
}

const byIp = (req) => req.ip || 'unknown';
const byUser = (req) => (req.user ? `u${req.user.id}` : byIp(req));
const byLoginName = (req) =>
  typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 30) : null;

const MINUTE = 60 * 1000;

const limiters = {
  // Brute force: failed logins per IP, and per targeted account (distributed guessing).
  loginIp: rateLimit({ name: 'login-ip', windowMs: 15 * MINUTE, limit: 10, key: byIp, skipSuccessfulRequests: true }),
  loginAccount: rateLimit({ name: 'login-acct', windowMs: 15 * MINUTE, limit: 10, key: byLoginName, skipSuccessfulRequests: true }),
  register: rateLimit({ name: 'register', windowMs: 60 * MINUTE, limit: 20, key: byIp }),
  // A stolen session must not become a way to brute-force the current password.
  passwordChange: rateLimit({ name: 'pw-change', windowMs: 15 * MINUTE, limit: 5, key: byUser, skipSuccessfulRequests: true }),
  // Spam / abuse: all state-changing API calls per user (or per IP if anonymous).
  writes: rateLimit({ name: 'writes', windowMs: 10 * MINUTE, limit: 200, key: byUser }),
};

module.exports = { rateLimit, limiters };
