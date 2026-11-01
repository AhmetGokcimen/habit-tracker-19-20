'use strict';

// Defaults that apply when the environment does not set a value.

// Set to '' before config is loaded: dotenv never overrides a variable that is
// already set (so a developer's own .env cannot change the result), and config
// treats '' as "not set".
process.env.PHOTO_QUOTA_MB = '';
process.env.PHOTO_TOTAL_CAP_MB = '';
process.env.REGISTER_DAILY_LIMIT = '';

const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const config = require('../src/config');

const MB = 1024 * 1024;

test('photo storage defaults: 25 MB per user, 1024 MB for the whole service', () => {
  assert.equal(config.photoQuotaBytes, 25 * MB);
  assert.equal(config.photoTotalCapBytes, 1024 * MB);
});

test('registration default: 5 accounts per IP per day', () => {
  assert.equal(config.registerDailyLimit, 5);
});
