'use strict';

const path = require('node:path');

require('dotenv').config({ quiet: true });

const ROOT = path.resolve(__dirname, '..');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

// Local development uses a SQLite file (file:...), production uses Turso
// (libsql://...). Same driver, same SQL dialect — only this URL changes.
// The Turso integration on Vercel provisions TURSO_DATABASE_URL / TURSO_AUTH_TOKEN;
// those names are accepted as fallbacks.
function databaseConfig() {
  const url = process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL || 'file:./data/habit-tracker.db';
  if (url.startsWith('file:')) {
    const filePath = path.resolve(ROOT, url.slice('file:'.length));
    return { url: `file:${filePath.split(path.sep).join('/')}`, filePath, authToken: undefined };
  }
  if (!/^(libsql|https):\/\//.test(url)) {
    throw new Error('DATABASE_URL must start with file:, libsql:// or https://');
  }
  const authToken = process.env.DATABASE_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN;
  if (!authToken) throw new Error('DATABASE_AUTH_TOKEN (or TURSO_AUTH_TOKEN) is required for a remote database');
  return { url, filePath: null, authToken };
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32 || jwtSecret.startsWith('change-me')) {
  throw new Error('JWT_SECRET must be a random string of at least 32 characters');
}

const isProduction = process.env.NODE_ENV === 'production';

module.exports = Object.freeze({
  isProduction,
  isTest: process.env.NODE_ENV === 'test',
  // On Vercel the client IP comes from platform-set headers (see utils/clientIp.js).
  onVercel: process.env.VERCEL === '1',
  port: intFromEnv('PORT', 3000, 1, 65535),
  jwtSecret,
  sessionTtlMinutes: intFromEnv('SESSION_TTL_MINUTES', 120, 5, 7 * 24 * 60),
  bcryptRounds: intFromEnv('BCRYPT_ROUNDS', 12, 4, 15),
  database: Object.freeze(databaseConfig()),
  publicDir: path.join(ROOT, 'public'),
  maxUploadBytes: 1024 * 1024,
  // Total proof-photo bytes one user may store (all check-ins together).
  photoQuotaBytes: intFromEnv('PHOTO_QUOTA_MB', 25, 1, 1024) * 1024 * 1024,
  // Total proof-photo bytes of ALL users together; new photos are refused above it.
  photoTotalCapBytes: intFromEnv('PHOTO_TOTAL_CAP_MB', 1024, 1, 1024 * 1024) * 1024 * 1024,
});
