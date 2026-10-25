'use strict';

// Database-backed sliding-window rate limiter.
//
// In-memory counters reset on every serverless cold start and are not shared
// between instances, so the counters live in the `rate_limit_windows` table.
//
// Sliding window: each bucket keeps the hit count of the current fixed window
// and of the previous one. The effective count is
//     previous * (share of the previous window still inside the sliding window) + current
// so a client cannot double its budget by bursting at a window boundary.
//
// Each hit is ONE atomic upsert that rolls the window forward if needed,
// increments the counter and returns both counts, so concurrent requests
// cannot race past the limit.

const db = require('../db');
const { clientIp } = require('../utils/clientIp');

// All right-hand sides in an SQLite UPDATE see the row's *old* values.
const HIT_SQL = `
  INSERT INTO rate_limit_windows (bucket, window_start, hits, prev_hits) VALUES (?1, ?2, 1, 0)
  ON CONFLICT (bucket) DO UPDATE SET
    prev_hits = CASE
      WHEN rate_limit_windows.window_start = excluded.window_start THEN rate_limit_windows.prev_hits
      WHEN rate_limit_windows.window_start = excluded.window_start - ?3 THEN rate_limit_windows.hits
      ELSE 0 END,
    hits = CASE WHEN rate_limit_windows.window_start = excluded.window_start THEN rate_limit_windows.hits + 1 ELSE 1 END,
    window_start = excluded.window_start
  RETURNING hits, prev_hits`;

const REFUND_SQL = 'UPDATE rate_limit_windows SET hits = hits - 1 WHERE bucket = ? AND window_start = ? AND hits > 0';

const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

async function pruneOccasionally(now) {
  if (Math.random() < 0.01) {
    await db.run('DELETE FROM rate_limit_windows WHERE window_start < ?', [now - STALE_AFTER_MS]);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.name             bucket prefix, e.g. "login-ip"
 * @param {number} opts.windowMs         window length
 * @param {number} opts.limit            max requests per sliding window
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
    const { hits, prev_hits: prevHits } = await db.get(HIT_SQL, [bucket, windowStart, windowMs]);
    await pruneOccasionally(now);

    const prevWeight = 1 - (now - windowStart) / windowMs;
    const effective = prevHits * prevWeight + hits;

    res.set('RateLimit-Policy', `${limit};w=${Math.round(windowMs / 1000)}`);
    if (effective > limit) {
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

const byIp = (req) => clientIp(req);
const byUser = (req) => (req.user ? `u${req.user.id}` : byIp(req));
const loginName = (req) =>
  typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 30) : null;
const byLoginNameAndIp = (req) => {
  const name = loginName(req);
  return name === null ? null : `${name}|${byIp(req)}`;
};

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const limiters = {
  // Every login attempt, successful or not, per IP: a script with a valid
  // password cannot mint sessions without limit.
  loginAll: rateLimit({ name: 'login-all', windowMs: 15 * MINUTE, limit: 30, key: byIp }),
  // Failed logins per IP, across all accounts (password spraying).
  loginIp: rateLimit({ name: 'login-ip', windowMs: 15 * MINUTE, limit: 10, key: byIp, skipSuccessfulRequests: true }),
  // Failed logins per account from one IP (focused guessing).
  loginAccountIp: rateLimit({ name: 'login-acct-ip', windowMs: 15 * MINUTE, limit: 5, key: byLoginNameAndIp, skipSuccessfulRequests: true }),
  // Failed logins per account from all IPs together (distributed guessing).
  loginAccountDaily: rateLimit({ name: 'login-acct-day', windowMs: DAY, limit: 50, key: loginName, skipSuccessfulRequests: true }),
  register: rateLimit({ name: 'register', windowMs: 60 * MINUTE, limit: 20, key: byIp }),
  // A stolen session must not become a way to brute-force the current password.
  passwordChange: rateLimit({ name: 'pw-change', windowMs: 15 * MINUTE, limit: 5, key: byUser, skipSuccessfulRequests: true }),
  // Data export reads everything a user has: keep it cheap to serve.
  exportData: rateLimit({ name: 'export', windowMs: 60 * MINUTE, limit: 10, key: byUser }),
  // Spam / abuse: all state-changing API calls per user (or per IP if anonymous).
  writes: rateLimit({ name: 'writes', windowMs: 10 * MINUTE, limit: 200, key: byUser }),
};

module.exports = { rateLimit, limiters };
