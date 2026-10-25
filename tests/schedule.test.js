'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, createUser, loginAs } = require('./helpers');
const schedule = require('../src/services/schedule');

const app = createApp();
let alice, bob, admin;

const DAILY = { frequency: 'daily', days_mask: 127, weekly_target: 7 };
const day = (iso) => schedule.dayNumber(iso);

before(async () => {
  await createUser('alice');
  await createUser('bob');
  await createUser('root', 'admin');
  alice = await loginAs(app, 'alice');
  bob = await loginAs(app, 'bob');
  admin = await loginAs(app, 'root');
});

describe('streak rules (services/schedule.js)', () => {
  test('daily: consecutive days; today is still open; a missed day breaks the run', () => {
    const today = day('2026-03-12');
    assert.deepEqual(schedule.streaks(DAILY, ['2026-03-09', '2026-03-10', '2026-03-11'], [], today), { current: 3, longest: 3, unit: 'days' });
    assert.equal(schedule.streaks(DAILY, ['2026-03-09', '2026-03-10'], [], today).current, 0);
    assert.equal(schedule.streaks(DAILY, ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-11'], [], today).longest, 3);
    assert.deepEqual(schedule.streaks(DAILY, [], [], today), { current: 0, longest: 0, unit: 'days' });
  });

  test('weekdays: days that are not due do not break the run', () => {
    // Mon/Wed/Fri. 2026-03-02 is a Monday.
    const row = { ...schedule.toColumns({ type: 'weekdays', days: [1, 3, 5] }) };
    const s = schedule.streaks(row, ['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-09'], [], day('2026-03-10'));
    assert.equal(s.current, 4);
    // Missing Wednesday 03-11 breaks it once Thursday comes.
    assert.equal(schedule.streaks(row, ['2026-03-09'], [], day('2026-03-12')).current, 0);
  });

  test('weekly: weeks that reached the target; the current week is still open', () => {
    const row = schedule.toColumns({ type: 'weekly', times: 2 });
    const dates = ['2026-03-02', '2026-03-05', '2026-03-09', '2026-03-13', '2026-03-16'];
    assert.deepEqual(schedule.streaks(row, dates, [], day('2026-03-17')), { current: 2, longest: 2, unit: 'weeks' });
    // A week with only one completion breaks it.
    assert.equal(schedule.streaks(row, ['2026-03-02', '2026-03-05', '2026-03-09'], [], day('2026-03-17')).current, 0);
  });

  test('schedule columns round-trip', () => {
    for (const s of [{ type: 'daily' }, { type: 'weekdays', days: [2, 6, 7] }, { type: 'weekly', times: 3 }]) {
      assert.deepEqual(schedule.fromRow(schedule.toColumns(s)), s);
    }
  });
});

describe('F1 — habit schedules over the API', () => {
  test('habits default to daily and accept the three schedule shapes', async () => {
    const plain = await alice.post('/api/habits').send({ title: 'Floss', category: 'health' });
    assert.deepEqual(plain.body.habit.schedule, { type: 'daily' });

    const weekdays = await alice.post('/api/habits').send({ title: 'Gym', category: 'fitness', schedule: { type: 'weekdays', days: [1, 3, 5] } });
    assert.equal(weekdays.status, 201);
    assert.deepEqual(weekdays.body.habit.schedule, { type: 'weekdays', days: [1, 3, 5] });

    const weekly = await alice.patch(`/api/habits/${plain.body.habit.id}`).send({ schedule: { type: 'weekly', times: 3 } });
    assert.equal(weekly.status, 200);
    assert.deepEqual(weekly.body.habit.schedule, { type: 'weekly', times: 3 });
  });

  test('malformed schedules are rejected', async () => {
    const cases = [
      { type: 'monthly' },
      { type: 'weekdays', days: [] },
      { type: 'weekdays', days: [0] },
      { type: 'weekdays', days: [8] },
      { type: 'weekdays', days: [1, 1] },
      { type: 'weekdays', days: ['1'] },
      { type: 'weekdays', days: [1.5] },
      { type: 'weekly', times: 0 },
      { type: 'weekly', times: 7 },
      { type: 'daily', days: [1] },
      { type: 'daily', days_mask: 3 },
      'daily',
    ];
    for (const s of cases) {
      const res = await alice.post('/api/habits').send({ title: 'X', category: 'other', schedule: s });
      assert.equal(res.status, 400, JSON.stringify(s));
    }
    // Raw database columns cannot be set directly.
    const raw = await alice.post('/api/habits').send({ title: 'X', category: 'other', days_mask: 0 });
    assert.equal(raw.status, 400);
  });

  test('/mine returns server-computed streaks and this week\'s count', async () => {
    const h = (await alice.post('/api/habits').send({ title: 'Stretch', category: 'fitness' })).body.habit;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await alice.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: yesterday });
    await alice.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: today });

    const mine = (await alice.get('/api/habits/mine')).body.habits.find((x) => x.id === h.id);
    assert.deepEqual(mine.streak, { current: 2, longest: 2, unit: 'days' });
    assert.ok(mine.week_count >= 1);
  });

  test('streaks come from private check-ins: never on the public habit record', async () => {
    const h = (await alice.post('/api/habits').send({ title: 'Shared walk', category: 'fitness', is_public: true })).body.habit;
    await alice.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: new Date().toISOString().slice(0, 10) });

    const asBob = await bob.get(`/api/habits/${h.id}`);
    assert.equal(asBob.status, 200);
    assert.equal('streak' in asBob.body.habit, false);
    assert.equal((await bob.get(`/api/habits/${h.id}/checkins`)).status, 403);

    assert.equal((await alice.get(`/api/habits/${h.id}/checkins`)).body.streak.current, 1);
    assert.equal((await admin.get(`/api/habits/${h.id}/checkins`)).body.streak.current, 1);
  });
});

describe('F2 — streak freezes', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  test('a freeze keeps the streak alive across a missed day', () => {
    const today = schedule.todayNumber();
    const done = [schedule.isoDate(today - 3), schedule.isoDate(today - 1)];
    assert.equal(schedule.streaks(DAILY, done, [], today).current, 1);
    // The frozen day is kept but not counted.
    assert.equal(schedule.streaks(DAILY, done, [schedule.isoDate(today - 2)], today).current, 2);
  });

  test('owner can freeze a missed recent day; it shows in the streak', async () => {
    const h = (await bob.post('/api/habits').send({ title: 'Journal', category: 'mindfulness' })).body.habit;
    await bob.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: daysAgo(3) });
    await bob.post(`/api/habits/${h.id}/checkins`).send({ checkin_date: daysAgo(1) });

    const res = await bob.post(`/api/habits/${h.id}/freezes`).send({ freeze_date: daysAgo(2) });
    assert.equal(res.status, 201);
    const list = (await bob.get(`/api/habits/${h.id}/checkins`)).body;
    assert.deepEqual(list.freezes, [daysAgo(2)]);
    assert.ok(list.streak.current >= 2);

    // Same day twice, or a day with a check-in -> 409.
    assert.equal((await bob.post(`/api/habits/${h.id}/freezes`).send({ freeze_date: daysAgo(2) })).status, 409);
    assert.equal((await bob.post(`/api/habits/${h.id}/freezes`).send({ freeze_date: daysAgo(1) })).status, 409);
  });

  test('freezes are validated: recent past days only, due days only, strict body', async () => {
    const h = (await bob.post('/api/habits').send({ title: 'Weekend hike', category: 'fitness', schedule: { type: 'weekdays', days: [6, 7] } })).body.habit;
    const bad = [
      { freeze_date: daysAgo(-2) },
      { freeze_date: daysAgo(30) },
      { freeze_date: 'yesterday' },
      { freeze_date: daysAgo(1), user_id: 1 },
      {},
    ];
    for (const body of bad) {
      assert.equal((await bob.post(`/api/habits/${h.id}/freezes`).send(body)).status, 400, JSON.stringify(body));
    }
    // A weekday that is not due for a weekends-only habit.
    for (let i = 1; i <= 7; i++) {
      const d = daysAgo(i);
      const weekday = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      if (weekday <= 5) {
        assert.equal((await bob.post(`/api/habits/${h.id}/freezes`).send({ freeze_date: d })).status, 400);
        break;
      }
    }
  });

  test('only the owner can freeze — not other users, not admins', async () => {
    const h = (await alice.post('/api/habits').send({ title: 'Public yoga', category: 'fitness', is_public: true })).body.habit;
    assert.equal((await bob.post(`/api/habits/${h.id}/freezes`).send({ freeze_date: daysAgo(1) })).status, 403);
    assert.equal((await admin.post(`/api/habits/${h.id}/freezes`).send({ freeze_date: daysAgo(1) })).status, 403);
  });

  test('the monthly allowance holds even under parallel requests', async () => {
    await createUser('racer');
    const racer = await loginAs(app, 'racer');
    const habitsCreated = [];
    for (let i = 0; i < 6; i++) {
      habitsCreated.push((await racer.post('/api/habits').send({ title: `H${i}`, category: 'other' })).body.habit);
    }
    // Pick a day in the current month when possible so all requests share one month.
    const today = new Date().toISOString().slice(0, 10);
    const day = daysAgo(1).slice(0, 7) === today.slice(0, 7) ? daysAgo(1) : today;
    const results = await Promise.all(
      habitsCreated.map((h) => racer.post(`/api/habits/${h.id}/freezes`).send({ freeze_date: day })),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 2);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal((await racer.get('/api/habits/mine')).body.freezes_left, 0);
  });
});
