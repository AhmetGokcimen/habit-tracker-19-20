'use strict';

// Defaults that apply when the environment does not set a value.

// '' means "not set" to config, and dotenv does not override it either, so the
// built-in defaults are what is tested, whatever a developer's .env says.
require('./env').testEnv({ PHOTO_QUOTA_MB: '', PHOTO_TOTAL_CAP_MB: '', REGISTER_DAILY_LIMIT: '' });

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
