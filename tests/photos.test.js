'use strict';

// H-2: proof-photo storage is bounded per user (atomic quota) and for the
// whole service (one-row counter kept by triggers), uploads have their own
// rate limit, and photos are accepted only for recent days.

// Small limits so the tests stay fast; read by config on load. The global cap
// is large here, and its own test sets the counter directly instead of
// filling it, so the tests do not depend on each other's uploads.
require('./env').testEnv({ PHOTO_QUOTA_MB: '1', PHOTO_TOTAL_CAP_MB: '100' });

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, db, createUser, loginAs } = require('./helpers');

const app = createApp();
const KB = 1024;
const QUOTA = 1024 * KB;
const TOTAL_CAP = 100 * 1024 * KB;
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (kb) => Buffer.concat([SIG, Buffer.alloc(kb * KB, 7)]);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const counter = async () => (await db.get('SELECT bytes FROM photo_storage WHERE id = 1')).bytes;
const actualTotal = async () => (await db.get('SELECT COALESCE(SUM(length(photo_data)), 0) AS n FROM checkins')).n;

async function setup(name) {
  const id = await createUser(name);
  const agent = await loginAs(app, name);
  const habit = (await agent.post('/api/habits').send({ title: 'Proof', category: 'health' })).body.habit;
  const upload = (date, kb) => agent.post(`/api/habits/${habit.id}/checkins`).field('checkin_date', date).attach('photo', png(kb), 'p.png');
  const replace = (checkinId, kb) => agent.put(`/api/checkins/${checkinId}/photo`).attach('photo', png(kb), 'p.png');
  const storedBytes = async () =>
    (await db.get('SELECT COALESCE(SUM(length(photo_data)), 0) AS n FROM checkins WHERE user_id = ?', [id])).n;
  return { id, agent, habit, upload, replace, storedBytes };
}

describe('per-user photo quota', () => {
  test('when the quota is full, a new photo is refused (409) and nothing is stored', async () => {
    const u = await setup('quota_full');
    assert.equal((await u.upload(daysAgo(0), 600)).status, 201);
    const refused = await u.upload(daysAgo(1), 600);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /photo storage is full/i);
    assert.equal(await db.get('SELECT 1 FROM checkins WHERE habit_id = ? AND checkin_date = ?', [u.habit.id, daysAgo(1)]), undefined);
    // Check-ins without a photo are not affected by the quota.
    assert.equal((await u.agent.post(`/api/habits/${u.habit.id}/checkins`).send({ checkin_date: daysAgo(1) })).status, 201);
  });

  test('replacing a photo does not count the photo being replaced, but cannot exceed the quota', async () => {
    const u = await setup('quota_replace');
    const big = (await u.upload(daysAgo(0), 600)).body.checkin;
    const small = (await u.upload(daysAgo(1), 300)).body.checkin;
    assert.equal((await u.replace(big.id, 600)).status, 200); // 600 replaces 600: fits
    const before = await u.storedBytes();
    assert.equal((await u.replace(small.id, 500)).status, 409); // 600 + 500 > 1024 KB
    assert.equal(await u.storedBytes(), before); // the old photo is kept
  });

  test('the quota is per user', async () => {
    const a = await setup('quota_a');
    const b = await setup('quota_b');
    assert.equal((await a.upload(daysAgo(0), 900)).status, 201);
    assert.equal((await b.upload(daysAgo(0), 900)).status, 201);
  });

  test('parallel uploads cannot exceed the quota together (atomic check)', async () => {
    const u = await setup('quota_race');
    const results = await Promise.all([0, 1, 2, 3].map((d) => u.upload(daysAgo(d), 400)));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 409, 409]);
    assert.ok((await u.storedBytes()) <= QUOTA);
  });
});

describe('service-wide photo storage cap', () => {
  test('when the global cap is reached, new photos get 507 and nothing is stored; check-ins without a photo still work', async (t) => {
    const u = await setup('cap_full');
    await db.run('UPDATE photo_storage SET bytes = ? WHERE id = 1', [TOTAL_CAP - 100 * KB]);
    // Restore from the real total: this test also stores a photo successfully.
    t.after(() => db.run('UPDATE photo_storage SET bytes = (SELECT COALESCE(SUM(length(photo_data)), 0) FROM checkins) WHERE id = 1'));

    const refused = await u.upload(daysAgo(0), 200);
    assert.equal(refused.status, 507);
    assert.match(refused.body.error, /storage is full/);
    assert.equal(await db.get('SELECT 1 FROM checkins WHERE habit_id = ? AND checkin_date = ?', [u.habit.id, daysAgo(0)]), undefined);

    assert.equal((await u.agent.post(`/api/habits/${u.habit.id}/checkins`).send({ checkin_date: daysAgo(0) })).status, 201);
    assert.equal((await u.agent.get('/api/habits/mine')).status, 200); // the rest of the app is unaffected
    assert.equal((await u.upload(daysAgo(1), 50)).status, 201); // a photo that still fits is accepted
  });

  test('the counter follows every insert, replace, photo removal and deletion', async () => {
    const u = await setup('cap_counter');
    const check = async (label) => assert.equal(await counter(), await actualTotal(), label);
    await check('start');
    const c1 = (await u.upload(daysAgo(0), 100)).body.checkin;
    const c2 = (await u.upload(daysAgo(1), 50)).body.checkin;
    await check('after inserts');
    assert.equal((await u.replace(c1.id, 300)).status, 200);
    await check('after a bigger replacement');
    assert.equal((await u.replace(c1.id, 10)).status, 200);
    await check('after a smaller replacement');
    assert.equal((await u.agent.delete(`/api/checkins/${c1.id}/photo`)).status, 204);
    await check('after removing a photo');
    assert.equal((await u.agent.delete(`/api/checkins/${c2.id}`)).status, 204);
    await check('after deleting a check-in');
    assert.equal((await u.upload(daysAgo(2), 20)).status, 201);
    assert.equal((await u.agent.delete(`/api/habits/${u.habit.id}`)).status, 204);
    await check('after deleting the habit');
  });

  test('the counter is initialised from existing photos when the schema loads', async () => {
    const u = await setup('cap_init');
    assert.equal((await u.upload(daysAgo(0), 70)).status, 201);
    await db.run('DELETE FROM photo_storage');
    db.close();
    await db.init(); // what every cold start does
    assert.equal(await counter(), await actualTotal());
  });
});

describe('photos only for recent days', () => {
  test('old dates take no photo; old check-ins without a photo still work', async () => {
    const u = await setup('recent_only');
    const old = await u.upload(daysAgo(9), 1);
    assert.equal(old.status, 400);
    assert.match(old.body.error, /last 7 days/);
    assert.equal((await u.upload(daysAgo(7), 1)).status, 201); // inside the window

    const plain = (await u.agent.post(`/api/habits/${u.habit.id}/checkins`).send({ checkin_date: daysAgo(9) })).body.checkin;
    assert.ok(plain.id);
    assert.equal((await u.replace(plain.id, 1)).status, 400); // no photo added later either
  });

  test('a check-in with a photo cannot be moved outside the window', async () => {
    const u = await setup('no_move');
    const c = (await u.upload(daysAgo(0), 1)).body.checkin;
    assert.equal((await u.agent.patch(`/api/checkins/${c.id}`).send({ checkin_date: daysAgo(9) })).status, 400);
    assert.equal((await u.agent.patch(`/api/checkins/${c.id}`).send({ checkin_date: daysAgo(3) })).status, 200);
    assert.equal((await u.agent.patch(`/api/checkins/${c.id}`).send({ note: 'edited' })).status, 200);
  });

  test('an old check-in with a photo can keep its date or move later, but not earlier', async () => {
    const u = await setup('old_move');
    const c = (await u.upload(daysAgo(0), 1)).body.checkin;
    // An older photo check-in (e.g. from before the window existed).
    await db.run('UPDATE checkins SET checkin_date = ? WHERE id = ?', [daysAgo(20), c.id]);
    const patch = (body) => u.agent.patch(`/api/checkins/${c.id}`).send(body);

    const earlier = await patch({ checkin_date: daysAgo(25) });
    assert.equal(earlier.status, 400);
    assert.match(earlier.body.error, /earlier date outside the last 7 days/);
    assert.ok(earlier.body.error.includes(daysAgo(20)));

    assert.equal((await patch({ checkin_date: daysAgo(20) })).status, 200); // same date
    assert.equal((await patch({ checkin_date: daysAgo(15) })).status, 200); // later, still old
    assert.equal((await patch({ checkin_date: daysAgo(2) })).status, 200); // into the window
    assert.equal((await db.get('SELECT checkin_date FROM checkins WHERE id = ?', [c.id])).checkin_date, daysAgo(2));
  });
});

describe('a check-in deleted while its photo is being replaced', () => {
  test('gets 404, not a server error', async (t) => {
    const u = await setup('gone_during_put');
    const c = (await u.upload(daysAgo(0), 1)).body.checkin;
    // Simulate a parallel DELETE landing between authorisation and the UPDATE.
    const run = db.run;
    const spy = mock.method(db, 'run', async (sql, args) => {
      if (sql.startsWith('UPDATE checkins SET photo_data = ?1')) await run('DELETE FROM checkins WHERE id = ?', [c.id]);
      return run(sql, args);
    });
    t.after(() => spy.mock.restore());
    const res = await u.replace(c.id, 1);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /no longer exists/);
  });
});

describe('upload rate limit', () => {
  test('at most 20 photo uploads per hour per user; JSON check-ins are not counted', async () => {
    const u = await setup('upload_limit');
    const c = (await u.upload(daysAgo(0), 1)).body.checkin; // upload 1
    for (let i = 2; i <= 20; i++) assert.equal((await u.replace(c.id, 1)).status, 200, `upload ${i}`);
    assert.equal((await u.replace(c.id, 1)).status, 429);
    assert.equal((await u.agent.post(`/api/habits/${u.habit.id}/checkins`).send({ checkin_date: daysAgo(1) })).status, 201);
    // Other users have their own budget.
    const other = await setup('upload_other');
    assert.equal((await other.upload(daysAgo(0), 1)).status, 201);
  });
});

describe('error handler: only the app\'s own 5xx messages reach the client', () => {
  const { errorHandler } = require('../src/middleware/errorHandler');
  const { HttpError } = require('../src/utils/httpError');
  const respond = (err) => {
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    errorHandler(err, {}, res, () => {});
    return res;
  };

  test('an HttpError 507 keeps its status and message', () => {
    const res = respond(new HttpError(507, 'storage is full'));
    assert.deepEqual([res.statusCode, res.body], [507, { error: 'storage is full' }]);
  });

  test('any other 5xx, even one marked "expose", becomes a generic 500', (t) => {
    t.mock.method(console, 'error', () => {});
    const foreign = Object.assign(new Error('SQLITE_FULL at /srv/db.sqlite'), { status: 503, expose: true });
    const res = respond(foreign);
    assert.deepEqual([res.statusCode, res.body], [500, { error: 'Internal server error' }]);
  });
});

describe('JSON check-ins on measurable habits (frontend path without a photo)', () => {
  test('amount is stored as sent, and defaults to the target when omitted', async () => {
    await createUser('measured_json');
    const agent = await loginAs(app, 'measured_json');
    const habit = (await agent.post('/api/habits').send({ title: 'Water', category: 'health', target_count: 8, unit: 'glasses' })).body.habit;
    const url = `/api/habits/${habit.id}/checkins`;

    const partial = await agent.post(url).send({ checkin_date: daysAgo(0), note: 'half way', amount: 5 });
    assert.equal(partial.status, 201);
    assert.equal(partial.body.checkin.amount, 5);
    assert.equal(partial.body.checkin.note, 'half way');

    const full = await agent.post(url).send({ checkin_date: daysAgo(1) });
    assert.equal(full.status, 201);
    assert.equal(full.body.checkin.amount, 8);
    assert.equal((await db.get('SELECT amount FROM checkins WHERE id = ?', [partial.body.checkin.id])).amount, 5);
  });
});
