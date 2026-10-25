'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, db, createUser, loginAs } = require('./helpers');

const app = createApp();
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let alice, bob, admin;
let aliceHabit, bobHabit, challenge;

before(async () => {
  await createUser('alice');
  await createUser('bob');
  await createUser('root', 'admin');
  alice = await loginAs(app, 'alice');
  bob = await loginAs(app, 'bob');
  admin = await loginAs(app, 'root');
  aliceHabit = (await alice.post('/api/habits').send({ title: 'Run', category: 'fitness' })).body.habit;
  bobHabit = (await bob.post('/api/habits').send({ title: 'Jog', category: 'fitness' })).body.habit;
  const res = await admin.post('/api/admin/challenges').send({
    title: '30 days of running', category: 'fitness', start_date: day(-3), end_date: day(26),
  });
  assert.equal(res.status, 201);
  challenge = res.body.challenge;
});

describe('F13 — challenges', () => {
  test('only admins create challenges; creation is audited with the new id', async () => {
    const body = { title: 'Mine', category: 'other', start_date: day(0), end_date: day(5) };
    assert.equal((await alice.post('/api/admin/challenges').send(body)).status, 403);
    const entry = await db.get("SELECT * FROM admin_audit_log WHERE action = 'challenge.create'");
    assert.equal(entry.target_id, challenge.id);
  });

  test('challenge input is validated', async () => {
    const bad = [
      { title: '', category: 'fitness', start_date: day(0), end_date: day(1) },
      { title: 'X', category: 'nope', start_date: day(0), end_date: day(1) },
      { title: 'X', category: 'fitness', start_date: day(5), end_date: day(1) },
      { title: 'X', category: 'fitness', start_date: '2026-02-30', end_date: '2026-03-02' },
      { title: 'X', category: 'fitness', start_date: day(0), end_date: day(400) },
      { title: 'X', category: 'fitness', start_date: day(0), end_date: day(1), created_by: 1 },
    ];
    for (const b of bad) assert.equal((await admin.post('/api/admin/challenges').send(b)).status, 400, JSON.stringify(b));
  });

  test('joining needs your own habit and explicit consent', async () => {
    const url = `/api/challenges/${challenge.id}/join`;
    assert.equal((await alice.post(url).send({ habit_id: aliceHabit.id })).status, 400);
    assert.equal((await alice.post(url).send({ habit_id: aliceHabit.id, share_progress: 'yes' })).status, 400);
    assert.equal((await alice.post(url).send({ habit_id: bobHabit.id, share_progress: true })).status, 400);
    assert.equal((await alice.post(url).send({ habit_id: 999999, share_progress: true })).status, 400);
    assert.equal((await alice.post(url).send({ habit_id: aliceHabit.id, share_progress: true })).status, 201);
    assert.equal((await alice.post(url).send({ habit_id: aliceHabit.id, share_progress: true })).status, 409);
  });

  test('the database refuses a membership with someone else\'s habit', async () => {
    const bobId = (await db.get("SELECT id FROM users WHERE username = 'bob'")).id;
    await assert.rejects(
      db.run('INSERT INTO challenge_members (challenge_id, user_id, habit_id) VALUES (?, ?, ?)', [challenge.id, bobId, aliceHabit.id]),
      /challenge habit must belong to the member/,
    );
  });

  test('leaderboard shows usernames and day counts only', async () => {
    await bob.post(`/api/challenges/${challenge.id}/join`).send({ habit_id: bobHabit.id, share_progress: true });
    await alice.post(`/api/habits/${aliceHabit.id}/checkins`).send({ checkin_date: day(0), note: 'secret note' });
    await alice.post(`/api/habits/${aliceHabit.id}/checkins`).send({ checkin_date: day(-1) });
    await alice.post(`/api/habits/${aliceHabit.id}/checkins`).send({ checkin_date: day(-10) }); // before the start

    const res = await bob.get(`/api/challenges/${challenge.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.leaderboard.map(({ rank, username, days }) => ({ rank, username, days })), [
      { rank: 1, username: 'alice', days: 2 },
      { rank: 2, username: 'bob', days: 0 },
    ]);
    assert.equal(res.body.me.username, 'bob');
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('secret note') && !text.includes(day(-1)));
    // Rows carry no ids of other people's habits or accounts.
    for (const row of res.body.leaderboard) assert.deepEqual(Object.keys(row).sort(), ['days', 'is_me', 'rank', 'username']);
  });

  test('leaving removes you from the board; ended challenges cannot be joined', async () => {
    assert.equal((await bob.delete(`/api/challenges/${challenge.id}/membership`)).status, 204);
    const board = (await alice.get(`/api/challenges/${challenge.id}`)).body.leaderboard;
    assert.deepEqual(board.map((r) => r.username), ['alice']);

    const old = (await admin.post('/api/admin/challenges').send({ title: 'Old', category: 'other', start_date: day(-20), end_date: day(-10) })).body.challenge;
    assert.equal((await bob.post(`/api/challenges/${old.id}/join`).send({ habit_id: bobHabit.id, share_progress: true })).status, 400);
  });

  test('deleting a habit removes its membership; admin can delete a challenge (audited)', async () => {
    const h = (await bob.post('/api/habits').send({ title: 'Temp', category: 'fitness' })).body.habit;
    await bob.post(`/api/challenges/${challenge.id}/join`).send({ habit_id: h.id, share_progress: true });
    await bob.delete(`/api/habits/${h.id}`);
    assert.ok(!(await alice.get(`/api/challenges/${challenge.id}`)).body.leaderboard.some((r) => r.username === 'bob'));

    assert.equal((await alice.delete(`/api/admin/challenges/${challenge.id}`)).status, 403);
    assert.equal((await admin.delete(`/api/admin/challenges/${challenge.id}`)).status, 204);
    assert.equal((await alice.get(`/api/challenges/${challenge.id}`)).status, 404);
    assert.ok(await db.get("SELECT 1 FROM admin_audit_log WHERE action = 'challenge.delete'"));
    assert.equal((await request(app).get('/api/challenges')).status, 401);
  });
});
