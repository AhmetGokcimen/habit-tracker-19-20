'use strict';

// Terms of Use tests for the educational Habit Tracker project.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { request, createApp } = require('./helpers');

const termsHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'terms.html'),
  'utf8'
);

test('Terms of Use page is accessible without authentication', async () => {
  const response = await request(createApp()).get('/terms.html');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.text, /<h1>Terms of Use<\/h1>/);
});

test('Terms of Use includes essential legal and community sections', () => {
  const requiredSections = [
    'terms-introduction',
    'terms-accounts',
    'terms-habits',
    'terms-sharing',
    'terms-community',
    'terms-security',
    'terms-subscriptions',
    'terms-availability',
    'terms-privacy',
    'terms-updates',
    'terms-contact',
  ];

  for (const id of requiredSections) {
    assert.ok(
      termsHtml.includes(`id="${id}"`),
      `Missing Terms section: ${id}`
    );
  }

  // Verify references to user responsibilities.
  assert.match(termsHtml, /login credentials confidential/);
  assert.match(termsHtml, /Administrators can remove content/);
});

test('Terms of Use explains demo limitations and links to Privacy Policy', () => {
  // Subscription plans must be clearly identified as demos.
  assert.match(
    termsHtml,
    /No real subscription purchase/
  );

  assert.match(
    termsHtml,
    /AI coaching, priority support/
  );

  // Users must be able to access the Privacy Policy.
  assert.match(
    termsHtml,
    /href="\/privacy\.html"/
  );

  // The page must identify its educational nature.
  assert.match(
    termsHtml,
    /educational web application/
  );
});
