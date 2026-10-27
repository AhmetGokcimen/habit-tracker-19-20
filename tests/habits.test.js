'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, db, createUser, loginAs } = require('./helpers');

const app = createApp();
let alice, bob, admin;
let alicePrivate, alicePublic;

before(async () => {
  await createUser('alice');
  await createUser('bob');
  await createUser('root', 'admin');
  alice = await loginAs(app, 'alice');
  bob = await loginAs(app, 'bob');
  admin = await loginAs(app, 'root');

  alicePrivate = (await alice.post('/api/habits').send({ title: 'Secret diary', category: 'mindfulness' })).body.habit;
  alicePublic = (await alice.post('/api/habits')
    .send({ title: 'Morning run', description: '5 km every day', category: 'fitness', is_public: true })).body.habit;
});

describe('F4 — habit CRUD', () => {
  test('create stores the habit for the logged-in user with safe defaults', async () => {
    assert.equal(alicePrivate.is_public, false);
    assert.equal(alicePrivate.owner.username, 'alice');
    assert.equal(alicePrivate.description, '');
    assert.equal('email' in alicePrivate.owner, false);
  });

  test('create validates input on the server and rejects unknown fields', async () => {
    const cases = [
      { title: '   ', category: 'health' },
      { title: 'x'.repeat(101), category: 'health' },
      { title: 'Ok', category: 'hacking' },
      { title: 'Ok', category: 'health', is_public: 'yes' },
      { title: 'Ok', category: 'health', user_id: 1 },
    ];
    for (const body of cases) {
      const res = await bob.post('/api/habits').send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test('owner can update and delete their own habit', async () => {
    const created = (await bob.post('/api/habits').send({ title: 'Read', category: 'learning' })).body.habit;
    const updated = await bob.patch(`/api/habits/${created.id}`).send({ title: 'Read 20 pages', is_public: true });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.habit.title, 'Read 20 pages');
    assert.equal(updated.body.habit.is_public, true);

    assert.equal((await bob.delete(`/api/habits/${created.id}`)).status, 204);
    assert.equal((await bob.get(`/api/habits/${created.id}`)).status, 404);
  });

  test('requests without a session are rejected with 401', async () => {
    const anon = request(app);
    assert.equal((await anon.get('/api/habits')).status, 401);
    assert.equal((await anon.get(`/api/habits/${alicePublic.id}`)).status, 401);
    assert.equal((await anon.get('/api/habits/mine')).status, 401);
  });

  test('malformed ids return 404 instead of reaching the database', async () => {
    for (const id of ['0', '-1', 'abc', '1 OR 1=1', '1.0']) {
      assert.equal((await alice.get(`/api/habits/${encodeURIComponent(id)}`)).status, 404, id);
    }
  });
});

describe('access control on habits (IDOR)', () => {
  test("user B cannot edit user A's habit by changing the id (403, record unchanged)", async () => {
    const res = await bob.patch(`/api/habits/${alicePublic.id}`).send({ title: 'pwned' });
    assert.equal(res.status, 403);
    const row = await db.get('SELECT title FROM habits WHERE id = ?', [alicePublic.id]);
    assert.equal(row.title, 'Morning run');
  });

  test("user B cannot delete user A's habit (403, record still exists)", async () => {
    assert.equal((await bob.delete(`/api/habits/${alicePublic.id}`)).status, 403);
    assert.ok(await db.get('SELECT 1 FROM habits WHERE id = ?', [alicePublic.id]));
  });

  test("user B cannot read user A's private habit; public ones are readable", async () => {
    assert.equal((await bob.get(`/api/habits/${alicePrivate.id}`)).status, 403);
    assert.equal((await bob.get(`/api/habits/${alicePublic.id}`)).status, 200);
  });

  test("/mine only ever returns the caller's own habits", async () => {
    const res = await bob.get('/api/habits/mine');
    assert.equal(res.status, 200);
    assert.ok(res.body.habits.every((h) => h.owner.username === 'bob'));
    assert.ok(res.body.habits.every((h) => Array.isArray(h.recent_checkins)));
  });

  test("admin can delete any habit (with its check-ins and comments) but cannot edit it", async () => {
    const victim = (await alice.post('/api/habits').send({ title: 'Temp', category: 'other', is_public: true })).body.habit;
    await db.run('INSERT INTO comments (habit_id, user_id, body) VALUES (?, ?, ?)', [victim.id, 2, 'nice']);
    await db.run("INSERT INTO checkins (habit_id, user_id, checkin_date) VALUES (?, ?, '2026-01-01')", [victim.id, victim.owner.id]);

    assert.equal((await admin.patch(`/api/habits/${victim.id}`).send({ title: 'admin edit' })).status, 403);
    assert.equal((await admin.delete(`/api/habits/${victim.id}`)).status, 204);
    assert.equal(await db.get('SELECT 1 FROM comments WHERE habit_id = ?', [victim.id]), undefined);
    assert.equal(await db.get('SELECT 1 FROM checkins WHERE habit_id = ?', [victim.id]), undefined);
  });
});

describe('F7 — search and filter', () => {
  before(async () => {
    await bob.post('/api/habits').send({ title: 'Drink water', category: 'health', is_public: true });
    await bob.post('/api/habits').send({ title: '100% focus', category: 'productivity', is_public: true });
    await bob.post('/api/habits').send({ title: 'Drink less coffee', category: 'health', is_public: false });
  });

  test('filters public habits by category and text; private habits never appear', async () => {
    const health = await alice.get('/api/habits?category=health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.habits.map((h) => h.title), ['Drink water']);

    const text = await alice.get('/api/habits?q=drink');
    assert.deepEqual(text.body.habits.map((h) => h.title), ['Drink water']);

    const all = await alice.get('/api/habits');
    assert.ok(all.body.habits.every((h) => h.is_public));
    assert.ok(!all.body.habits.some((h) => h.title === 'Secret diary'));
  });

  test('SQL injection payloads are treated as plain data', async () => {
    const countBefore = (await db.get('SELECT COUNT(*) AS n FROM habits')).n;

    const inText = await alice.get(`/api/habits?q=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(inText.status, 200);
    assert.equal(inText.body.habits.length, 0);

    const union = await alice.get(`/api/habits?q=${encodeURIComponent("' UNION SELECT password_hash FROM users --")}`);
    assert.equal(union.status, 200);
    assert.equal(union.body.habits.length, 0);

    const inCategory = await alice.get(`/api/habits?category=${encodeURIComponent("health' OR '1'='1")}`);
    assert.equal(inCategory.status, 400);

    assert.equal((await db.get('SELECT COUNT(*) AS n FROM habits')).n, countBefore);
  });

  test('LIKE wildcards are matched literally and bad query params are rejected', async () => {
    const percent = await alice.get(`/api/habits?q=${encodeURIComponent('%')}`);
    assert.deepEqual(percent.body.habits.map((h) => h.title), ['100% focus']);

    assert.equal((await alice.get('/api/habits?q=a&q=b')).status, 400);
    assert.equal((await alice.get('/api/habits?page=-1')).status, 400);
    assert.equal((await alice.get('/api/habits?sort=password')).status, 400);
  });  
  test('filters public habits by frequency', async () => {
    // Daily habits should appear in daily search results.
    const daily = await alice.get('/api/habits?q=Drink&frequency=daily');

    assert.equal(daily.status, 200);
    assert.deepEqual(
      daily.body.habits.map((h) => h.title),
      ['Drink water']
    );

    // Daily habits should not appear in weekly search results.
    const weekly = await alice.get('/api/habits?q=Drink&frequency=weekly');

    assert.equal(weekly.status, 200);
    assert.deepEqual(weekly.body.habits, []);

    // Invalid frequency values must be rejected.
    const invalid = await alice.get('/api/habits?frequency=invalid');

    assert.equal(invalid.status, 400);
  }); 
  test('filters public habits by goal type', async () => {
    // Create a measurable habit.
    const created = await bob.post('/api/habits').send({
      title: 'Eight glasses of water',
      category: 'health',
      is_public: true,
      target_count: 8,
      unit: 'glasses',
    });

    assert.equal(created.status, 201);

    // Measurable habits should appear in measurable results.
    const measurable = await alice.get('/api/habits?q=Eight%20glasses%20of%20water&goal_type=measurable');

    assert.equal(measurable.status, 200);
    assert.deepEqual(
      measurable.body.habits.map((h) => h.title),
      ['Eight glasses of water']
    );

    // Measurable habits must not appear as simple check-ins.
    const notSimple = await alice.get('/api/habits?q=Eight%20glasses%20of%20water&goal_type=simple');

    assert.equal(notSimple.status, 200);
    assert.deepEqual(notSimple.body.habits, []);

    // Simple habits should appear in simple results.
    const simple = await alice.get('/api/habits?q=Drink%20water&goal_type=simple');

    assert.equal(simple.status, 200);
    assert.deepEqual(
      simple.body.habits.map((h) => h.title),
      ['Drink water']
    );

    // Invalid goal types must be rejected.
    const invalid = await alice.get('/api/habits?goal_type=invalid');

    assert.equal(invalid.status, 400);
  });  
  test('sorts public habits by date and engagement', async () => {
    const sortOptions = [
      'newest',
      'oldest',
      'popular',
      'discussed',
    ];

    for (const sort of sortOptions) {
      const response = await alice.get(`/api/habits?sort=${sort}`);

      assert.equal(response.status, 200);

      const habits = response.body.habits;
      assert.ok(habits.length >= 2);

      const compareNewest = (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id - a.id;

      const compareOldest = (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id - b.id;

      const comparePopular = (a, b) =>
        b.reaction_count - a.reaction_count || compareNewest(a, b);

      const compareDiscussed = (a, b) =>
        b.comment_count - a.comment_count || compareNewest(a, b);

      const comparators = {
        newest: compareNewest,
        oldest: compareOldest,
        popular: comparePopular,
        discussed: compareDiscussed,
      };

      const expected = [...habits].sort(comparators[sort]);

      assert.deepEqual(
        habits.map((h) => h.id),
        expected.map((h) => h.id),
        `Incorrect sorting for ${sort}`
      );
    }
  });
});

describe('F4 — reminder times', () => {
  test('reminder time is validated and stored', async () => {
    const res = await alice.post('/api/habits').send({ title: 'Vitamins', category: 'health', reminder_time: '08:30' });
    assert.equal(res.status, 201);
    assert.equal(res.body.habit.reminder_time, '08:30');
    for (const bad of ['8:30', '24:00', '12:60', '08:30:00', '08:30 ', 'noon', 830]) {
      const r = await alice.post('/api/habits').send({ title: 'X', category: 'health', reminder_time: bad });
      assert.equal(r.status, 400, String(bad));
    }
    const cleared = await alice.patch(`/api/habits/${res.body.habit.id}`).send({ reminder_time: null });
    assert.equal(cleared.body.habit.reminder_time, null);
  });

  test('reminder time is private: other users and search results never see it', async () => {
    const h = (await alice.post('/api/habits').send({ title: 'Daily sketch', category: 'other', is_public: true, reminder_time: '21:15' })).body.habit;
    const asBob = await bob.get(`/api/habits/${h.id}`);
    assert.equal('reminder_time' in asBob.body.habit, false);
    const search = await bob.get('/api/habits?q=Daily%20sketch');
    assert.ok(search.body.habits.length >= 1);
    assert.ok(search.body.habits.every((x) => !('reminder_time' in x)));
    const asAdmin = await admin.get(`/api/habits/${h.id}`);
    assert.equal('reminder_time' in asAdmin.body.habit, false);
    assert.equal((await alice.get(`/api/habits/${h.id}`)).body.habit.reminder_time, '21:15');
  });
});

describe('F9 — archive and order', () => {
  test('archived habits leave /mine and Explore, keep their data, and take no new check-ins', async () => {
    const h = (await alice.post('/api/habits').send({ title: 'Archive me please', category: 'other', is_public: true })).body.habit;
    const today = new Date().toISOString().slice(0, 10);
    await alice.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: '2026-01-05' });

    const res = await alice.patch(`/api/habits/${h.id}`).send({ archived: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.habit.archived, true);

    assert.ok(!(await alice.get('/api/habits/mine')).body.habits.some((x) => x.id === h.id));
    assert.ok((await alice.get('/api/habits/mine?archived=1')).body.habits.some((x) => x.id === h.id));
    assert.equal((await bob.get('/api/habits?q=Archive%20me')).body.habits.length, 0);
    assert.equal((await alice.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: today })).status, 403);
    assert.equal((await alice.get(`/api/habits/${h.id}/checkins`)).body.checkins.length, 1);

    // Only the owner can archive; restoring brings it back.
    assert.equal((await bob.patch(`/api/habits/${h.id}`).send({ archived: false })).status, 403);
    assert.equal((await alice.patch(`/api/habits/${h.id}`).send({ archived: false })).body.habit.archived, false);
    assert.equal((await alice.get('/api/habits/mine?archived=yes')).status, 400);
  });

  test('order takes exactly the caller\'s active habits and nothing else', async () => {
    await createUser('sorter');
    const sorter = await loginAs(app, 'sorter');
    const ids = [];
    for (const t of ['A', 'B', 'C']) ids.push((await sorter.post('/api/habits').send({ title: t, category: 'other' })).body.habit.id);
    // Newest first by default.
    assert.deepEqual((await sorter.get('/api/habits/mine')).body.habits.map((h) => h.title), ['C', 'B', 'A']);

    assert.equal((await sorter.put('/api/habits/order').send({ ids })).status, 204);
    assert.deepEqual((await sorter.get('/api/habits/mine')).body.habits.map((h) => h.title), ['A', 'B', 'C']);

    const foreign = alicePublic.id;
    const bad = [
      { ids: [ids[0], ids[1]] },
      { ids: [...ids, foreign] },
      { ids: [ids[0], ids[1], foreign] },
      { ids: [ids[0], ids[0], ids[1]] },
      { ids: [] },
      { ids: ['1', '2', '3'] },
      { ids, user_id: 1 },
    ];
    for (const body of bad) {
      assert.equal((await sorter.put('/api/habits/order').send(body)).status, 400, JSON.stringify(body));
    }
    // Alice's habit was never moved.
    assert.equal((await db.get('SELECT position FROM habits WHERE id = ?', [foreign])).position <= 0, true);
  });
});

describe('F14 — copy a shared habit', () => {
  test('copies settings only, as a private habit of the caller', async () => {
    const src = (await alice.post('/api/habits').send({
      title: 'Water', category: 'health', is_public: true, target_count: 8, unit: 'glasses',
      schedule: { type: 'weekdays', days: [1, 2, 3] }, reminder_time: '07:00',
    })).body.habit;
    await alice.post(`/api/habits/${src.id}/checkins`).send({ checkin_date: new Date().toISOString().slice(0, 10), note: 'alice only' });
    await bob.post(`/api/habits/${src.id}/comments`).send({ body: 'nice' });

    const res = await bob.post(`/api/habits/${src.id}/copy`);
    assert.equal(res.status, 201);
    const copy = res.body.habit;
    assert.equal(copy.owner.username, 'bob');
    assert.equal(copy.is_public, false);
    assert.deepEqual([copy.title, copy.target_count, copy.unit], ['Water', 8, 'glasses']);
    assert.deepEqual(copy.schedule, { type: 'weekdays', days: [1, 2, 3] });
    assert.equal(copy.reminder_time, null);
    assert.equal((await bob.get(`/api/habits/${copy.id}/checkins`)).body.checkins.length, 0);
    assert.equal((await bob.get(`/api/habits/${copy.id}/comments`)).body.comments.length, 0);
  });

  test('private, own and archived habits cannot be copied', async () => {
    assert.equal((await bob.post(`/api/habits/${alicePrivate.id}/copy`)).status, 403);
    assert.equal((await alice.post(`/api/habits/${alicePublic.id}/copy`)).status, 403);
    const arch = (await alice.post('/api/habits').send({ title: 'Old', category: 'other', is_public: true })).body.habit;
    await alice.patch(`/api/habits/${arch.id}`).send({ archived: true });
    assert.equal((await bob.post(`/api/habits/${arch.id}/copy`)).status, 403);
    assert.equal((await bob.raw.post(`/api/habits/${alicePublic.id}/copy`)).status, 403); // CSRF header
  });

  test('a user can keep at most 100 habits, even with parallel requests', async () => {
    await createUser('hoarder2');
    const h = await loginAs(app, 'hoarder2');
    const uid = (await db.get("SELECT id FROM users WHERE username = 'hoarder2'")).id;
    await db.batch(Array.from({ length: 95 }, (_, i) => ['INSERT INTO habits (user_id, title, category) VALUES (?, ?, ?)', [uid, `H${i}`, 'other']]));
    const results = await Promise.all(Array.from({ length: 10 }, () => h.post('/api/habits').send({ title: 'More', category: 'other' })));
    assert.equal(results.filter((r) => r.status === 201).length, 5);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal((await h.post(`/api/habits/${alicePublic.id}/copy`)).status, 409);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM habits WHERE user_id = ?', [uid])).n, 100);
  });
});
