'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { request, createApp, db, createUser, loginAs, wrap, PASSWORD } = require('./helpers');

const app = createApp();
let rootId, bobId;
let root, bob;

const adminCount = async () => (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")).n;

async function sessionTokenFor(username) {
  const res = await wrap(request(app)).post('/api/auth/login').send({ username, password: PASSWORD });
  return res.headers['set-cookie'].find((c) => c.startsWith('session=')).split(';')[0].slice('session='.length);
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

before(async () => {
  rootId = await createUser('root', 'admin');
  bobId = await createUser('bob');
  root = await loginAs(app, 'root');
  bob = await loginAs(app, 'bob');
});

describe('F2 — admin endpoints are admin-only', () => {
  test('a normal user gets 403 on every admin endpoint; anonymous gets 401', async () => {
    const calls = [
      (a) => a.get('/api/admin/users'),
      (a) => a.get('/api/admin/stats'),
      (a) => a.get('/api/admin/photo-storage'),
      (a) => a.get('/api/admin/audit-log'),
      (a) => a.patch(`/api/admin/users/${bobId}/role`).send({ role: 'admin' }),
      (a) => a.patch(`/api/admin/users/${rootId}/role`).send({ role: 'user' }),
      (a) => a.delete(`/api/admin/users/${rootId}`),
    ];
    for (const call of calls) assert.equal((await call(bob)).status, 403);
    for (const call of calls) assert.equal((await call(wrap(request(app)))).status, 401);

    assert.equal((await db.get('SELECT role FROM users WHERE id = ?', [bobId])).role, 'user');
    assert.ok(await db.get('SELECT 1 FROM users WHERE id = ?', [rootId]));
  });

  test('a client-modified token claiming role=admin is rejected (signature no longer matches)', async () => {
    const real = await sessionTokenFor('bob');
    const [header, payload, signature] = real.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());

    // Tamper with the payload only (role + someone else's id), keep the original signature.
    const forgedPayload = b64url({ ...claims, role: 'admin', sub: String(rootId) });
    const tampered = `${header}.${forgedPayload}.${signature}`;
    // Same claims but "unsigned" (alg: none, empty signature).
    const unsigned = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ ...claims, role: 'admin' })}.`;

    for (const token of [tampered, unsigned]) {
      const res = await request(app).get('/api/admin/users').set('Cookie', `session=${token}`);
      assert.equal(res.status, 401);
    }
  });

  test('the role is read from the database, so even a validly signed role claim grants nothing', async () => {
    const real = await sessionTokenFor('bob');
    const claims = jwt.decode(real);
    assert.equal('role' in claims, false, 'tokens do not carry the role at all');

    const resigned = jwt.sign({ ...claims, role: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    const res = await request(app).get('/api/admin/users').set('Cookie', `session=${resigned}`);
    assert.equal(res.status, 403);
  });
});

describe('admin user management', () => {
  test('admin can list users including private emails', async () => {
    const res = await root.get('/api/admin/users');
    assert.equal(res.status, 200);
    assert.ok(res.body.users.some((u) => u.email === 'bob@example.test'));
    assert.ok(res.body.users.every((u) => !('password_hash' in u)));
  });

  test('role changes take effect immediately and are written to the audit log', async () => {
    const carolId = await createUser('carol');
    const carol = await loginAs(app, 'carol');

    assert.equal((await root.patch(`/api/admin/users/${carolId}/role`).send({ role: 'admin' })).status, 200);
    assert.equal((await carol.get('/api/admin/users')).status, 200, 'same session is now admin');

    assert.equal((await root.patch(`/api/admin/users/${carolId}/role`).send({ role: 'user' })).status, 200);
    // Demotion also revokes the demoted user's sessions.
    assert.equal((await carol.get('/api/admin/users')).status, 401, 'and loses it immediately');

    const log = (await root.get('/api/admin/audit-log')).body.entries.filter((e) => e.target_id === carolId);
    assert.deepEqual(log.map((e) => [e.action, e.details.to]), [['user.role_change', 'user'], ['user.role_change', 'admin']]);
    assert.ok(log.every((e) => e.actor_username === 'root' && e.created_at));
  });

  test('role input is validated', async () => {
    for (const body of [{ role: 'superadmin' }, { role: 'ADMIN' }, {}, { role: 'admin', id: 1 }]) {
      assert.equal((await root.patch(`/api/admin/users/${bobId}/role`).send(body)).status, 400);
    }
    assert.equal((await root.patch('/api/admin/users/999999/role').send({ role: 'admin' })).status, 404);
  });

  test('an admin cannot demote or delete themselves', async () => {
    assert.equal((await root.patch(`/api/admin/users/${rootId}/role`).send({ role: 'user' })).status, 403);
    assert.equal((await root.delete(`/api/admin/users/${rootId}`)).status, 403);
    assert.equal((await db.get('SELECT role FROM users WHERE id = ?', [rootId])).role, 'admin');
  });

  test('the last admin can never be removed, even by two admins acting at the same time', async () => {
    const secondId = await createUser('second', 'admin');
    const second = await loginAs(app, 'second');

    const results = await Promise.all([
      root.patch(`/api/admin/users/${secondId}/role`).send({ role: 'user' }),
      second.patch(`/api/admin/users/${rootId}/role`).send({ role: 'user' }),
    ]);
    assert.ok(await adminCount() >= 1);
    // The loser is refused: 409 (last admin), 403 (no longer admin) or 401 (its
    // session was revoked by the winner's demotion).
    assert.ok(results.some((r) => [401, 403, 409].includes(r.status)), JSON.stringify(results.map((r) => r.status)));

    // The database itself refuses to remove the last admin.
    await assert.rejects(db.run("UPDATE users SET role = 'user' WHERE role = 'admin'"), /last admin/);
    await assert.rejects(db.run("DELETE FROM users WHERE role = 'admin'"), /last admin/);
    assert.ok(await adminCount() >= 1);
  });

  test('deleting a user removes their data, kills their sessions and is audited', async () => {
    const daveId = await createUser('dave');
    const dave = await loginAs(app, 'dave');
    const habit = (await dave.post('/api/habits').send({ title: 'Swim', category: 'fitness', is_public: true })).body.habit;
    await dave.post(`/api/habits/${habit.id}/checkins`).send({ checkin_date: '2026-01-02' });
    await bob.post(`/api/habits/${habit.id}/comments`).send({ body: 'go dave' });

    assert.equal((await root.delete(`/api/admin/users/${daveId}`)).status, 204);

    assert.equal((await dave.get('/api/auth/me')).status, 401, 'session revoked');
    for (const table of ['habits', 'checkins', 'sessions']) {
      assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [daveId])).n, 0, table);
    }
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM comments WHERE habit_id = ?', [habit.id])).n, 0);

    const entry = await db.get("SELECT * FROM admin_audit_log WHERE action = 'user.delete' AND target_id = ?", [daveId]);
    assert.equal(entry.actor_id, rootId);
    assert.equal(JSON.parse(entry.details).username, 'dave');
  });

  test('the audit log is append-only', async () => {
    await assert.rejects(db.run('UPDATE admin_audit_log SET actor_username = ?', ['nobody']), /append-only/);
    await assert.rejects(db.run('DELETE FROM admin_audit_log'), /append-only/);
  });

  test('stats report is available to admins', async () => {
    const res = await root.get('/api/admin/stats');
    assert.equal(res.status, 200);
    assert.ok(res.body.totals.users >= 2);
    assert.ok(res.body.totals.admins >= 1);
  });
});
