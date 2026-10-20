'use strict';

// Brute-force protection for credential endpoints. Limiters are created per
// app instance (see app.js) so each test suite starts with a fresh counter.

const { rateLimit } = require('express-rate-limit');

function createAuthLimiters() {
  const common = {
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many attempts, please try again later' }),
  };
  return {
    // 10 failed logins per 15 minutes per IP; successful logins do not count.
    login: rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true }),
    register: rateLimit({ ...common, windowMs: 60 * 60 * 1000, limit: 20 }),
  };
}

module.exports = { createAuthLimiters };
