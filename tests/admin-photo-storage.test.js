'use strict';

// GET /api/admin/photo-storage: service-wide proof-photo usage and the
// accounts storing the most. Admin-only.

// Round limits so the percentages are easy to check.
require('./env').testEnv({ PHOTO_QUOTA_MB: '1', PHOTO_TOTAL_CAP_MB: '10' });

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, db, createUser, loginAs, wrap } = require('./helpers');

const app = createApp();
const URL = '/api/admin/photo-storage';
const KB = 1024;
const MB = 1024 * KB;

let adminId;
let admin;
let user;

// Stores photos of the given sizes for a user, straight in the database
// (bypassing the upload route keeps the test about this endpoint only).
async function storePhotos(userId, sizes) {
  const { lastInsertRowid: habitId } = await db.run(
    "INSERT INTO habits (user_id, title, category) VALUES (?, 'Proof', 'health')",
    [userId],
  );
  for (const [i, size] of sizes.entries()) {
    await db.run(
      "INSERT INTO checkins (habit_id, user_id, checkin_date, photo_data, photo_mime) VALUES (?, ?, ?, ?, 'image/png')",
      [habitId, userId, `2026-01-${String(i + 1).padStart(2, '0')}`, Buffer.alloc(size, 1)],
    );
  }
}

before(async () => {
  adminId = await createUser('store_admin', 'admin');
  await createUser('store_user');
  await createUser('second_admin', 'admin');
  admin = await loginAs(app, 'store_admin');
  user = await loginAs(app, 'store_user');
});

describe('photo storage report: who may see it', () => {
  test('anonymous gets 401 and a normal user gets 403, with no storage data in the body', async () => {
    const anon = await wrap(request(app)).get(URL);
    assert.equal(anon.status, 401);
    const denied = await user.get(URL);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.storage, undefined);
    assert.equal(denied.body.top_users, undefined);
  });

  test('the role is read from the database: a demoted admin loses access at once', async () => {
    const other = await loginAs(app, 'second_admin');
    assert.equal((await other.get(URL)).status, 200);
    await db.run("UPDATE users SET role = 'user' WHERE username = 'second_admin'");
    assert.equal((await other.get(URL)).status, 403);
  });

  test('it counts against the heavy-reads budget', async () => {
    const res = await admin.get(URL);
    assert.equal(res.status, 200);
    assert.equal(res.headers['ratelimit-policy'], '300;w=600');
  });
});

describe('photo storage report: content', () => {
  test('with no photos: nothing used, no accounts listed', async () => {
    const res = await admin.get(URL);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      storage: { used_bytes: 0, cap_bytes: 10 * MB, used_percent: 0, per_user_quota_bytes: 1 * MB },
      top_users: [],
    });
  });

  test('total and percentage come from the photo_storage counter; the 10 biggest accounts are listed, largest first', async () => {
    // 12 accounts with photos (100 KB .. 1200 KB in total), one without.
    const ids = [];
    for (let i = 1; i <= 12; i++) {
      const id = await createUser(`photos_${i}`);
      ids.push(id);
      await storePhotos(id, [i * 50 * KB, i * 50 * KB]);
    }
    await createUser('no_photos');

    const res = await admin.get(URL);
    assert.equal(res.status, 200);
    const { storage, top_users: top } = res.body;

    const counter = (await db.get('SELECT bytes FROM photo_storage WHERE id = 1')).bytes;
    const expectedTotal = 78 * 100 * KB; // (1 + ... + 12) * 100 KB
    assert.equal(counter, expectedTotal);
    assert.equal(storage.used_bytes, expectedTotal);
    assert.equal(storage.cap_bytes, 10 * MB);
    assert.equal(storage.used_percent, 76.2); // 7800 KB of 10240 KB
    assert.equal(storage.per_user_quota_bytes, 1 * MB);

    assert.equal(top.length, 10);
    assert.deepEqual(top.map((u) => u.username), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((i) => `photos_${i}`));
    assert.deepEqual(top[0], {
      id: ids[11],
      username: 'photos_12',
      photo_count: 2,
      photo_bytes: 1200 * KB,
      quota_percent: 117.2, // seeded past the quota on purpose
    });
    assert.equal(top[9].quota_percent, 29.3); // 300 KB of 1024 KB
    assert.ok(!top.some((u) => u.username === 'no_photos'));
  });

  test('only what the panel needs: no email, password hash or photo bytes', async () => {
    const res = await admin.get(URL);
    for (const u of res.body.top_users) {
      assert.deepEqual(Object.keys(u).sort(), ['id', 'photo_bytes', 'photo_count', 'quota_percent', 'username']);
    }
    assert.doesNotMatch(JSON.stringify(res.body), /@example\.test|password|hash|\$2[aby]\$/i);
  });

  test('a full counter reports 100% (the value the upload cap is checked against)', async (t) => {
    const real = (await db.get('SELECT bytes FROM photo_storage WHERE id = 1')).bytes;
    t.after(() => db.run('UPDATE photo_storage SET bytes = ? WHERE id = 1', [real]));
    await db.run('UPDATE photo_storage SET bytes = ? WHERE id = 1', [10 * MB]);
    const res = await admin.get(URL);
    assert.equal(res.body.storage.used_bytes, 10 * MB);
    assert.equal(res.body.storage.used_percent, 100);
  });

  test('photos of a deleted account disappear from the report and the total', async () => {
    const before = (await admin.get(URL)).body;
    const target = before.top_users[0];
    assert.equal((await admin.delete(`/api/admin/users/${target.id}`)).status, 204);
    const after = (await admin.get(URL)).body;
    assert.ok(!after.top_users.some((u) => u.id === target.id));
    assert.equal(after.storage.used_bytes, before.storage.used_bytes - target.photo_bytes);
    assert.notEqual(target.id, adminId);
  });
});
