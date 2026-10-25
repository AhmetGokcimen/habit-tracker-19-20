'use strict';

// Step 2 of every request: "may you do this, on THIS record?"
//
// This file is the single place where record-level access rules live.
// Every route that takes a record id uses:
//
//     authorize('habit', 'update')
//
// which (1) validates the :id param, (2) loads the record from the database,
// (3) evaluates the policy below against req.user, and (4) only then hands the
// record to the route as req.resource. Routes never load records by id
// themselves, so there is no code path that can skip the ownership check (IDOR).
//
// Responses: malformed id or missing record -> 404, policy denied -> 403.

const db = require('../db');
const { unauthorized, forbidden, notFound } = require('../utils/httpError');

const ID_PATTERN = /^[1-9][0-9]{0,9}$/;

const isAdmin = (user) => user.role === 'admin';
const owns = (user, record) => record.user_id === user.id;

// How to load each resource by id. Ownership is always derived from the
// database row (`user_id`), never from anything in the request.
// Photo bytes are deliberately not loaded here.
const loaders = {
  habit: (id) => db.get('SELECT * FROM habits WHERE id = ?', [id]),
  checkin: (id) =>
    db.get(
      `SELECT c.id, c.habit_id, c.user_id, c.checkin_date, c.note, c.photo_mime, c.created_at,
              h.user_id AS habit_owner_id
         FROM checkins c JOIN habits h ON h.id = c.habit_id
        WHERE c.id = ?`,
      [id],
    ),
  comment: (id) =>
    db.get(
      `SELECT c.*, h.user_id AS habit_owner_id, h.is_public AS habit_is_public
         FROM comments c JOIN habits h ON h.id = c.habit_id
        WHERE c.id = ?`,
      [id],
    ),
  user: (id) => db.get('SELECT id, username, email, role, created_at FROM users WHERE id = ?', [id]),
  challenge: (id) => db.get('SELECT * FROM challenges WHERE id = ?', [id]),
};

// policies[resource][action](user, record) -> boolean
const policies = {
  habit: {
    // Public habits are readable by any logged-in user; private ones only by owner/admin.
    read: (u, h) => owns(u, h) || isAdmin(u) || h.is_public === 1,
    update: (u, h) => owns(u, h),
    delete: (u, h) => owns(u, h) || isAdmin(u),
    // Check-ins are only ever created by the habit owner on their own habit.
    // Archived habits are read-only until restored.
    addCheckin: (u, h) => owns(u, h) && h.archived_at === null,
    // Streak freezes are the owner's own allowance.
    freeze: (u, h) => owns(u, h) && h.archived_at === null,
    // Check-in history is private data (F5): owner and admins only.
    listCheckins: (u, h) => owns(u, h) || isAdmin(u),
    // Comments are read on public habits (owner/admin can still read them
    // after the habit is made private), and can only be written on public habits.
    listComments: (u, h) => owns(u, h) || isAdmin(u) || h.is_public === 1,
    addComment: (u, h) => h.is_public === 1,
    // "Add to my habits" from someone else's shared, active habit.
    copy: (u, h) => h.is_public === 1 && h.archived_at === null && !owns(u, h),
    // Cheering on someone else's shared, active habit.
    react: (u, h) => h.is_public === 1 && h.archived_at === null && !owns(u, h),
  },
  checkin: {
    read: (u, c) => owns(u, c) || isAdmin(u),
    update: (u, c) => owns(u, c),
    delete: (u, c) => owns(u, c) || isAdmin(u),
  },
  comment: {
    read: (u, c) => owns(u, c) || isAdmin(u) || c.habit_owner_id === u.id || c.habit_is_public === 1,
    // Only the author may change what a comment says — not the habit owner, not an admin.
    update: (u, c) => owns(u, c),
    // Deletion (moderation): the author, the owner of the habit the comment is
    // on (so people can remove abuse from their own page), or an admin.
    delete: (u, c) => owns(u, c) || c.habit_owner_id === u.id || isAdmin(u),
  },
  user: {
    read: (u, target) => u.id === target.id || isAdmin(u),
  },
  challenge: {
    // Any signed-in user may see, join or leave a challenge.
    read: () => true,
    delete: (u) => isAdmin(u),
  },
};

function can(user, resource, action, record) {
  const rule = policies[resource]?.[action];
  if (!rule) throw new Error(`No policy defined for ${resource}.${action}`);
  return Boolean(user && record && rule(user, record));
}

function parseId(raw) {
  return typeof raw === 'string' && ID_PATTERN.test(raw) ? Number(raw) : null;
}

function authorize(resource, action, { param = 'id' } = {}) {
  if (!loaders[resource] || !policies[resource]?.[action]) {
    throw new Error(`authorize(): unknown ${resource}.${action}`);
  }
  return async (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    const id = parseId(req.params[param]);
    if (id === null) return next(notFound());
    const record = await loaders[resource](id);
    if (!record) return next(notFound());
    if (!can(req.user, resource, action, record)) return next(forbidden());
    req.resource = record;
    next();
  };
}

module.exports = { authorize, can, parseId, policies };
