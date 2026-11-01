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

test('static files must be revalidated before every use; API responses keep no-store', async () => {
  const app = createApp();
  assert.equal(staticRule.headers.find((h) => h.key === 'Cache-Control')?.value, 'no-cache');
  for (const file of ['/', '/login.html', '/js/pages/habit.js', '/css/app.css', '/favicon.svg']) {
    const res = await request(app).get(file);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers['cache-control'], 'no-cache', file);
    assert.ok(res.headers.etag, `${file} has an ETag`);
    // An unchanged file costs only a 304 on revalidation.
    const again = await request(app).get(file).set('If-None-Match', res.headers.etag);
    assert.equal(again.status, 304, file);
  }
  assert.equal((await request(app).get('/api/auth/me')).headers['cache-control'], 'no-store');
});

test('the static header rule does not apply to API routes', () => {
  const pattern = new RegExp(`^${staticRule.source}$`);
  assert.equal(pattern.test('/login.html'), true);
  assert.equal(pattern.test('/'), true);
  assert.equal(pattern.test('/api/checkins/1/photo'), false);
});
