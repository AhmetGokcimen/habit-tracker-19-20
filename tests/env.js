'use strict';

// Pins every limit that config.js reads from the environment (and VERCEL), before config
// is loaded, so a developer's own .env (or shell) cannot change what the tests
// see. dotenv never overrides a variable that is already set, and config
// treats '' as "use the default".
//
// A test file that needs other values calls testEnv() with its overrides
// BEFORE requiring ./helpers:
//
//   require('./env').testEnv({ PHOTO_QUOTA_MB: '1' });
//   const { createApp } = require('./helpers');

const PINNED = Object.freeze({
  REGISTER_DAILY_LIMIT: '5',
  PHOTO_QUOTA_MB: '25',
  PHOTO_TOTAL_CAP_MB: '1024',
  SESSION_TTL_MINUTES: '120',
  // Not a limit, but VERCEL=1 makes clientIp() read platform headers, which
  // would change how every HTTP-level limit test identifies the client.
  VERCEL: '',
});

let applied = false;

function testEnv(overrides = {}) {
  if (applied) {
    if (Object.keys(overrides).length > 0) throw new Error('testEnv() overrides must come before require("./helpers")');
    return;
  }
  applied = true;
  for (const name of Object.keys(overrides)) {
    if (!(name in PINNED)) throw new Error(`testEnv(): ${name} is not a pinned limit`);
  }
  Object.assign(process.env, PINNED, overrides);
}

module.exports = { testEnv, PINNED };
