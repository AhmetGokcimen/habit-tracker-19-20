'use strict';

// Step 1 of every request: "who are you?"
//
// authenticate  — runs on every request, sets req.user (or leaves it undefined).
// requireAuth   — 401 unless a valid live session exists.
// requireRole   — 403 unless req.user.role is one of the allowed roles.
//                 The role comes from the database row, never from the token
//                 body or the request, so a demoted admin loses access instantly.

const { resolveSession } = require('../services/authService');
const { unauthorized, forbidden } = require('../utils/httpError');

const SESSION_COOKIE = 'session';

async function authenticate(req, _res, next) {
  const session = await resolveSession(req.cookies?.[SESSION_COOKIE]);
  if (session) {
    req.user = session.user;
    req.sessionJti = session.jti;
  }
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

module.exports = { SESSION_COOKIE, authenticate, requireAuth, requireRole };
