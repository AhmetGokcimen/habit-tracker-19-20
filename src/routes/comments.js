'use strict';

// Comments: user-generated content shown to other users (F6).
//
// Written only on public habits; validated on the server (length, no control
// or bidi characters); stored and returned as plain text in JSON — the
// frontend renders it with textContent, never innerHTML.

const express = require('express');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { moderationAudit } = require('../services/auditLog');

const SELECT_COMMENT = `SELECT c.id, c.habit_id, c.user_id, c.body, c.created_at, c.updated_at,
                               u.username AS author_username
                          FROM comments c JOIN users u ON u.id = c.user_id`;

function serializeComment(row) {
  return {
    id: row.id,
    habit_id: row.habit_id,
    body: row.body,
    author: { id: row.user_id, username: row.author_username },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const findComment = (id) => db.get(`${SELECT_COMMENT} WHERE c.id = ?`, [id]);

// ---- /api/habits/:id/comments --------------------------------------------

const habitComments = express.Router({ mergeParams: true });
habitComments.use(requireAuth);

habitComments.get('/', authorize('habit', 'listComments'), async (req, res) => {
  const rows = await db.all(`${SELECT_COMMENT} WHERE c.habit_id = ? ORDER BY c.id ASC LIMIT 500`, [req.resource.id]);
  res.json({ comments: rows.map(serializeComment) });
});

habitComments.post('/', authorize('habit', 'addComment'), validate({ body: schemas.commentBody }), async (req, res) => {
  // Author is always the authenticated user.
  const { lastInsertRowid } = await db.run('INSERT INTO comments (habit_id, user_id, body) VALUES (?, ?, ?)', [
    req.resource.id,
    req.user.id,
    req.valid.body.body,
  ]);
  res.status(201).json({ comment: serializeComment(await findComment(lastInsertRowid)) });
});

// ---- /api/comments/:id ---------------------------------------------------

const comments = express.Router();
comments.use(requireAuth);

comments.patch('/:id', authorize('comment', 'update'), validate({ body: schemas.commentBody }), async (req, res) => {
  await db.run("UPDATE comments SET body = ?, updated_at = datetime('now') WHERE id = ?", [
    req.valid.body.body,
    req.resource.id,
  ]);
  res.json({ comment: serializeComment(await findComment(req.resource.id)) });
});

comments.delete('/:id', authorize('comment', 'delete'), async (req, res) => {
  const c = req.resource;
  await db.batch([
    ...moderationAudit(req.user, c.user_id, 'comment.delete', 'comment', c.id, { habit_id: c.habit_id, author_id: c.user_id }),
    ['DELETE FROM comments WHERE id = ?', [c.id]],
  ]);
  res.status(204).end();
});

module.exports = { habitComments, comments };
