'use strict';

// A database created by the first release's schema must end up with exactly
// the columns of a fresh database after migrate(), and keep its data.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./helpers');
const { createClient } = require('@libsql/client');
const { migrate } = require('../src/db/migrations');

const dir = path.join(os.tmpdir(), 'habit-tracker-tests');

function tempClient(label) {
  const file = path.join(dir, `${process.pid}-${label}-${Date.now()}.db`);
  return createClient({ url: `file:${file.split(path.sep).join('/')}` });
}

async function columns(client) {
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out = {};
  for (const { name } of tables.rows) {
    const info = await client.execute(`PRAGMA table_info(${name})`);
    out[name] = info.rows.map((r) => r.name).sort();
  }
  return out;
}

test('migrate() upgrades a first-release database to the current schema', async () => {
  const current = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const v1 = fs.readFileSync(path.join(__dirname, 'fixtures/schema-v1.sql'), 'utf8');

  const fresh = tempClient('fresh');
  await fresh.executeMultiple(current);
  await migrate(fresh);

  const old = tempClient('old');
  await old.executeMultiple(v1);
  await old.execute("INSERT INTO users (username, email, password_hash) VALUES ('legacy', 'l@example.test', 'x')");
  await old.execute("INSERT INTO habits (user_id, title, category) VALUES (1, 'Old habit', 'other')");
  await old.executeMultiple(current);
  await migrate(old);
  await migrate(old); // idempotent

  assert.deepEqual(await columns(old), await columns(fresh));
  const habit = (await old.execute('SELECT * FROM habits')).rows[0];
  assert.equal(habit.title, 'Old habit');
  assert.equal(habit.frequency, 'daily');

  fresh.close();
  old.close();
});

test('a database whose accounts already share an email still starts; the email index is skipped', async (t) => {
  const current = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const client = tempClient('dup-email');
  await client.executeMultiple(current);
  await client.execute("INSERT INTO users (username, email, password_hash) VALUES ('a', 'same@example.test', 'x'), ('b', 'SAME@example.test', 'x')");
  const logged = t.mock.method(console, 'error', () => {});

  await migrate(client);

  const idx = await client.execute("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_email'");
  assert.equal(idx.rows.length, 0);
  assert.equal(logged.mock.callCount(), 1);
  client.close();
});
