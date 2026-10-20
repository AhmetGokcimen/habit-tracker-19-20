'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { request, createApp, getDb, createUser, loginAs, wrap, PASSWORD } = require('./helpers');

const app = createApp();
const XRW = ['X-Requested-With', 'fetch'];

function sessionCookie(res) {
  return (res.headers['set-cookie'] || []).find((c) => c.startsWith('session='));
}

describe('F1 — register / login / logout', () => {
  before(() => createUser('existing'));

  test('register creates a user with a bcrypt hash and an HttpOnly, SameSite=Strict cookie', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set(...XRW)
      .send({ username: 'alice', email: 'alice@example.test', password: 'Secret123x' });

    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body.user).sort(), ['id', 'role', 'username']);
    assert.equal(res.body.user.role, 'user');

    const cookie = sessionCookie(res);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const row = getDb().prepare('SELECT password_hash FROM users WHERE username = ?').get('alice');
    assert.match(row.password_hash, /^\$2[aby]\$\d\d\$/);
    assert.notEqual(row.password_hash, 'Secret123x');
  });

  test('register rejects an attempt to self-assign the admin role (mass assignment)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set(...XRW)
      .send({ username: 'mallory', email: 'm@example.test', password: 'Secret123x', role: 'admin' });

    assert.equal(res.status, 400);
    assert.equal(getDb().prepare('SELECT 1 FROM users WHERE username = ?').get('mallory'), undefined);
  });

  test('register validates input on the server (weak password, bad email, duplicates)', async () => {
    const weak = await request(app).post('/api/auth/register').set(...XRW)
      .send({ username: 'bob', email: 'bob@example.test', password: 'short' });
    assert.equal(weak.status, 400);

    const badEmail = await request(app).post('/api/auth/register').set(...XRW)
      .send({ username: 'bob', email: 'not-an-email', password: 'Secret123x' });
    assert.equal(badEmail.status, 400);

    const badName = await request(app).post('/api/auth/register').set(...XRW)
      .send({ username: '<script>', email: 'bob@example.test', password: 'Secret123x' });
    assert.equal(badName.status, 400);

    const dup = await request(app).post('/api/auth/register').set(...XRW)
      .send({ username: 'EXISTING', email: 'other@example.test', password: 'Secret123x' });
    assert.equal(dup.status, 409);
  });

  test('login gives the same 401 for unknown user and wrong password (no enumeration)', async () => {
    const wrongPw = await request(app).post('/api/auth/login').set(...XRW)
      .send({ username: 'existing', password: 'wrong-pass1' });
    const noUser = await request(app).post('/api/auth/login').set(...XRW)
      .send({ username: 'nobody', password: 'wrong-pass1' });

    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.deepEqual(wrongPw.body, noUser.body);
  });

  test('session survives across requests and logout revokes the token server-side', async () => {
    const login = await request(app).post('/api/auth/login').set(...XRW)
      .send({ username: 'existing', password: PASSWORD });
    const cookie = sessionCookie(login).split(';')[0];

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'existing');

    const logout = await request(app).post('/api/auth/logout').set(...XRW).set('Cookie', cookie);
    assert.equal(logout.status, 204);

    // Re-using the old (still unexpired) JWT after logout must fail.
    const after = await request(app).get('/api/auth/me').set('Cookie', cookie);
    assert.equal(after.status, 401);
  });
});

describe('session token hardening', () => {
  test('forged, alg=none and wrongly-signed tokens are rejected', async () => {
    const id = createUser('victim', 'admin');
    const none = jwt.sign({ sub: String(id), jti: 'x' }, null, { algorithm: 'none' });
    const wrongKey = jwt.sign({ sub: String(id), jti: 'x', iss: 'habit-tracker' }, 'attacker-key-attacker-key-attacker-key');

    for (const token of [none, wrongKey, 'garbage', '']) {
      const res = await request(app).get('/api/auth/me').set('Cookie', `session=${token}`);
      assert.equal(res.status, 401);
    }
  });

  test('a validly signed token without a live session row is rejected', async () => {
    const id = createUser('ghost');
    const token = jwt.sign({ sub: String(id) }, process.env.JWT_SECRET, {
      algorithm: 'HS256', issuer: 'habit-tracker', jwtid: 'not-in-db', expiresIn: 600,
    });
    const res = await request(app).get('/api/auth/me').set('Cookie', `session=${token}`);
    assert.equal(res.status, 401);
  });
});

describe('CSRF protection', () => {
  test('state-changing requests without X-Requested-With or from a foreign Origin are refused', async () => {
    createUser('csrfuser');
    const user = await loginAs(app, 'csrfuser');

    const noHeader = await user.raw.post('/api/auth/logout');
    assert.equal(noHeader.status, 403);

    const foreign = await user.post('/api/auth/logout').set('Origin', 'https://evil.example');
    assert.equal(foreign.status, 403);

    // Session is still alive: neither attempt logged the user out.
    assert.equal((await user.get('/api/auth/me')).status, 200);
  });
});

describe('brute-force protection', () => {
  test('login is rate limited after repeated failures', async () => {
    const fresh = wrap(request.agent(createApp()));
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await fresh.post('/api/auth/login').send({ username: 'existing', password: `nope-${i}x` });
      statuses.push(res.status);
    }
    assert.equal(statuses[0], 401);
    assert.equal(statuses.at(-1), 429);
  });
});
