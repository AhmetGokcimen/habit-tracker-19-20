'use strict';

// Privacy Policy page tests for the educational Habit Tracker project.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { request, createApp } = require('./helpers');

const privacyHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'privacy.html'),
  'utf8'
);

test('Privacy Policy page is accessible without authentication', async () => {
  const response = await request(createApp()).get('/privacy.html');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.text, /<h1>Privacy Policy<\/h1>/);
});

test('Privacy Policy explains data handling and security', () => {
  const requiredSections = [
    'privacy-data',
    'privacy-usage',
    'privacy-visibility',
    'privacy-security',
    'privacy-cookies',
    'privacy-third-party',
    'privacy-controls',
    'privacy-retention',
  ];

  for (const id of requiredSections) {
    assert.ok(
      privacyHtml.includes(`id="${id}"`),
      `Missing privacy section: ${id}`
    );
  }

  assert.match(privacyHtml, /bcrypt/);
  assert.match(privacyHtml, /authorized administrators/);
  assert.match(privacyHtml, /OpenStreetMap/);
});

test('Privacy Policy identifies educational limitations', () => {
  // The policy must identify the project as educational.
  assert.match(privacyHtml, /educational web application/);

  // Premium or production privacy guarantees must not be invented.
  assert.match(
    privacyHtml,
    /complete production retention schedule/i
  );

  // The privacy page should not require the authenticated app shell.
  assert.doesNotMatch(
    privacyHtml,
    /src="\/js\/pages\/privacy\.js"/
  );

  // Public privacy page must not link to an authenticated-only Contact page.
  assert.doesNotMatch(
    privacyHtml,
    /href="\/contact\.html"/
  );
});
