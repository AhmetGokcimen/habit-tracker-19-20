'use strict';

// Test bootstrap: must be required before any src/ module so config picks up
// the test environment. node --test runs each file in its own process, and each
// process gets its own throw-away SQLite file (same driver and SQL as production).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');

const dbDir = path.join(os.tmpdir(), 'habit-tracker-tests');
fs.mkdirSync(dbDir, { recursive: true });
// Remove leftovers of earlier runs (files Windows kept locked at exit).
for (const name of fs.readdirSync(dbDir)) {
  const file = path.join(dbDir, name);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > 10 * 60 * 1000) fs.rmSync(file, { force: true });
  } catch {
    // still in use by a concurrently running test file
  }
}
const dbFile = path.join(dbDir, `${process.pid}-${Date.now()}.db`);

process.env.NODE_ENV = 'test';
// Limits read by config (see ./env.js); a file's own overrides, if any, are kept.
require('./env').testEnv();
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.BCRYPT_ROUNDS = '4';
process.env.DATABASE_URL = `file:${dbFile.split(path.sep).join('/')}`;

const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const db = require('../src/db');

// Best-effort cleanup: Windows may keep the file locked briefly after close.
after(() => db.close());
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.rmSync(dbFile + suffix, { force: true });
    } catch {
      // left in the OS temp directory; harmless
    }
  }
});

const PASSWORD = 'Passw0rd-test';

async function createUser(username, role = 'user') {
  const { lastInsertRowid } = await db.run(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
    [username, `${username}@example.test`, bcrypt.hashSync(PASSWORD, 4), role],
  );
  return lastInsertRowid;
}

// Adds the anti-CSRF header to every state-changing call, like the real frontend.
function wrap(agent) {
  const withHeader = (method) => (url) => agent[method](url).set('X-Requested-With', 'fetch');
  return {
    raw: agent,
    get: (url) => agent.get(url),
    post: withHeader('post'),
    put: withHeader('put'),
    patch: withHeader('patch'),
    delete: withHeader('delete'),
  };
}

// Returns an agent that keeps the session cookie of the logged-in user.
async function loginAs(app, username) {
  const agent = wrap(request.agent(app));
  const res = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return agent;
}

module.exports = { request, createApp, db, createUser, loginAs, wrap, PASSWORD };
