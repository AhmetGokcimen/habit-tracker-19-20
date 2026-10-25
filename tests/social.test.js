'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, createUser, loginAs } = require('./helpers');

const app = createApp();
let alice, bob, carol;
let bobId, carolId, quietId;

before(async () => {
  await createUser('alice');
  bobId = await createUser('bob');
  carolId = await createUser('carol');
  quietId = await createUser('quiet');
  alice = await loginAs(app, 'alice');
  bob = await loginAs(app, 'bob');
  carol = await loginAs(app, 'carol');
  await bob.post('/api/habits').send({ title: 'Bob shares this', category: 'fitness', is_public: true });
  await bob.post('/api/habits').send({ title: 'Bob keeps this private', category: 'health' });
  await carol.post('/api/habits').send({ title: 'Carol shares too', category: 'learning', is_public: true });
});

describe('F11 — public profiles', () => {
  test('a profile shows only public habits and no private details', async () => {
    const res = await alice.get(`/api/users/${bobId}/public`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.habits.map((h) => h.title), ['Bob shares this']);
    assert.deepEqual(Object.keys(res.body.user).sort(), ['id', 'joined', 'username']);
    assert.match(res.body.user.joined, /^\d{4}-\d{2}$/);
    assert.ok(!JSON.stringify(res.body).includes('@example.test'));
  });

  test('people who share nothing have no profile (ids cannot be walked)', async () => {
    assert.equal((await alice.get(`/api/users/${quietId}/public`)).status, 404);
    assert.equal((await alice.get('/api/users/999999/public')).status, 404);
    assert.equal((await alice.get('/api/users/abc/public')).status, 404);
    assert.equal((await request(app).get(`/api/users/${bobId}/public`)).status, 401);
  });
});

describe('F11 — following and feed', () => {
  test('follow, feed and unfollow', async () => {
    assert.equal((await alice.put(`/api/users/${bobId}/follow`)).status, 204);
    assert.equal((await alice.put(`/api/users/${bobId}/follow`)).status, 204); // idempotent

    const profile = (await carol.get(`/api/users/${bobId}/public`)).body;
    assert.equal(profile.follower_count, 1);
    assert.equal(profile.you_follow, false);

    const feed = (await alice.get('/api/feed')).body.habits;
    assert.deepEqual(feed.map((h) => h.title), ['Bob shares this']);
    assert.deepEqual((await alice.get('/api/users/me/following')).body.following, [{ id: bobId, username: 'bob' }]);

    assert.equal((await alice.delete(`/api/users/${bobId}/follow`)).status, 204);
    assert.deepEqual((await alice.get('/api/feed')).body.habits, []);
  });

  test('following gives no access to private data', async () => {
    await alice.put(`/api/users/${bobId}/follow`);
    const feed = JSON.stringify((await alice.get('/api/feed')).body);
    assert.ok(!feed.includes('Bob keeps this private'));
    const privateHabit = (await bob.get('/api/habits/mine')).body.habits.find((h) => !h.is_public);
    assert.equal((await alice.get(`/api/habits/${privateHabit.id}`)).status, 403);
    const shared = (await bob.get('/api/habits/mine')).body.habits.find((h) => h.is_public);
    assert.equal((await alice.get(`/api/habits/${shared.id}/checkins`)).status, 403);
  });

  test('follower lists are not exposed; self-follow and unknown users are refused', async () => {
    assert.equal((await alice.get(`/api/users/${bobId}/followers`)).status, 404);
    assert.equal((await bob.put(`/api/users/${bobId}/follow`)).status, 400);
    assert.equal((await alice.put(`/api/users/${quietId}/follow`)).status, 404);
    assert.equal((await alice.put('/api/users/0/follow')).status, 404);
    // CSRF header is still required for follow (state-changing).
    assert.equal((await alice.raw.put(`/api/users/${carolId}/follow`)).status, 403);
  });

  test('unknown /api paths are still a 404 for anonymous callers', async () => {
    assert.equal((await request(app).get('/api/nope')).status, 404);
  });
});

describe('F12 — reactions', () => {
  let shared;
  before(async () => {
    shared = (await bob.get('/api/habits/mine')).body.habits.find((h) => h.is_public);
  });

  test('react, count, un-react; only counts are returned', async () => {
    let res = await alice.put(`/api/habits/${shared.id}/reactions/clap`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { counts: { clap: 1, fire: 0, muscle: 0 }, mine: ['clap'] });
    await alice.put(`/api/habits/${shared.id}/reactions/clap`); // idempotent
    await carol.put(`/api/habits/${shared.id}/reactions/clap`);

    res = await bob.get(`/api/habits/${shared.id}/reactions`);
    assert.deepEqual(res.body, { counts: { clap: 2, fire: 0, muscle: 0 }, mine: [] });
    assert.ok(!JSON.stringify(res.body).includes('alice'));

    const search = (await carol.get('/api/habits?q=Bob%20shares')).body.habits[0];
    assert.equal(search.reaction_count, 2);

    res = await alice.delete(`/api/habits/${shared.id}/reactions/clap`);
    assert.deepEqual(res.body.counts.clap, 1);
  });

  test('no reactions on private, own or unknown kinds', async () => {
    const priv = (await bob.get('/api/habits/mine')).body.habits.find((h) => !h.is_public);
    assert.equal((await alice.put(`/api/habits/${priv.id}/reactions/fire`)).status, 403);
    assert.equal((await bob.put(`/api/habits/${shared.id}/reactions/fire`)).status, 403);
    assert.equal((await alice.put(`/api/habits/${shared.id}/reactions/heart`)).status, 404);
    assert.equal((await alice.put(`/api/habits/${shared.id}/reactions/__proto__`)).status, 404);
    assert.equal((await alice.raw.put(`/api/habits/${shared.id}/reactions/fire`)).status, 403); // CSRF header
  });
});

describe('deleting a user removes their social data everywhere', () => {
  test('no orphaned follows, reactions or freezes remain', async () => {
    const { db } = require('./helpers');
    const goneId = await createUser('leaver');
    await createUser('boss', 'admin');
    const leaver = await loginAs(app, 'leaver');
    const boss = await loginAs(app, 'boss');
    const h = (await leaver.post('/api/habits').send({ title: 'Leaver shares', category: 'other', is_public: true })).body.habit;
    await leaver.put(`/api/users/${bobId}/follow`);
    await carol.put(`/api/users/${goneId}/follow`);
    await carol.put(`/api/habits/${h.id}/reactions/fire`);
    const shared = (await bob.get('/api/habits/mine')).body.habits.find((x) => x.is_public);
    await leaver.put(`/api/habits/${shared.id}/reactions/muscle`);

    assert.equal((await boss.delete(`/api/admin/users/${goneId}`)).status, 204);
    const left = await db.get(
      `SELECT (SELECT COUNT(*) FROM follows WHERE follower_id = ?1 OR followee_id = ?1) AS f,
              (SELECT COUNT(*) FROM reactions WHERE user_id = ?1 OR habit_id = ?2) AS r,
              (SELECT COUNT(*) FROM streak_freezes WHERE user_id = ?1) AS z`,
      [goneId, h.id],
    );
    assert.deepEqual({ ...left }, { f: 0, r: 0, z: 0 });
  });
});
