'use strict';

// Seeds the database with the demo data from scripts/seed-data.js.
//
// Behaviour: RESET. Every run drops all tables, recreates the schema and
// inserts the same deterministic data, so repeated runs always give the same
// result. Because this deletes everything, it refuses to touch a remote
// (Turso) database unless --remote is passed explicitly.
//
// Passwords: every run generates a new strong random password per account and
// prints the list ONCE to the terminal. They are never written to a file or
// the repository; only their bcrypt hashes are stored.
//
//   npm run seed                 # local SQLite file from DATABASE_URL
//   npm run seed -- --remote     # remote database (destructive!)

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const config = require('../src/config');
const db = require('../src/db');
const { hashPassword } = require('../src/services/authService');
const schedule = require('../src/services/schedule');
const { SEED_ACCOUNTS, SEED_HABITS, SEED_TARGETS, CHECKIN_NOTES, SEED_COMMENTS } = require('./seed-data');

const DROP_ORDER = ['follows', 'comments', 'streak_freezes', 'checkins', 'habits', 'sessions', 'rate_limits', 'rate_limit_windows', 'admin_audit_log', 'users'];
const PHOTO_EVERY_NTH_HABIT = 4;

// 24 characters from a 58-symbol alphabet without look-alikes (~140 bits).
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
const PASSWORD_LENGTH = 24;

function generatePassword() {
  for (;;) {
    let pw = '';
    for (let i = 0; i < PASSWORD_LENGTH; i++) pw += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) return pw; // same rule as registration
  }
}

// Small deterministic PRNG so every run produces the same dates.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// n distinct days in the last 30, always including a recent run so streaks show.
function checkinDays(n, rand) {
  const days = new Set();
  const streak = Math.min(n, 1 + Math.floor(rand() * 6));
  for (let d = 0; d < streak; d++) days.add(d + (rand() < 0.3 ? 1 : 0));
  while (days.size < n) days.add(Math.floor(rand() * 30));
  return [...days].sort((a, b) => a - b);
}

// A real (tiny) PNG: a two-colour diagonal gradient, generated in memory.
function makePng(width, height, [r1, g1, b1], [r2, g2, b2]) {
  const crc = (buf) => zlib.crc32(buf) >>> 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      row[1 + x * 3] = Math.round(r1 + (r2 - r1) * t);
      row[2 + x * 3] = Math.round(g1 + (g2 - g1) * t);
      row[3 + x * 3] = Math.round(b1 + (b2 - b1) * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  if (!config.database.filePath && !process.argv.includes('--remote')) {
    console.error('Refusing to reset a remote database. Re-run with --remote if you really mean it.');
    process.exit(1);
  }

  // 1. Wipe and recreate the schema. DROP TABLE removes the tables' triggers
  //    too (including the append-only audit-log trigger) and fires no DELETE triggers.
  await db.batch(DROP_ORDER.map((t) => [`DROP TABLE IF EXISTS ${t}`]));
  db.close();
  await db.init();

  // 2. Accounts.
  const userIds = new Map();
  const credentials = [];
  const statements = [];
  for (const [i, account] of SEED_ACCOUNTS.entries()) {
    const id = i + 1;
    const password = generatePassword();
    credentials.push({ role: account.role, username: account.username, password });
    userIds.set(account.username, id);
    statements.push([
      "INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-40 days'))",
      [id, account.username, account.email, await hashPassword(password), account.role],
    ]);
  }

  // 3. Habits with check-ins (a few with proof photos).
  const rand = mulberry32(19_20);
  const habitIds = new Map();
  let checkinCount = 0;
  let photoCount = 0;
  for (const [i, [owner, title, description, category, isPublic, checkins, plan]] of SEED_HABITS.entries()) {
    const habitId = i + 1;
    const userId = userIds.get(owner);
    const { frequency, days_mask, weekly_target } = schedule.toColumns(plan ?? { type: 'daily' });
    const [target, unit] = SEED_TARGETS[title] ?? [1, ''];
    habitIds.set(title, habitId);
    statements.push([
      `INSERT INTO habits (id, user_id, title, description, category, is_public, frequency, days_mask, weekly_target,
                           target_count, unit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-35 days'), datetime('now', '-35 days'))`,
      [habitId, userId, title, description, category, isPublic ? 1 : 0, frequency, days_mask, weekly_target, target, unit],
    ]);
    for (const [k, daysAgo] of checkinDays(checkins, rand).entries()) {
      const note = CHECKIN_NOTES[Math.floor(rand() * CHECKIN_NOTES.length)];
      const photo = k === 0 && i % PHOTO_EVERY_NTH_HABIT === 0
        ? makePng(160, 110, [255, 94, 58], [255, 201, 74])
        : null;
      if (photo) photoCount += 1;
      statements.push([
        'INSERT INTO checkins (habit_id, user_id, checkin_date, note, photo_data, photo_mime, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [habitId, userId, isoDaysAgo(daysAgo), note, photo, photo ? 'image/png' : null, target],
      ]);
      checkinCount += 1;
    }
  }

  // 4. Supportive comments on public habits.
  for (const [title, author, body] of SEED_COMMENTS) {
    statements.push([
      "INSERT INTO comments (habit_id, user_id, body, created_at) VALUES (?, ?, ?, datetime('now', ?))",
      [habitIds.get(title), userIds.get(author), body, `-${1 + Math.floor(rand() * 20)} days`],
    ]);
  }

  await db.batch(statements);
  db.close();

  const admins = SEED_ACCOUNTS.filter((a) => a.role === 'admin').length;
  console.log(
    `Seeded ${SEED_ACCOUNTS.length} accounts (${SEED_ACCOUNTS.length - admins} users, ${admins} admins), ` +
      `${SEED_HABITS.length} habits, ${checkinCount} check-ins (${photoCount} with photos), ${SEED_COMMENTS.length} comments.`,
  );
  console.log('\nAccount passwords (shown once, not stored anywhere — copy them now):');
  for (const c of credentials) console.log(`  ${c.role.padEnd(5)}  ${c.username.padEnd(10)}  ${c.password}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exit(1);
  });
}

module.exports = { generatePassword };
