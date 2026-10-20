'use strict';

// The demo admin credentials are public (README). These tests show that knowing
// them grants exactly the F2 admin powers and nothing more, that every use of
// those powers leaves an audit trail, and that a compromised admin can be cut
// off by the other admin.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { request, createApp, db, createUser, loginAs, wrap, PASSWORD } = require('./helpers');

const app = createApp();
const ids = {};

const auditCount = async () => (await db.get('SELECT COUNT(*) AS n FROM admin_audit_log')).n;
const lastAudit = () => db.get('SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 1');

// Many logins happen in this file; start each test with fresh rate-limit counters.
beforeEach(() => db.run('DELETE FROM rate_limits'));

describe('known admin credentials grant nothing beyond F2', async () => {
  ids.admin = await createUser('admin', 'admin');
  ids.moderator = await createUser('moderator', 'admin');
  ids.alice = await createUser('alice');
  ids.bob = await createUser('bob');

  test('there is no way for an admin to set or reset another account’s password', async () => {
    const admin = await loginAs(app, 'admin');
    const aliceHash = (await db.get('SELECT password_hash FROM users WHERE id = ?', [ids.alice])).password_hash;
    const modHash = (await db.get('SELECT password_hash FROM users WHERE id = ?', [ids.moderator])).password_hash;

    const attempts = [
      admin.post(`/api/users/${ids.alice}/password`).send({ new_password: 'Owned-Passw0rd!' }),
      admin.patch(`/api/admin/users/${ids.alice}`).send({ password: 'Owned-Passw0rd!' }),
      admin.post(`/api/admin/users/${ids.moderator}/password`).send({ new_password: 'Owned-Passw0rd!' }),
      admin.patch(`/api/admin/users/${ids.moderator}/role`).send({ role: 'admin', password: 'Owned-Passw0rd!' }),
      admin.post('/api/users/me/password').send({ current_password: PASSWORD, new_password: 'Owned-Passw0rd!', username: 'alice' }),
    ];
    for (const res of await Promise.all(attempts)) assert.ok([400, 404].includes(res.status), String(res.status));

    assert.equal((await db.get('SELECT password_hash FROM users WHERE id = ?', [ids.alice])).password_hash, aliceHash);
    assert.equal((await db.get('SELECT password_hash FROM users WHERE id = ?', [ids.moderator])).password_hash, modHash);
    assert.equal((await wrap(request(app)).post('/api/auth/login').send({ username: 'alice', password: 'Owned-Passw0rd!' })).status, 401);
  });

  test('an admin cannot act as another user (no impersonation)', async () => {
    const admin = await loginAs(app, 'admin');

    // Identity always comes from the session, whatever headers or parameters say.
    for (const [header, value] of [['X-User-Id', String(ids.alice)], ['X-Forwarded-User', 'alice'], ['X-Impersonate', 'alice']]) {
      const me = await admin.get('/api/auth/me?as=alice&user_id=3').set(header, value);
      assert.equal(me.body.user.username, 'admin');
    }

    // Writes are attributed to the admin, and owner fields cannot be supplied.
    assert.equal((await admin.post('/api/habits').send({ title: 'x', category: 'other', user_id: ids.alice })).status, 400);
    const alicesHabit = (await (await loginAs(app, 'alice')).post('/api/habits')
      .send({ title: 'Mine', category: 'other', is_public: true })).body.habit;
    const comment = await admin.post(`/api/habits/${alicesHabit.id}/comments`).send({ body: 'hello' });
    assert.equal(comment.body.comment.author.username, 'admin');
    assert.equal((await admin.post(`/api/habits/${alicesHabit.id}/comments`).send({ body: 'x', user_id: ids.alice })).status, 400);

    // Admins may remove other people's content but never change it or add to it.
    assert.equal((await admin.patch(`/api/habits/${alicesHabit.id}`).send({ title: 'edited' })).status, 403);
    assert.equal((await admin.post(`/api/habits/${alicesHabit.id}/checkins`).send({ checkin_date: '2026-01-05' })).status, 403);
  });

  test('admin endpoints never expose password hashes or session tokens', async () => {
    const admin = await loginAs(app, 'admin');
    const body = JSON.stringify((await admin.get('/api/admin/users')).body);
    assert.doesNotMatch(body, /password|hash|\$2[aby]\$|jti|session/i);
  });

  test('admin tokens carry no role or extra privilege — the role is read from the database', async () => {
    const res = await wrap(request(app)).post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const token = res.headers['set-cookie'][0].split(';')[0].slice('session='.length);
    const claims = jwt.decode(token);
    assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'iss', 'jti', 'sub']);
  });
});

describe('login rate limiting with the correct password', () => {
  test('repeated successful logins from one IP are capped too', async () => {
    const statuses = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await wrap(request(app)).post('/api/auth/login').send({ username: 'bob', password: PASSWORD })).status);
    }
    assert.equal(statuses.filter((s) => s === 200).length, 30);
    assert.deepEqual(statuses.slice(30), [429, 429]);
  });
});

describe('every use of admin power leaves an audit record', () => {
  test('login, role changes, user deletion and content removal are each logged with actor and target', async () => {
    let before = await auditCount();
    const admin = await loginAs(app, 'moderator');
    let entry = await lastAudit();
    assert.equal(await auditCount(), before + 1);
    assert.deepEqual([entry.action, entry.actor_username, entry.target_id], ['admin.login', 'moderator', ids.moderator]);

    const victimId = await createUser('victim');
    const victim = await loginAs(app, 'victim');
    const habit = (await victim.post('/api/habits').send({ title: 'Victim habit', category: 'other', is_public: true })).body.habit;
    const checkin = (await victim.post(`/api/habits/${habit.id}/checkins`).send({ checkin_date: '2026-01-02' })).body.checkin;
    const comment = (await victim.post(`/api/habits/${habit.id}/comments`).send({ body: 'my comment' })).body.comment;

    const actions = [
      ['user.role_change', victimId, () => admin.patch(`/api/admin/users/${victimId}/role`).send({ role: 'admin' })],
      ['user.role_change', victimId, () => admin.patch(`/api/admin/users/${victimId}/role`).send({ role: 'user' })],
      ['comment.delete', comment.id, () => admin.delete(`/api/comments/${comment.id}`)],
      ['checkin.delete', checkin.id, () => admin.delete(`/api/checkins/${checkin.id}`)],
      ['habit.delete', habit.id, () => admin.delete(`/api/habits/${habit.id}`)],
      ['user.delete', victimId, () => admin.delete(`/api/admin/users/${victimId}`)],
    ];
    for (const [action, targetId, run] of actions) {
      before = await auditCount();
      const res = await run();
      assert.ok(res.status < 300, `${action} -> ${res.status}`);
      entry = await lastAudit();
      assert.equal(await auditCount(), before + 1, action);
      assert.deepEqual([entry.action, entry.actor_id, entry.target_id], [action, ids.moderator, targetId]);
    }

    // The trail cannot be erased afterwards, not even directly in the database.
    await assert.rejects(db.run('DELETE FROM admin_audit_log WHERE actor_id = ?', [ids.moderator]), /append-only/);
  });

  test('a refused admin action does not happen and is not recorded as done', async () => {
    const admin = await loginAs(app, 'admin');
    const before = await auditCount();
    assert.equal((await admin.patch(`/api/admin/users/${ids.admin}/role`).send({ role: 'user' })).status, 403);
    assert.equal(await auditCount(), before);
  });
});

describe('a compromised admin account can be cut off by the other admin', () => {
  test('demoting the compromised admin ends its sessions and its admin access', async () => {
    const compromised = await loginAs(app, 'admin');
    const moderator = await loginAs(app, 'moderator');
    assert.equal((await compromised.get('/api/admin/users')).status, 200);

    assert.equal((await moderator.patch(`/api/admin/users/${ids.admin}/role`).send({ role: 'user' })).status, 200);

    assert.equal((await compromised.get('/api/admin/users')).status, 401, 'existing session is revoked');
    const again = await loginAs(app, 'admin'); // still knows the password
    assert.equal((await again.get('/api/admin/users')).status, 403, 'logging in again gives no admin access');
    assert.equal((await again.patch(`/api/admin/users/${ids.admin}/role`).send({ role: 'admin' })).status, 403, 'cannot re-promote itself');

    // Restore for the next test.
    assert.equal((await moderator.patch(`/api/admin/users/${ids.admin}/role`).send({ role: 'admin' })).status, 200);
  });

  test('deleting the compromised admin locks it out completely', async () => {
    const compromisedId = await createUser('stolen_admin', 'admin');
    const compromised = await loginAs(app, 'stolen_admin');
    const moderator = await loginAs(app, 'moderator');

    assert.equal((await moderator.delete(`/api/admin/users/${compromisedId}`)).status, 204);
    assert.equal((await compromised.get('/api/auth/me')).status, 401);
    const login = await wrap(request(app)).post('/api/auth/login').send({ username: 'stolen_admin', password: PASSWORD });
    assert.equal(login.status, 401);
  });
});
