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

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32 || jwtSecret.startsWith('change-me')) {
  throw new Error('JWT_SECRET must be a random string of at least 32 characters');
}

const isProduction = process.env.NODE_ENV === 'production';

module.exports = Object.freeze({
  isProduction,
  isTest: process.env.NODE_ENV === 'test',
  port: intFromEnv('PORT', 3000, 1, 65535),
  jwtSecret,
  sessionTtlMinutes: intFromEnv('SESSION_TTL_MINUTES', 120, 5, 7 * 24 * 60),
  bcryptRounds: intFromEnv('BCRYPT_ROUNDS', 12, 4, 15),
  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/habit-tracker.db'),
  uploadDir: path.resolve(ROOT, process.env.UPLOAD_DIR || './uploads'),
  publicDir: path.join(ROOT, 'public'),
  maxUploadBytes: 2 * 1024 * 1024,
});
