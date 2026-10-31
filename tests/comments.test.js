'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, createApp, db, createUser, loginAs } = require('./helpers');

const app = createApp();
let alice, bob, carol, admin;
let publicHabit, privateHabit;

const countComments = async () => (await db.get('SELECT COUNT(*) AS n FROM comments')).n;
const comment = async (agent, habitId, body) =>
  (await agent.post(`/api/habits/${habitId}/comments`).send({ body })).body.comment;

before(async () => {
  for (const name of ['alice', 'bob', 'carol']) await createUser(name);
  await createUser('root', 'admin');
  [alice, bob, carol, admin] = await Promise.all(['alice', 'bob', 'carol', 'root'].map((n) => loginAs(app, n)));

  publicHabit = (await alice.post('/api/habits').send({ title: 'Meditate', category: 'mindfulness', is_public: true })).body.habit;
  privateHabit = (await alice.post('/api/habits').send({ title: 'Journal', category: 'mindfulness' })).body.habit;
});

describe('F6 — comments on shared habits', () => {
  test('any logged-in user can comment on a public habit and others can read it', async () => {
    const res = await bob.post(`/api/habits/${publicHabit.id}/comments`).send({ body: 'Keep going!' });
    assert.equal(res.status, 201);
    assert.equal(res.body.comment.author.username, 'bob');
    assert.equal('email' in res.body.comment.author, false);

    const list = await carol.get(`/api/habits/${publicHabit.id}/comments`);
    assert.equal(list.status, 200);
    assert.ok(list.body.comments.some((c) => c.body === 'Keep going!'));
  });

  test('comments are only allowed on public habits: 403 on a private one, even for its owner', async () => {
    const before = await countComments();
    assert.equal((await bob.post(`/api/habits/${privateHabit.id}/comments`).send({ body: 'hi' })).status, 403);
    assert.equal((await alice.post(`/api/habits/${privateHabit.id}/comments`).send({ body: 'hi' })).status, 403);
    assert.equal((await bob.get(`/api/habits/${privateHabit.id}/comments`)).status, 403);
    assert.equal(await countComments(), before);
  });

  test('an archived public habit takes no new comments (403) until it is restored', async () => {
    const habit = (await alice.post('/api/habits').send({ title: 'Stretch', category: 'fitness', is_public: true })).body.habit;
    await comment(bob, habit.id, 'Nice one');
    assert.equal((await alice.patch(`/api/habits/${habit.id}`).send({ archived: true })).status, 200);

    const before = await countComments();
    assert.equal((await bob.post(`/api/habits/${habit.id}/comments`).send({ body: 'still here?' })).status, 403);
    assert.equal((await alice.post(`/api/habits/${habit.id}/comments`).send({ body: 'mine' })).status, 403);
    assert.equal(await countComments(), before);
    // Existing comments stay readable for the owner.
    assert.equal((await alice.get(`/api/habits/${habit.id}/comments`)).body.comments.length, 1);

    await alice.patch(`/api/habits/${habit.id}`).send({ archived: false });
    assert.equal((await bob.post(`/api/habits/${habit.id}/comments`).send({ body: 'welcome back' })).status, 201);
  });

  test('comment body is validated on the server like check-in notes', async () => {
    const url = `/api/habits/${publicHabit.id}/comments`;
    const bad = [
      { body: '' },
      { body: '    ' },
      { body: 'x'.repeat(501) },
      { body: 'null\u0000byte' },
      { body: 'bidi ‮gnp.exe' },
      { body: 42 },
      { body: 'ok', user_id: 1 },
      { body: 'ok', habit_id: privateHabit.id },
    ];
    for (const payload of bad) {
      assert.equal((await bob.post(url).send(payload)).status, 400, JSON.stringify(payload));
    }
  });

  test('stored XSS payloads come back as inert JSON text', async () => {
    const payload = '"><img src=x onerror=alert(document.cookie)><script>fetch("//evil")</script>';
    const created = await bob.post(`/api/habits/${publicHabit.id}/comments`).send({ body: payload });
    assert.equal(created.status, 201);

    const list = await carol.get(`/api/habits/${publicHabit.id}/comments`);
    assert.match(list.headers['content-type'], /^application\/json/);
    assert.equal(list.headers['x-content-type-options'], 'nosniff');
    assert.ok(list.body.comments.some((c) => c.body === payload));
  });
});

describe('who may edit and delete a comment', () => {
  test('only the author can edit; habit owner and admin get 403 and the text is unchanged', async () => {
    const c = await comment(bob, publicHabit.id, 'original');

    const own = await bob.patch(`/api/comments/${c.id}`).send({ body: 'edited by author' });
    assert.equal(own.status, 200);
    assert.ok(own.body.comment.updated_at);

    for (const agent of [alice, carol, admin]) {
      assert.equal((await agent.patch(`/api/comments/${c.id}`).send({ body: 'tampered' })).status, 403);
    }
    assert.equal((await db.get('SELECT body FROM comments WHERE id = ?', [c.id])).body, 'edited by author');
  });

  test("a third user cannot delete someone else's comment (403, still exists)", async () => {
    const c = await comment(bob, publicHabit.id, 'mine');
    assert.equal((await carol.delete(`/api/comments/${c.id}`)).status, 403);
    assert.ok(await db.get('SELECT 1 FROM comments WHERE id = ?', [c.id]));
  });

  test('the author, the habit owner (moderation) and an admin can delete', async () => {
    const byAuthor = await comment(bob, publicHabit.id, 'oops');
    assert.equal((await bob.delete(`/api/comments/${byAuthor.id}`)).status, 204);

    const onAlicesHabit = await comment(carol, publicHabit.id, 'spam spam');
    assert.equal((await alice.delete(`/api/comments/${onAlicesHabit.id}`)).status, 204);

    const forAdmin = await comment(carol, publicHabit.id, 'abusive');
    assert.equal((await admin.delete(`/api/comments/${forAdmin.id}`)).status, 204);

    const audit = await db.get("SELECT * FROM admin_audit_log WHERE action = 'comment.delete' AND target_id = ?", [forAdmin.id]);
    assert.ok(audit, 'admin moderation is audited');
  });

  test("a habit owner cannot moderate comments on someone else's habit", async () => {
    const bobsHabit = (await bob.post('/api/habits').send({ title: 'Code', category: 'learning', is_public: true })).body.habit;
    const c = await comment(carol, bobsHabit.id, 'nice');
    assert.equal((await alice.delete(`/api/comments/${c.id}`)).status, 403);
  });

  test('anonymous users get 401', async () => {
    assert.equal((await request(app).get(`/api/habits/${publicHabit.id}/comments`)).status, 401);
  });
});
