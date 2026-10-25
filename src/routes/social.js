'use strict';

// Public profiles, following and the feed (F11).
//
// Privacy rules:
//   - Following grants NO extra access. The feed only filters data that is
//     already public (shared, non-archived habits). Check-ins stay private.
//   - A profile exists only for users who share at least one habit; for
//     everyone else it is a 404, so ids cannot be walked to list the
//     usernames of people who share nothing.
//   - Follower lists are never exposed (only a count): nobody can harvest
//     who follows whom. You can list the people YOU follow.
//   - At most MAX_FOLLOWS per user, enforced in the INSERT itself.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/authenticate');
const { parseId } = require('../middleware/authorize');
const { badRequest, conflict, notFound } = require('../utils/httpError');

const MAX_FOLLOWS = 500;
const FEED_LIMIT = 50;

// Mounted at /api, so authentication is required per route (a router-wide
// requireAuth would turn every unknown /api path into a 401).
const router = express.Router();

// Loads a user that has a public profile, or throws 404.
async function publicUser(rawId) {
  const id = parseId(rawId);
  if (id === null) throw notFound();
  const user = await db.get(
    `SELECT u.id, u.username, u.created_at FROM users u
      WHERE u.id = ? AND EXISTS (SELECT 1 FROM habits h WHERE h.user_id = u.id AND h.is_public = 1 AND h.archived_at IS NULL)`,
    [id],
  );
  if (!user) throw notFound();
  return user;
}

const publicHabitFields = `h.id, h.title, h.description, h.category, h.created_at, h.user_id, u.username AS owner_username`;

function serializePublicHabit(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    owner: { id: row.user_id, username: row.owner_username },
    created_at: row.created_at,
  };
}

// ---- /api/users/me/following ------------------------------------------------

router.get('/users/me/following', requireAuth, async (req, res) => {
  const rows = await db.all(
    `SELECT u.id, u.username FROM follows f JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ? ORDER BY u.username COLLATE NOCASE`,
    [req.user.id],
  );
  res.json({ following: rows });
});

// ---- /api/users/:id/public ------------------------------------------------------

router.get('/users/:id/public', requireAuth, async (req, res) => {
  const user = await publicUser(req.params.id);
  const [habits, followers, following] = await Promise.all([
    db.all(
      `SELECT ${publicHabitFields} FROM habits h JOIN users u ON u.id = h.user_id
        WHERE h.user_id = ? AND h.is_public = 1 AND h.archived_at IS NULL
        ORDER BY h.created_at DESC, h.id DESC LIMIT 100`,
      [user.id],
    ),
    db.get('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', [user.id]),
    db.get('SELECT 1 AS yes FROM follows WHERE follower_id = ? AND followee_id = ?', [req.user.id, user.id]),
  ]);
  res.json({
    // Only the month someone joined, not the exact time.
    user: { id: user.id, username: user.username, joined: user.created_at.slice(0, 7) },
    habits: habits.map(serializePublicHabit),
    follower_count: followers.n,
    is_me: user.id === req.user.id,
    you_follow: Boolean(following),
  });
});

// ---- follow / unfollow ------------------------------------------------------------

router.put('/users/:id/follow', requireAuth, async (req, res) => {
  const target = await publicUser(req.params.id);
  if (target.id === req.user.id) throw badRequest('You cannot follow yourself');
  const result = await db.run(
    `INSERT INTO follows (follower_id, followee_id)
     SELECT ?1, ?2
      WHERE (SELECT COUNT(*) FROM follows WHERE follower_id = ?1) < ?3
     ON CONFLICT (follower_id, followee_id) DO NOTHING`,
    [req.user.id, target.id, MAX_FOLLOWS],
  );
  if (result.changes === 0) {
    const already = await db.get('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?', [req.user.id, target.id]);
    if (!already) throw conflict(`You can follow at most ${MAX_FOLLOWS} people`);
  }
  res.status(204).end();
});

// Unfollowing works even if the other person stopped sharing.
router.delete('/users/:id/follow', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) throw notFound();
  await db.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', [req.user.id, id]);
  res.status(204).end();
});

// ---- /api/feed ----------------------------------------------------------------------

// Recently shared habits of the people you follow. Public data only.
router.get('/feed', requireAuth, async (req, res) => {
  const rows = await db.all(
    `SELECT ${publicHabitFields},
            (SELECT COUNT(*) FROM comments c WHERE c.habit_id = h.id) AS comment_count,
            (SELECT COUNT(*) FROM reactions r WHERE r.habit_id = h.id) AS reaction_count
       FROM follows f
       JOIN habits h ON h.user_id = f.followee_id
       JOIN users u ON u.id = h.user_id
      WHERE f.follower_id = ? AND h.is_public = 1 AND h.archived_at IS NULL
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT ?`,
    [req.user.id, FEED_LIMIT],
  );
  res.json({
    habits: rows.map((r) => ({ ...serializePublicHabit(r), comment_count: r.comment_count, reaction_count: r.reaction_count })),
  });
});

module.exports = router;
