'use strict';

// CSRF defence for cookie-based sessions (defence in depth, three layers):
//   1. The session cookie is SameSite=Strict (set in routes/auth.js).
//   2. Every state-changing request must carry the custom header
//      `X-Requested-With: fetch`. A cross-site HTML form cannot set custom
//      headers, and a cross-site fetch() that sets one triggers a CORS
//      preflight which this server never approves (no CORS headers are sent).
//   3. If the browser sends an Origin header, it must be this server's origin.

const { forbidden } = require('../utils/httpError');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  if (req.get('X-Requested-With') !== 'fetch') {
    return next(forbidden('Missing or invalid X-Requested-With header'));
  }

  const origin = req.get('Origin');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return next(forbidden('Cross-origin request blocked'));
    }
    if (originHost !== req.get('Host')) {
      return next(forbidden('Cross-origin request blocked'));
    }
  }
  next();
}

module.exports = { csrfProtection };
