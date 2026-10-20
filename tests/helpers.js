'use strict';

// Test bootstrap: must be required before any src/ module so config picks up
// the test environment. Each test file runs in its own process (node --test),
// so each gets a fresh in-memory database.

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.BCRYPT_ROUNDS = '4';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `habit-tracker-test-uploads-${process.pid}`);

const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { getDb } = require('../src/db');

const PASSWORD = 'Passw0rd-test';

function createUser(username, role = 'user') {
  const { lastInsertRowid } = getDb()
    .prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, `${username}@example.test`, bcrypt.hashSync(PASSWORD, 4), role);
  return Number(lastInsertRowid);
}

// Returns a supertest agent that keeps the session cookie and always sends
// the anti-CSRF header, i.e. behaves like the real frontend.
async function loginAs(app, username) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .set('X-Requested-With', 'fetch')
    .send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return wrap(agent);
}

// Adds the X-Requested-With header to every state-changing call.
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

module.exports = { request, createApp, getDb, createUser, loginAs, wrap, PASSWORD };
