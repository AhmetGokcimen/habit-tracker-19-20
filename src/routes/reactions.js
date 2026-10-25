'use strict';

// One-tap reactions on shared habits (F12).
//
//   GET    /api/habits/:id/reactions          counts + which ones are mine
//   PUT    /api/habits/:id/reactions/:kind    add (idempotent)
//   DELETE /api/habits/:id/reactions/:kind    remove
//
// Kinds are a fixed list (also a CHECK constraint). Who reacted is never
// returned, only counts, so reactions cannot be used to track people.
// Only public, non-archived habits of other people can be reacted to.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { notFound } = require('../utils/httpError');

const REACTIONS = ['clap', 'fire', 'muscle'];

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

async function summary(habitId, userId) {
  const rows = await db.all(
    'SELECT kind, COUNT(*) AS n, MAX(user_id = ?) AS mine FROM reactions WHERE habit_id = ? GROUP BY kind',
    [userId, habitId],
  );
  const counts = Object.fromEntries(REACTIONS.map((k) => [k, 0]));
  const mine = [];
  for (const r of rows) {
    counts[r.kind] = r.n;
    if (r.mine === 1) mine.push(r.kind);
  }
  return { counts, mine };
}

function kindParam(req) {
  const { kind } = req.params;
  if (!REACTIONS.includes(kind)) throw notFound('Unknown reaction');
  return kind;
}

router.get('/', authorize('habit', 'listComments'), async (req, res) => {
  res.json(await summary(req.resource.id, req.user.id));
});

router.put('/:kind', authorize('habit', 'react'), async (req, res) => {
  const kind = kindParam(req);
  await db.run('INSERT INTO reactions (habit_id, user_id, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [
    req.resource.id,
    req.user.id,
    kind,
  ]);
  res.json(await summary(req.resource.id, req.user.id));
});

router.delete('/:kind', authorize('habit', 'react'), async (req, res) => {
  const kind = kindParam(req);
  await db.run('DELETE FROM reactions WHERE habit_id = ? AND user_id = ? AND kind = ?', [req.resource.id, req.user.id, kind]);
  res.json(await summary(req.resource.id, req.user.id));
});

module.exports = { habitReactions: router, REACTIONS };
