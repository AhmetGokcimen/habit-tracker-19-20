'use strict';

// Brute-force and enumeration defences on the login and register endpoints,
// which attackers probe directly over HTTP.

const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, db, createUser, wrap, PASSWORD } = require('./helpers');
const { rateLimit, limiters } = require('../src/middleware/rateLimit');
const { clientIp } = require('../src/utils/clientIp');

const app = createApp();
const login = (username, password, headers = {}) => {
  const req = wrap(request(app)).post('/api/auth/login');
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send({ username, password });
};

// Calls a limiter middleware directly with a fake request/response.
async function hitLimiter(limiter, { ip = '203.0.113.1', username } = {}) {
  const req = { headers: {}, socket: { remoteAddress: ip }, body: username ? { username } : {} };
  const res = {
    statusCode: 200,
    set() {},
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
    on() {},
  };
  let passed = false;
  await limiter(req, res, () => { passed = true; });
  return passed ? 'pass' : res.statusCode;
}

beforeEach(() => db.run('DELETE FROM rate_limit_windows'));

describe('spoofed forwarding headers cannot rotate the client IP', () => {
  test('failed logins are limited per IP even when X-Forwarded-For / X-Real-IP change on every request', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const fake = `198.51.100.${i + 1}`;
      const res = await login(`nobody${i}`, 'wrong-pass-1', {
        'X-Forwarded-For': fake,
        'X-Real-IP': fake,
        'X-Vercel-Forwarded-For': fake,
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.deepEqual(statuses.slice(10), [429, 429]);
  });

  test('client IP: platform header on Vercel, TCP peer elsewhere, IPv6 grouped by /64', () => {
    const req = (headers, remoteAddress = '10.0.0.9') => ({ headers, socket: { remoteAddress } });
    const spoofed = { 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' };

    // Not on Vercel: every forwarding header is ignored.
    assert.equal(clientIp(req({ ...spoofed, 'x-vercel-forwarded-for': '3.3.3.3' }), { onVercel: false }), '10.0.0.9');
    // On Vercel: only the platform-set header is used (Vercel overwrites client values).
    assert.equal(clientIp(req({ ...spoofed, 'x-vercel-forwarded-for': '203.0.113.7, 9.9.9.9' }), { onVercel: true }), '203.0.113.7');
    // IPv4-mapped IPv6 and IPv6 /64 grouping.
    assert.equal(clientIp(req({}, '::ffff:192.0.2.5'), { onVercel: false }), '192.0.2.5');
    assert.equal(clientIp(req({}, '2001:db8:aa:1:1111::1'), { onVercel: false }), '2001:db8:aa:1::/64');
    assert.equal(clientIp(req({}, '2001:db8:aa:1:ffff:ffff:ffff:2'), { onVercel: false }), '2001:db8:aa:1::/64');
  });
});

describe('per-account limits', () => {
  test('5 failed logins on one account from one IP lock that account for that IP — even the right password', async () => {
    await createUser('target');
    await createUser('neighbour');
    for (let i = 0; i < 5; i++) assert.equal((await login('target', `guess-${i}x`)).status, 401);
    assert.equal((await login('target', 'guess-6x')).status, 429);
    assert.equal((await login('target', PASSWORD)).status, 429);
    // Other accounts from the same IP are unaffected.
    assert.equal((await login('neighbour', PASSWORD)).status, 200);
  });

  test('an account accepts at most 50 failed logins per day from all IPs together', async () => {
    const results = [];
    for (let i = 0; i < 52; i++) {
      results.push(await hitLimiter(limiters.loginAccountDaily, { ip: `192.0.2.${i}`, username: 'Admin ' }));
    }
    assert.deepEqual(results.slice(0, 50), Array(50).fill('pass'));
    assert.deepEqual(results.slice(50), [429, 429]);
    // Case and whitespace variants count against the same account.
    assert.equal(await hitLimiter(limiters.loginAccountDaily, { ip: '192.0.2.200', username: 'ADMIN' }), 429);
  });
});

describe('sliding window', () => {
  test('bursting at a window boundary does not double the budget', async (t) => {
    const windowMs = 60_000;
    const limiter = rateLimit({ name: 'test-sliding', windowMs, limit: 5, key: () => 'k' });
    const base = Math.ceil(Date.now() / windowMs) * windowMs + 10 * windowMs;
    const now = mock.method(Date, 'now', () => base + windowMs - 1000); // last second of a window
    t.after(() => now.mock.restore());

    for (let i = 0; i < 5; i++) assert.equal(await hitLimiter(limiter), 'pass');
    assert.equal(await hitLimiter(limiter), 429);

    // One second later a new fixed window starts; a fixed-window limiter would
    // allow 5 more immediately. The sliding window still counts the burst.
    now.mock.mockImplementation(() => base + windowMs + 1000);
    assert.equal(await hitLimiter(limiter), 429);

    // Once a full window has passed, the budget is back.
    now.mock.mockImplementation(() => base + 3 * windowMs + 1000);
    assert.equal(await hitLimiter(limiter), 'pass');
  });
});

describe('registration does not reveal which emails have accounts', () => {
  test('an email that is already in use registers normally; only a taken username is reported', async () => {
    await createUser('existing_user'); // email existing_user@example.test
    const register = (body) => wrap(request(app)).post('/api/auth/register').send(body);

    const sameEmail = await register({ username: 'fresh_user', email: 'existing_user@example.test', password: 'Secret123x' });
    assert.equal(sameEmail.status, 201);

    const sameName = await register({ username: 'existing_user', email: 'new@example.test', password: 'Secret123x' });
    assert.equal(sameName.status, 409);
    assert.doesNotMatch(sameName.body.error, /email/i);
  });
});
