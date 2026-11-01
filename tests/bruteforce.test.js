'use strict';

// Brute-force and enumeration defences on the login and register endpoints,
// which attackers probe directly over HTTP.

const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, db, createUser, wrap, PASSWORD } = require('./helpers');
const {
  rateLimit, limiters, isTrustedLoginIp, rememberLoginIp, pruneTrustedIps, TRUSTED_IP_MAX_AGE_MS,
} = require('../src/middleware/rateLimit');
const { clientIp } = require('../src/utils/clientIp');
const { resetLoginLocks } = require('../scripts/reset-login-lock');

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

beforeEach(async () => {
  await db.run('DELETE FROM rate_limit_windows');
  await db.run('DELETE FROM login_trusted_ips');
});

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

describe('CF-Connecting-IP is trusted only on requests that really come from Cloudflare', () => {
  const viaVercel = (peer, cf) => ({ headers: { 'x-vercel-forwarded-for': peer, ...(cf ? { 'cf-connecting-ip': cf } : {}) }, socket: { remoteAddress: '10.0.0.1' } });
  const direct = (peer, cf) => ({ headers: cf ? { 'cf-connecting-ip': cf } : {}, socket: { remoteAddress: peer } });

  test('through Cloudflare (edge IP connects to Vercel): the visitor in CF-Connecting-IP is used', () => {
    assert.equal(clientIp(viaVercel('172.64.12.34', '203.0.113.9'), { onVercel: true }), '203.0.113.9');
    assert.equal(clientIp(viaVercel('2606:4700:10::ac43:1', '203.0.113.9'), { onVercel: true }), '203.0.113.9');
    assert.equal(clientIp(viaVercel('104.16.0.1', '2001:db8:1:2:3:4:5:6'), { onVercel: true }), '2001:db8:1:2::/64');
  });

  test('straight to vercel.app with a forged CF-Connecting-IP: the header is ignored', () => {
    assert.equal(clientIp(viaVercel('198.51.100.7', '1.2.3.4'), { onVercel: true }), '198.51.100.7');
    assert.equal(clientIp(viaVercel('8.8.8.8', '104.16.0.1'), { onVercel: true }), '8.8.8.8');
    assert.equal(clientIp(direct('127.0.0.1', '9.9.9.9'), { onVercel: false }), '127.0.0.1');
  });

  test('a Cloudflare peer with a missing or malformed CF-Connecting-IP falls back to the peer', () => {
    assert.equal(clientIp(viaVercel('172.64.12.34'), { onVercel: true }), '172.64.12.34');
    assert.equal(clientIp(viaVercel('172.64.12.34', 'not-an-ip'), { onVercel: true }), '172.64.12.34');
  });

  test('failed logins with a rotating forged CF-Connecting-IP are still limited per real IP', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await login(`cfspoof${i}`, 'wrong-pass-1', { 'CF-Connecting-IP': `198.51.100.${i + 1}` })).status);
    }
    assert.deepEqual(statuses.slice(10), [429, 429]);
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

// ---- H-1: a lockout by strangers must not lock out the owner -------------------

const DAY = 24 * 60 * 60 * 1000;
const trustedRows = (userId) => db.all('SELECT ip_hash, last_used FROM login_trusted_ips WHERE user_id = ?', [userId]);
// Fills the per-account daily budget from 51 addresses the owner never used.
async function exhaustDaily(username) {
  const results = [];
  for (let i = 0; i < 51; i++) results.push(await hitLimiter(limiters.loginAccountDaily, { ip: `192.0.2.${i}`, username }));
  return results;
}
// Collects console.error lines during a test.
function captureErrors(t) {
  const logged = [];
  const spy = mock.method(console, 'error', (...args) => { logged.push(args.map(String).join(' ')); });
  t.after(() => spy.mock.restore());
  return logged;
}
const IDENTIFYING = /127\.0\.0\.1|::ffff|192\.0\.2\.|[0-9a-f]{64}/;

describe('a lockout by strangers does not lock out the owner', () => {
  test('requests refused by the account limiter do not increase its counter', async (t) => {
    const midday = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
    const now = mock.method(Date, 'now', () => midday);
    t.after(() => now.mock.restore());
    for (let i = 0; i < 50; i++) {
      assert.equal(await hitLimiter(limiters.loginAccountDaily, { ip: `192.0.2.${i}`, username: 'countme' }), 'pass');
    }
    for (let i = 0; i < 5; i++) {
      assert.equal(await hitLimiter(limiters.loginAccountDaily, { ip: `198.51.100.${i}`, username: 'countme' }), 429);
    }
    const row = await db.get("SELECT hits FROM rate_limit_windows WHERE bucket = 'login-acct-day:countme'");
    assert.equal(row.hits, 50);
  });

  test('other limiters keep counting refused requests (refund is opt-in)', async (t) => {
    const windowMs = 60_000;
    const base = Math.ceil(Date.now() / windowMs) * windowMs + 10 * windowMs;
    const now = mock.method(Date, 'now', () => base + windowMs / 2);
    t.after(() => now.mock.restore());
    const limiter = rateLimit({ name: 'test-default', windowMs, limit: 2, key: () => 'k' });
    for (let i = 0; i < 2; i++) assert.equal(await hitLimiter(limiter), 'pass');
    for (let i = 0; i < 3; i++) assert.equal(await hitLimiter(limiter), 429);
    const row = await db.get("SELECT hits FROM rate_limit_windows WHERE bucket = 'test-default:k'");
    assert.equal(row.hits, 5);
  });

  test('after 51 failed logins, the right password works from a network that signed in before', async () => {
    await createUser('known_net');
    assert.equal((await login('known_net', PASSWORD)).status, 200);
    const results = await exhaustDaily('known_net');
    assert.equal(results.at(-1), 429);
    assert.equal((await login('known_net', PASSWORD)).status, 200);
  });

  test('from a network that never signed in, the right password is still refused', async () => {
    await createUser('new_net');
    await exhaustDaily('new_net');
    assert.equal((await login('new_net', PASSWORD)).status, 429);
  });

  test('from a trusted network, wrong passwords still hit the per-account-per-IP limit', async () => {
    await createUser('trusted_wrong');
    assert.equal((await login('trusted_wrong', PASSWORD)).status, 200);
    await exhaustDaily('trusted_wrong');
    for (let i = 0; i < 5; i++) assert.equal((await login('trusted_wrong', `guess-${i}x`)).status, 401);
    assert.equal((await login('trusted_wrong', 'guess-6x')).status, 429);
    assert.equal((await login('trusted_wrong', PASSWORD)).status, 429);
  });

  test('a network becomes trusted only after a successful login with the right password, stored as an HMAC', async () => {
    const id = await createUser('only_ok');
    assert.equal((await login('only_ok', 'wrong-pass-1')).status, 401);
    assert.equal((await trustedRows(id)).length, 0);

    // A right password refused by a limiter does not count either.
    const blockedId = await createUser('blocked_ok');
    for (let i = 0; i < 5; i++) await login('blocked_ok', `guess-${i}x`);
    assert.equal((await login('blocked_ok', PASSWORD)).status, 429);
    assert.equal((await trustedRows(blockedId)).length, 0);

    assert.equal((await login('only_ok', PASSWORD)).status, 200);
    const rows = await trustedRows(id);
    assert.equal(rows.length, 1);
    assert.match(rows[0].ip_hash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(rows[0].ip_hash, /127\.0\.0\.1/);
  });

  test('an entry older than 30 days gives no exemption and is pruned', async () => {
    const id = await createUser('stale_net');
    const realNow = Date.now;
    const longAgo = mock.method(Date, 'now', () => realNow() - TRUSTED_IP_MAX_AGE_MS - DAY);
    assert.equal((await login('stale_net', PASSWORD)).status, 200);
    longAgo.mock.restore();
    assert.equal((await trustedRows(id)).length, 1);

    await exhaustDaily('stale_net');
    assert.equal((await login('stale_net', PASSWORD)).status, 429);
    await pruneTrustedIps();
    assert.equal((await trustedRows(id)).length, 0);
  });

  test('a user keeps at most 10 trusted networks; a new one replaces the oldest', async (t) => {
    const id = await createUser('many_nets');
    let clock = Date.now();
    const now = mock.method(Date, 'now', () => clock);
    t.after(() => now.mock.restore());
    const fakeReq = (i) => ({ headers: {}, socket: { remoteAddress: `203.0.113.${i}` }, body: { username: 'many_nets' } });
    for (let i = 1; i <= 12; i++) {
      clock += 1000;
      await rememberLoginIp(id, fakeReq(i));
    }
    assert.equal((await trustedRows(id)).length, 10);
    assert.equal(await isTrustedLoginIp(fakeReq(1)), false);
    assert.equal(await isTrustedLoginIp(fakeReq(2)), false);
    assert.equal(await isTrustedLoginIp(fakeReq(3)), true);
    assert.equal(await isTrustedLoginIp(fakeReq(12)), true);
  });

  test('if recording the trusted network fails, a correct login still succeeds and nothing identifying is logged', async (t) => {
    await createUser('rec_fail');
    await db.run(
      "CREATE TRIGGER test_fail_trusted BEFORE INSERT ON login_trusted_ips BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    );
    t.after(() => db.run('DROP TRIGGER IF EXISTS test_fail_trusted'));
    const logged = captureErrors(t);

    assert.equal((await login('rec_fail', PASSWORD)).status, 200);
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0], IDENTIFYING);
  });

  test('if the trusted-network table fails, the request stays limited (429), pruning cannot fail it, and only error codes are logged', async (t) => {
    await createUser('check_fail');
    assert.equal((await login('check_fail', PASSWORD)).status, 200);
    await exhaustDaily('check_fail');
    await db.run('ALTER TABLE login_trusted_ips RENAME TO login_trusted_ips_hidden');
    t.after(() => db.run('ALTER TABLE login_trusted_ips_hidden RENAME TO login_trusted_ips'));
    // Run the occasional pruning on every limiter call, so its failure path is
    // exercised deterministically instead of 1% of the time.
    const random = mock.method(Math, 'random', () => 0);
    t.after(() => random.mock.restore());
    const logged = captureErrors(t);

    assert.equal((await login('check_fail', PASSWORD)).status, 429);
    assert.ok(logged.some((line) => line.startsWith('Could not check trusted login network:')));
    assert.ok(logged.some((line) => line.startsWith('Could not prune trusted login networks:')));
    for (const line of logged) assert.doesNotMatch(line, IDENTIFYING);
  });

  test('the unlock script clears one account, audits it as "cli", and rejects bad input', async () => {
    const adminId = await createUser('locked_admin', 'admin');
    await exhaustDaily('locked_admin');
    await exhaustDaily('other_acct');
    assert.equal(await hitLimiter(limiters.loginAccountDaily, { username: 'locked_admin' }), 429);

    const result = await resetLoginLocks('Locked_Admin');
    assert.equal(result.userId, adminId);
    assert.ok(result.removed >= 1);
    assert.equal(await hitLimiter(limiters.loginAccountDaily, { username: 'locked_admin' }), 'pass');
    assert.equal(await hitLimiter(limiters.loginAccountDaily, { username: 'other_acct' }), 429);

    const entry = await db.get("SELECT * FROM admin_audit_log WHERE action = 'login.unlock' ORDER BY id DESC LIMIT 1");
    assert.equal(entry.actor_username, 'cli');
    assert.equal(entry.actor_id, 0);
    assert.equal(entry.target_id, adminId);
    await assert.rejects(resetLoginLocks("x' OR 1=1 --"), /valid username/);
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
