'use strict';

// On Vercel, public/ is served by the CDN, not by Express, so helmet's headers
// never reach the HTML pages there. vercel.json repeats them for static files;
// this test keeps the two copies identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { request, createApp } = require('./helpers');

const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const staticRule = vercel.headers.find((h) => h.source === '/((?!api/).*)');

test('vercel.json gives CDN-served pages the same security headers as Express', async () => {
  const res = await request(createApp()).get('/login.html');
  assert.equal(res.status, 200);

  for (const { key, value } of staticRule.headers) {
    const expressValue = res.headers[key.toLowerCase()];
    // Express only adds upgrade-insecure-requests in production; Vercel is always production.
    const expected = key === 'Content-Security-Policy' ? value.replace(/;upgrade-insecure-requests$/, '') : value;
    assert.equal(expressValue, expected, key);
  }
});

test('the static header rule does not apply to API routes', () => {
  const pattern = new RegExp(`^${staticRule.source}$`);
  assert.equal(pattern.test('/login.html'), true);
  assert.equal(pattern.test('/'), true);
  assert.equal(pattern.test('/api/checkins/1/photo'), false);
});
