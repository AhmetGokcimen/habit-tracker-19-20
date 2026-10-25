'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, db, createUser, loginAs, wrap, PASSWORD } = require('./helpers');

const app = createApp();
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

describe('profile (own account only)', () => {
  let alice;

  before(async () => {
    await createUser('alice');
    await createUser('bob');
    alice = await loginAs(app, 'alice');
    const habit = (await alice.post('/api/habits').send({ title: 'Run', category: 'fitness', is_public: true })).body.habit;
    for (const n of [0, 1, 2, 5, 6, 7, 8]) await alice.post(`/api/habits/${habit.id}/checkins`).send({ checkin_date: day(n) });
  });

  test("returns the caller's own private details and stats, never anyone else's", async () => {
    const res = await alice.get('/api/users/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'alice');
    assert.equal(res.body.user.email, 'alice@example.test');
    assert.equal('password_hash' in res.body.user, false);
    assert.equal(res.body.stats.habits, 1);
    assert.equal(res.body.stats.checkins, 7);
    assert.equal(res.body.stats.longest_streak, 4);
    assert.equal(res.body.stats.best_current_streak, 3);

    // There is no way to address another user's profile.
    assert.equal((await alice.get('/api/users/2')).status, 404);
    assert.equal((await request(app).get('/api/users/me')).status, 401);
  });
});

describe('password change', () => {
  test('requires the correct current password and a valid new one', async () => {
    await createUser('carol');
    const carol = await loginAs(app, 'carol');
    const url = '/api/users/me/password';

    const wrong = await carol.post(url).send({ current_password: 'not-it-123', new_password: 'Brand-new-pw1' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.details[0].field, 'current_password');

    const weak = await carol.post(url).send({ current_password: PASSWORD, new_password: 'short' });
    assert.equal(weak.status, 400);
    const same = await carol.post(url).send({ current_password: PASSWORD, new_password: PASSWORD });
    assert.equal(same.status, 400);
    const extra = await carol.post(url).send({ current_password: PASSWORD, new_password: 'Brand-new-pw1', user_id: 1 });
    assert.equal(extra.status, 400);

    // Nothing changed: the old password still works.
    assert.equal((await wrap(request(app)).post('/api/auth/login').send({ username: 'carol', password: PASSWORD })).status, 200);
  });

  test('success keeps this session, signs out other sessions, and swaps the password', async () => {
    await createUser('dave');
    const laptop = await loginAs(app, 'dave');
    const phone = await loginAs(app, 'dave');

    const res = await laptop.post('/api/users/me/password').send({ current_password: PASSWORD, new_password: 'Brand-new-pw1' });
    assert.equal(res.status, 204);

    assert.equal((await laptop.get('/api/auth/me')).status, 200, 'current session stays');
    assert.equal((await phone.get('/api/auth/me')).status, 401, 'other session revoked');

    const anon = wrap(request(app));
    assert.equal((await anon.post('/api/auth/login').send({ username: 'dave', password: PASSWORD })).status, 401);
    assert.equal((await anon.post('/api/auth/login').send({ username: 'dave', password: 'Brand-new-pw1' })).status, 200);

    const hash = (await db.get("SELECT password_hash FROM users WHERE username = 'dave'")).password_hash;
    assert.match(hash, /^\$2[aby]\$/);
  });

  test('guessing the current password from a hijacked session is rate limited', async () => {
    await createUser('erin');
    const erin = await loginAs(app, 'erin');
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const res = await erin.post('/api/users/me/password').send({ current_password: `guess-${i}x`, new_password: 'Brand-new-pw1' });
      statuses.push(res.status);
    }
    assert.equal(statuses[0], 400);
    assert.equal(statuses.at(-1), 429);
  });
});

describe('F3 — badges', () => {
  test('badges are computed from the caller\'s own numbers', async () => {
    await createUser('badger');
    const agent = await loginAs(app, 'badger');
    let res = await agent.get('/api/users/me');
    assert.equal(res.status, 200);
    const first = res.body.badges.find((b) => b.id === 'first-checkin');
    assert.equal(first.earned, false);
    assert.deepEqual(first.progress, { value: 0, goal: 1 });

    const h = (await agent.post('/api/habits').send({ title: 'Read', category: 'learning', is_public: true })).body.habit;
    await agent.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: new Date().toISOString().slice(0, 10) });
    res = await agent.get('/api/users/me');
    const earned = res.body.badges.filter((b) => b.earned).map((b) => b.id).sort();
    assert.deepEqual(earned, ['first-checkin', 'sharer']);
  });

  test('there is no endpoint to award or claim a badge', async () => {
    await createUser('claimer');
    const agent = await loginAs(app, 'claimer');
    for (const path of ['/api/users/me/badges', '/api/badges']) {
      assert.equal((await agent.post(path).send({ id: 'streak-100' })).status, 404);
    }
    assert.equal((await agent.patch('/api/users/me').send({ badges: ['streak-100'] })).status, 404);
  });
});

describe('F6 — personal statistics', () => {
  test('stats cover only the caller\'s own habits and validate the range', async () => {
    await createUser('statsy');
    await createUser('other');
    const me = await loginAs(app, 'statsy');
    const other = await loginAs(app, 'other');
    const h = (await me.post('/api/habits').send({ title: 'Walk', category: 'fitness' })).body.habit;
    const o = (await other.post('/api/habits').send({ title: 'Secret', category: 'health', is_public: true })).body.habit;
    await me.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: day(0) });
    await other.post(`/api/habits/${o.id}/checkins`).send({ checkin_date: day(0) });

    const res = await me.get('/api/users/me/stats?range=30');
    assert.equal(res.status, 200);
    assert.equal(res.body.daily.length, 30);
    assert.deepEqual(res.body.habits.map((x) => x.title), ['Walk']);
    assert.equal(res.body.habits[0].done, 1);
    assert.deepEqual(res.body.by_category, [{ category: 'fitness', done: 1 }]);
    assert.equal(res.body.by_weekday.length, 7);

    for (const q of ['?range=7', '?range=30&range=90', '?range=1e9', '?user_id=2', '?range=30&x=1']) {
      assert.equal((await me.get(`/api/users/me/stats${q}`)).status, 400, q);
    }
    assert.equal((await request(app).get('/api/users/me/stats')).status, 401);
  });
});
