'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, db, createUser, loginAs } = require('./helpers');
const { detectImageType } = require('../src/middleware/upload');

const app = createApp();
let alice, bob, admin;
let aliceUserId, alicePublicHabit, alicePrivateHabit, aliceCheckin;

// Minimal byte sequences that start with the real format signatures.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2), Buffer.from([0xff, 0xd9])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 3)]);

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

before(async () => {
  aliceUserId = await createUser('alice');
  await createUser('bob');
  await createUser('root', 'admin');
  alice = await loginAs(app, 'alice');
  bob = await loginAs(app, 'bob');
  admin = await loginAs(app, 'root');

  alicePublicHabit = (await alice.post('/api/habits').send({ title: 'Run', category: 'fitness', is_public: true })).body.habit;
  alicePrivateHabit = (await alice.post('/api/habits').send({ title: 'Therapy', category: 'health' })).body.habit;
  aliceCheckin = (await alice.post(`/api/habits/${alicePublicHabit.id}/checkins`)
    .field('checkin_date', daysAgo(1))
    .field('note', 'felt great')
    .attach('photo', PNG, { filename: 'proof.png', contentType: 'image/png' })).body.checkin;
});

describe('F5 — check-ins (private data)', () => {
  test('owner can create, read, update and list check-ins', async () => {
    assert.equal(aliceCheckin.has_photo, true);
    assert.equal(aliceCheckin.note, 'felt great');

    const created = await alice.post(`/api/habits/${alicePrivateHabit.id}/checkins`).send({ checkin_date: today() });
    assert.equal(created.status, 201);
    assert.equal(created.body.checkin.has_photo, false);

    const updated = await alice.patch(`/api/checkins/${created.body.checkin.id}`).send({ note: 'short session' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.checkin.note, 'short session');

    const list = await alice.get(`/api/habits/${alicePrivateHabit.id}/checkins`);
    assert.equal(list.status, 200);
    assert.equal(list.body.checkins.length, 1);
    assert.equal('photo_data' in list.body.checkins[0], false);
  });

  test('only one check-in per habit per day — enforced by the database, not just the app', async () => {
    const dup = await alice.post(`/api/habits/${alicePublicHabit.id}/checkins`).send({ checkin_date: daysAgo(1) });
    assert.equal(dup.status, 409);

    // Bypassing the application entirely still fails on the UNIQUE constraint.
    await assert.rejects(
      db.run('INSERT INTO checkins (habit_id, user_id, checkin_date) VALUES (?, ?, ?)', [
        alicePublicHabit.id, aliceUserId, daysAgo(1),
      ]),
      /UNIQUE/,
    );
  });

  test('dates and notes are validated on the server', async () => {
    const url = `/api/habits/${alicePublicHabit.id}/checkins`;
    for (const checkin_date of ['2026-02-30', '20-01-2026', '2999-01-01', '1999-12-31', "2026-01-01' OR 1=1"]) {
      assert.equal((await alice.post(url).send({ checkin_date })).status, 400, checkin_date);
    }
    for (const note of ['x'.repeat(501), 'bad\u0000byte', 'spoof‮txt.exe']) {
      assert.equal((await alice.post(url).send({ checkin_date: daysAgo(5), note })).status, 400);
    }
    assert.equal((await alice.post(url).send({ checkin_date: daysAgo(5), user_id: 99 })).status, 400);
  });

  test('HTML in a note is stored as plain text and only ever returned as JSON', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const res = await alice.post(`/api/habits/${alicePublicHabit.id}/checkins`)
      .send({ checkin_date: daysAgo(7), note: payload });
    assert.equal(res.status, 201);
    assert.equal(res.body.checkin.note, payload);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});

describe('access control on check-ins (IDOR)', () => {
  test("Bob cannot view Alice's check-in, its photo, or the habit's check-in history (403)", async () => {
    assert.equal((await bob.get(`/api/checkins/${aliceCheckin.id}`)).status, 403);
    assert.equal((await bob.get(`/api/checkins/${aliceCheckin.id}/photo`)).status, 403);
    // Even though the habit itself is public, its check-ins are private.
    assert.equal((await bob.get(`/api/habits/${alicePublicHabit.id}`)).status, 200);
    assert.equal((await bob.get(`/api/habits/${alicePublicHabit.id}/checkins`)).status, 403);
  });

  test("Bob cannot delete or edit Alice's check-in or replace its photo (403, data unchanged)", async () => {
    assert.equal((await bob.delete(`/api/checkins/${aliceCheckin.id}`)).status, 403);
    assert.equal((await bob.patch(`/api/checkins/${aliceCheckin.id}`).send({ note: 'hacked' })).status, 403);
    assert.equal((await bob.delete(`/api/checkins/${aliceCheckin.id}/photo`)).status, 403);
    const replace = await bob.put(`/api/checkins/${aliceCheckin.id}/photo`)
      .attach('photo', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });
    assert.equal(replace.status, 403);

    const row = await db.get('SELECT note, photo_mime FROM checkins WHERE id = ?', [aliceCheckin.id]);
    assert.deepEqual({ ...row }, { note: 'felt great', photo_mime: 'image/png' });
  });

  test("Bob cannot add a check-in to Alice's habit — rejected by the API and by the database", async () => {
    const before = (await db.get('SELECT COUNT(*) AS n FROM checkins')).n;
    const res = await bob.post(`/api/habits/${alicePublicHabit.id}/checkins`).send({ checkin_date: daysAgo(3) });
    assert.equal(res.status, 403);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM checkins')).n, before);

    const bobId = (await db.get("SELECT id FROM users WHERE username = 'bob'")).id;
    await assert.rejects(
      db.run('INSERT INTO checkins (habit_id, user_id, checkin_date) VALUES (?, ?, ?)', [alicePublicHabit.id, bobId, daysAgo(3)]),
      /owner must match/,
    );
  });

  test('admin can view and delete any check-in but cannot create or edit one', async () => {
    const extra = (await alice.post(`/api/habits/${alicePrivateHabit.id}/checkins`).send({ checkin_date: daysAgo(10) })).body.checkin;
    assert.equal((await admin.get(`/api/habits/${alicePrivateHabit.id}/checkins`)).status, 200);
    assert.equal((await admin.get(`/api/checkins/${extra.id}`)).status, 200);
    assert.equal((await admin.patch(`/api/checkins/${extra.id}`).send({ note: 'x' })).status, 403);
    assert.equal((await admin.post(`/api/habits/${alicePrivateHabit.id}/checkins`).send({ checkin_date: daysAgo(11) })).status, 403);
    assert.equal((await admin.delete(`/api/checkins/${extra.id}`)).status, 204);
  });

  test('anonymous requests get 401', async () => {
    assert.equal((await request(app).get(`/api/checkins/${aliceCheckin.id}/photo`)).status, 401);
  });
});

describe('F8 — photo upload', () => {
  test('type is detected from the bytes, not from the name or Content-Type', () => {
    assert.equal(detectImageType(PNG).mime, 'image/png');
    assert.equal(detectImageType(JPEG).mime, 'image/jpeg');
    assert.equal(detectImageType(WEBP).mime, 'image/webp');
    assert.equal(detectImageType(Buffer.from('<?php echo 1; ?>')), null);
    assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(detectImageType(Buffer.alloc(0)), null);
  });

  test('a .jpg / image/jpeg upload whose content is PHP, HTML or SVG is rejected (415)', async () => {
    const before = (await db.get('SELECT COUNT(*) AS n FROM checkins')).n;
    const fakes = [
      ['shell.jpg', '<?php system($_GET["c"]); ?>'],
      ['page.jpg', '<html><script>alert(document.cookie)</script></html>'],
      ['vector.png', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ];
    for (const [i, [filename, content]] of fakes.entries()) {
      const res = await alice.post(`/api/habits/${alicePrivateHabit.id}/checkins`)
        .field('checkin_date', daysAgo(20 + i))
        .attach('photo', Buffer.from(content), { filename, contentType: 'image/jpeg' });
      assert.equal(res.status, 415, filename);
    }
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM checkins')).n, before);
  });

  test('files over 1 MB, extra files and unexpected field names are rejected', async () => {
    const url = `/api/habits/${alicePrivateHabit.id}/checkins`;
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    const tooBig = await alice.post(url).field('checkin_date', daysAgo(30)).attach('photo', big, 'big.png');
    assert.equal(tooBig.status, 413);

    const wrongField = await alice.post(url).field('checkin_date', daysAgo(31)).attach('avatar', PNG, 'a.png');
    assert.equal(wrongField.status, 400);

    const twoFiles = await alice.post(url).field('checkin_date', daysAgo(32))
      .attach('photo', PNG, 'a.png').attach('photo', PNG, 'b.png');
    assert.equal(twoFiles.status, 400);
  });

  test('photo is served with a fixed type, nosniff, inline disposition and a server-made filename', async () => {
    const traversal = await alice.post(`/api/habits/${alicePrivateHabit.id}/checkins`)
      .field('checkin_date', daysAgo(2)) // photos are accepted only for recent days
      .attach('photo', JPEG, { filename: '../../../etc/passwd.jpg', contentType: 'text/html' });
    assert.equal(traversal.status, 201);

    const res = await alice.get(traversal.body.checkin.photo_url).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-disposition'], `inline; filename="checkin-${traversal.body.checkin.id}.jpg"`);
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.ok(Buffer.compare(res.body, JPEG) === 0);
  });
});

describe('F7 — back-filling and undo', () => {
  test('/mine exposes today\'s check-in id only to the owner, and undo deletes it', async () => {
    await createUser('undoer');
    await createUser('peeker');
    const me = await loginAs(app, 'undoer');
    const peeker = await loginAs(app, 'peeker');
    const h = (await me.post('/api/habits').send({ title: 'Plank', category: 'fitness', is_public: true })).body.habit;
    const today = new Date().toISOString().slice(0, 10);
    const created = (await me.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: today })).body.checkin;

    const mine = (await me.get('/api/habits/mine')).body.habits.find((x) => x.id === h.id);
    assert.deepEqual(mine.latest_checkins, [{ id: created.id, checkin_date: today, amount: 1 }]);

    // Another user can neither see nor delete it.
    assert.equal('latest_checkins' in (await peeker.get(`/api/habits/${h.id}`)).body.habit, false);
    assert.equal((await peeker.delete(`/api/checkins/${created.id}`)).status, 403);

    assert.equal((await me.delete(`/api/checkins/${created.id}`)).status, 204);
    const after = (await me.get('/api/habits/mine')).body.habits.find((x) => x.id === h.id);
    assert.deepEqual(after.latest_checkins, []);
  });
});

describe('F8 — measurable habits', () => {
  const today = () => new Date().toISOString().slice(0, 10);
  let owner;
  let water;

  before(async () => {
    await createUser('drinker');
    owner = await loginAs(app, 'drinker');
    water = (await owner.post('/api/habits').send({ title: 'Water', category: 'health', target_count: 8, unit: 'glasses' })).body.habit;
  });

  test('target and unit are validated and stored', async () => {
    assert.equal(water.target_count, 8);
    assert.equal(water.unit, 'glasses');
    for (const body of [{ target_count: 0 }, { target_count: 1001 }, { target_count: 2.5 }, { target_count: '8' }, { unit: 'x'.repeat(21) }]) {
      const res = await owner.post('/api/habits').send({ title: 'T', category: 'health', ...body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test('progress adds up atomically, counts as done only at the target, and 0 removes the day', async () => {
    const step = (delta) => owner.post(`/api/habits/${water.id}/checkins/progress`).send({ checkin_date: today(), delta });
    // Parallel +1 taps must all be counted.
    await Promise.all(Array.from({ length: 5 }, () => step(1)));
    let mine = (await owner.get('/api/habits/mine')).body.habits.find((h) => h.id === water.id);
    assert.equal(mine.latest_checkins.find((c) => c.checkin_date === today()).amount, 5);
    assert.equal(mine.recent_checkins.includes(today()), false); // 5 of 8: not done

    await Promise.all(Array.from({ length: 5 }, () => step(1)));
    mine = (await owner.get('/api/habits/mine')).body.habits.find((h) => h.id === water.id);
    assert.equal(mine.recent_checkins.includes(today()), true);
    assert.equal(mine.streak.current, 1);

    const down = await step(-1000);
    assert.equal(down.status, 200);
    assert.equal(down.body.checkin, null);
  });

  test('progress is validated and owner-only', async () => {
    await createUser('sipper');
    const other = await loginAs(app, 'sipper');
    for (const body of [{ checkin_date: today(), delta: 0 }, { checkin_date: today(), delta: 1001 }, { checkin_date: today(), delta: '1' }, { checkin_date: today() }, { checkin_date: today(), delta: 1, amount: 5 }]) {
      assert.equal((await owner.post(`/api/habits/${water.id}/checkins/progress`).send(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await other.post(`/api/habits/${water.id}/checkins/progress`).send({ checkin_date: today(), delta: 1 })).status, 403);
  });

  test('a plain check-in on a measurable habit is a full one; raising the target keeps old days complete', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const full = await owner.post(`/api/habits/${water.id}/checkins`).send({ checkin_date: yesterday });
    assert.equal(full.body.checkin.amount, 8);
    for (const amount of [true, '1e3', ' 3', -1, 0]) {
      const res = await owner.post(`/api/habits/${water.id}/checkins`).send({ checkin_date: '2026-01-01', amount });
      assert.equal(res.status, 400, String(amount));
    }

    await owner.patch(`/api/habits/${water.id}`).send({ target_count: 10 });
    const list = (await owner.get(`/api/habits/${water.id}/checkins`)).body;
    assert.equal(list.checkins.find((c) => c.checkin_date === yesterday).amount, 10);
    assert.ok(list.streak.current >= 1);
  });
});
