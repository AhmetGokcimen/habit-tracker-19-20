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

const crypto = require('node:crypto');
const config = require('../config');
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
    // Best effort: failing to prune must not fail the request being limited.
    await pruneTrustedIps(now).catch((err) => {
      console.error('Could not prune trusted login networks:', err.code || err.name);
    });
  }
}

/**
 * @param {object} opts
 * @param {string} opts.name             bucket prefix, e.g. "login-ip"
 * @param {number} opts.windowMs         window length
 * @param {number} opts.limit            max requests per sliding window
 * @param {(req) => string|null} opts.key  per-client key; null skips limiting
 * @param {boolean} [opts.skipSuccessfulRequests]  refund the hit if the response is < 400
 * @param {(req) => Promise<boolean>} [opts.allowWhenLimited]  over the limit, still let this request through
 * @param {boolean} [opts.refundRefused]  a refused (429) request does not count
 */
function rateLimit({ name, windowMs, limit, key, skipSuccessfulRequests = false, allowWhenLimited, refundRefused = false }) {
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
    if (effective > limit && !(allowWhenLimited && (await allowWhenLimited(req)))) {
      // Opt-in: a refused request does not count, so repeating requests against
      // a full bucket cannot keep it full; it drains as the window slides.
      if (refundRefused) await db.run(REFUND_SQL, [bucket, windowStart]);
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
const LIST_READS_LIMIT = 300;

// ---- trusted login networks ---------------------------------------------------

const TRUSTED_IP_MAX_AGE_MS = 30 * DAY;
const MAX_TRUSTED_IPS_PER_USER = 10;

// A key used only for this purpose, derived from JWT_SECRET (HKDF), so the
// stored hashes cannot be matched against anything else. Rotating JWT_SECRET
// simply drops every exemption, which fails safe.
const TRUSTED_IP_KEY = Buffer.from(
  crypto.hkdfSync('sha256', config.jwtSecret, '', 'habit-tracker/login-trusted-ip/v1', 32),
);
// HMAC of the same bucket the limiters use (IPv4 address or IPv6 /64).
const ipHash = (req) => crypto.createHmac('sha256', TRUSTED_IP_KEY).update(byIp(req)).digest('hex');

// True if this network signed in to the named account successfully in the
// last 30 days. Any error means "not trusted": the request stays limited.
async function isTrustedLoginIp(req) {
  const name = loginName(req);
  if (name === null) return false;
  try {
    const row = await db.get(
      `SELECT 1 FROM login_trusted_ips t JOIN users u ON u.id = t.user_id
        WHERE u.username = ? AND t.ip_hash = ? AND t.last_used > ?`,
      [name, ipHash(req), Date.now() - TRUSTED_IP_MAX_AGE_MS],
    );
    return Boolean(row);
  } catch (err) {
    console.error('Could not check trusted login network:', err.code || err.name);
    return false;
  }
}

// Called only after a correct password. One atomic batch: drop this user's
// expired entries, add or refresh this network, keep only the 10 most recent.
function rememberLoginIp(userId, req) {
  const now = Date.now();
  return db.batch([
    ['DELETE FROM login_trusted_ips WHERE user_id = ? AND last_used <= ?', [userId, now - TRUSTED_IP_MAX_AGE_MS]],
    [
      `INSERT INTO login_trusted_ips (user_id, ip_hash, last_used) VALUES (?, ?, ?)
       ON CONFLICT (user_id, ip_hash) DO UPDATE SET last_used = excluded.last_used`,
      [userId, ipHash(req), now],
    ],
    [
      `DELETE FROM login_trusted_ips WHERE user_id = ?1 AND rowid NOT IN
         (SELECT rowid FROM login_trusted_ips WHERE user_id = ?1 ORDER BY last_used DESC, rowid DESC LIMIT ?2)`,
      [userId, MAX_TRUSTED_IPS_PER_USER],
    ],
  ]);
}

function pruneTrustedIps(now = Date.now()) {
  return db.run('DELETE FROM login_trusted_ips WHERE last_used <= ?', [now - TRUSTED_IP_MAX_AGE_MS]);
}

const limiters = {
  // Every login attempt, successful or not, per IP: a script with a valid
  // password cannot mint sessions without limit.
  loginAll: rateLimit({ name: 'login-all', windowMs: 15 * MINUTE, limit: 30, key: byIp }),
  // Failed logins per IP, across all accounts (password spraying).
  loginIp: rateLimit({ name: 'login-ip', windowMs: 15 * MINUTE, limit: 10, key: byIp, skipSuccessfulRequests: true }),
  // Failed logins per account from one IP (focused guessing).
  loginAccountIp: rateLimit({ name: 'login-acct-ip', windowMs: 15 * MINUTE, limit: 5, key: byLoginNameAndIp, skipSuccessfulRequests: true }),
  // Failed logins per account from all IPs together (distributed guessing).
  // Networks the owner signed in from before are exempt, so this cap cannot be
  // used to lock the owner out; the per-account-per-IP cap above still applies.
  loginAccountDaily: rateLimit({
    name: 'login-acct-day', windowMs: DAY, limit: 50, key: loginName,
    skipSuccessfulRequests: true, allowWhenLimited: isTrustedLoginIp, refundRefused: true,
  }),
  register: rateLimit({ name: 'register', windowMs: 60 * MINUTE, limit: 20, key: byIp }),
  // A stolen session must not become a way to brute-force the current password.
  passwordChange: rateLimit({ name: 'pw-change', windowMs: 15 * MINUTE, limit: 5, key: byUser, skipSuccessfulRequests: true }),
  // Reads that compute over a whole history (stats, year calendars) or that
  // could be used to walk user ids (public profiles): generous for people,
  // a brake for scripts.
  heavyReads: rateLimit({ name: 'heavy-reads', windowMs: 10 * MINUTE, limit: 300, key: byUser }),
  profileReads: rateLimit({ name: 'profile-reads', windowMs: 10 * MINUTE, limit: 120, key: byUser }),
  // List endpoints (public search, own habits, challenge leaderboards), one
  // shared budget per user (per IP when signed out).
  listReads: rateLimit({ name: 'list-reads', windowMs: 10 * MINUTE, limit: LIST_READS_LIMIT, key: byUser }),
  // Data export reads everything a user has: keep it cheap to serve.
  exportData: rateLimit({ name: 'export', windowMs: 60 * MINUTE, limit: 10, key: byUser }),
  // Proof-photo uploads (multipart requests) per user, on top of `writes`.
  photoUploads: rateLimit({ name: 'photo-uploads', windowMs: 60 * MINUTE, limit: 20, key: byUser }),
  // Spam / abuse: all state-changing API calls per user (or per IP if anonymous).
  writes: rateLimit({ name: 'writes', windowMs: 10 * MINUTE, limit: 200, key: byUser }),
};

module.exports = {
  rateLimit, limiters, isTrustedLoginIp, rememberLoginIp, pruneTrustedIps,
  TRUSTED_IP_MAX_AGE_MS, MAX_TRUSTED_IPS_PER_USER, LIST_READS_LIMIT,
};
