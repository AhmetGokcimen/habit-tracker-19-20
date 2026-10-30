
'use strict';

// F11: Subscription page smoke tests.
// The pricing page is a frontend-only demo with no payment processing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { request, createApp } = require('./helpers');

const subscriptionHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'subscription.html'),
  'utf8'
);

test('subscription page is served successfully', async () => {
  const res = await request(createApp()).get('/subscription.html');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /Pricing · Habit Tracker/);
});

test('subscription page displays Free, Pro and Pro Max plans', () => {
  const plans = [...subscriptionHtml.matchAll(
    /<h2>\s*(Free|Pro|Pro Max)\s*<\/h2>/g
  )].map((match) => match[1]);

  assert.deepEqual(plans, ['Free', 'Pro', 'Pro Max']);

  assert.match(
    subscriptionHtml,
    /<h2>Free<\/h2>[\s\S]*?<p class="muted">Current Plan<\/p>/
  );

  assert.match(
    subscriptionHtml,
    /No payments or real subscriptions are available\./
  );
});

test('Pricing navigation and page initialization are configured', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'shell.js'),
    'utf8'
  );

  assert.match(
    shell,
    /href:\s*['"]\/subscription\.html['"],\s*label:\s*['"]Pricing['"]/
  );

  assert.match(
    subscriptionHtml,
    /src="\/js\/pages\/subscription\.js"/
  );
});
