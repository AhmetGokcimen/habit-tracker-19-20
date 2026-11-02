'use strict';

// M-1: list endpoints have a page-size ceiling, search text has length bounds,
// and list reads share a per-user rate limit. Normal use keeps working.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, db, createUser, loginAs } = require('./helpers');
const { LIST_READS_LIMIT } = require('../src/middleware/rateLimit');

const app = createApp();

async function newUser(name, role = 'user') {
  await createUser(name, role);
  return loginAs(app, name);
}

before(async () => {
  const owner = await newUser('lister');
  for (let i = 1; i <= 60; i++) {
    const res = await owner.post('/api/habits').send({ title: `Shared habit ${i}`, category: 'other', is_public: true });
    assert.equal(res.status, 201);
  }
});

describe('search page size', () => {
  test('default is 20, values inside the range are used, larger values are clamped to 50', async () => {
    const reader = await newUser('reader_a');
    const byDefault = await reader.get('/api/habits?q=Shared');
    assert.equal(byDefault.status, 200);
    assert.deepEqual([byDefault.body.habits.length, byDefault.body.limit, byDefault.body.has_more], [20, 20, true]);

    const ten = await reader.get('/api/habits?q=Shared&limit=10');
    assert.deepEqual([ten.body.habits.length, ten.body.limit], [10, 10]);

    const clamped = await reader.get('/api/habits?q=Shared&limit=500');
    assert.equal(clamped.status, 200);
    assert.deepEqual([clamped.body.habits.length, clamped.body.limit, clamped.body.has_more], [50, 50, true]);

    const next = await reader.get('/api/habits?q=Shared&limit=50&page=2');
    assert.deepEqual([next.body.habits.length, next.body.has_more], [10, false]);

    for (const bad of ['0', '-5', 'abc', '2.5']) {
      assert.equal((await reader.get(`/api/habits?limit=${bad}`)).status, 400, bad);
    }
  });
});

describe('search text length', () => {
  test('2 to 50 characters are accepted; empty means no filter; 1 or 51 characters are rejected', async () => {
    const reader = await newUser('reader_b');
    assert.equal((await reader.get('/api/habits?q=Sh')).status, 200);
    assert.equal((await reader.get(`/api/habits?q=${'x'.repeat(50)}`)).status, 200);
    assert.equal((await reader.get('/api/habits?q=')).status, 200);
    assert.equal((await reader.get('/api/habits?q=%20%20')).status, 200); // trimmed to empty
    assert.equal((await reader.get('/api/habits?q=S')).status, 400);
    assert.equal((await reader.get(`/api/habits?q=${'x'.repeat(51)}`)).status, 400);
  });
});

describe('leaderboard page size', () => {
  test('default and clamp are 50; smaller limits are used', async () => {
    const admin = await newUser('lb_admin', 'admin');
    const today = new Date().toISOString().slice(0, 10);
    const created = await admin.post('/api/admin/challenges').send({ title: 'Month', category: 'other', start_date: today, end_date: today });
    assert.equal(created.status, 201);
    const ch = created.body.challenge;
    for (const name of ['lb_1', 'lb_2', 'lb_3']) {
      const member = await newUser(name);
      const habit = (await member.post('/api/habits').send({ title: 'Mine', category: 'other' })).body.habit;
      assert.equal((await member.post(`/api/challenges/${ch.id}/join`).send({ habit_id: habit.id, share_progress: true })).status, 201);
    }
    const all = await admin.get(`/api/challenges/${ch.id}`);
    assert.deepEqual([all.status, all.body.leaderboard.length, all.body.limit], [200, 3, 50]);
    const two = await admin.get(`/api/challenges/${ch.id}?limit=2`);
    assert.deepEqual([two.body.leaderboard.length, two.body.limit], [2, 2]);
    const clamped = await admin.get(`/api/challenges/${ch.id}?limit=1000`);
    assert.deepEqual([clamped.status, clamped.body.limit], [200, 50]);
    assert.equal((await admin.get(`/api/challenges/${ch.id}?other=1`)).status, 400); // strict query
  });
});

describe('list read rate limit', () => {
  test(`search, own habits and leaderboards share ${LIST_READS_LIMIT} reads per 10 minutes per user`, async () => {
    await db.run('DELETE FROM rate_limit_windows');
    const heavy = await newUser('heavy_reader');
    const urls = ['/api/habits?q=Shared', '/api/habits/mine'];
    for (let i = 0; i < LIST_READS_LIMIT; i++) {
      assert.equal((await heavy.get(urls[i % 2])).status, 200, `read ${i + 1}`);
    }
    assert.equal((await heavy.get('/api/habits/mine')).status, 429);
    assert.equal((await heavy.get('/api/habits?q=Shared')).status, 429);

    // Other users and other endpoints are unaffected.
    const other = await newUser('light_reader');
    assert.equal((await other.get('/api/habits/mine')).status, 200);
    assert.equal((await heavy.get('/api/users/me')).status, 200);
  });
});
