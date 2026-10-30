
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

test('subscription billing controls and price elements are configured', () => {
  // Monthly must be selected by default.
  assert.match(
    subscriptionHtml,
    /id="billing-monthly"[^>]*aria-pressed="true"/
  );

  assert.match(
    subscriptionHtml,
    /id="billing-yearly"[^>]*aria-pressed="false"/
  );

  // Every plan must have separate price and period elements.
  const plans = ['free', 'pro', 'pro-max'];

  for (const plan of plans) {
    assert.match(
      subscriptionHtml,
      new RegExp(`id="price-${plan}"`)
    );

    assert.match(
      subscriptionHtml,
      new RegExp(`id="period-${plan}"`)
    );
  }

  // Check the initial monthly prices.
  assert.match(subscriptionHtml, /id="price-free">€0<\/span>/);
  assert.match(subscriptionHtml, /id="price-pro">€9<\/span>/);
  assert.match(subscriptionHtml, /id="price-pro-max">€19<\/span>/);
});

test('billing toggle updates prices and selected state', () => {
  const vm = require('node:vm');

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'pages', 'subscription.js'),
    'utf8'
  );

  // Test page behaviour without running the application shell.
  const code = source.split('\n')
    .filter((line) => !line.startsWith('import { initPage }'))
    .filter((line) => !line.startsWith('await initPage('))
    .join('\n');

  function mockElement() {
    const classes = new Set();

    return {
      textContent: '',
      attributes: {},
      handlers: {},
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      addEventListener(name, handler) {
        this.handlers[name] = handler;
      },
    };
  }

  const ids = [
    'billing-monthly', 'billing-yearly',
    'price-free', 'price-pro', 'price-pro-max',
    'period-free', 'period-pro', 'period-pro-max',
  ];

  const elements = new Map(ids.map((id) => [id, mockElement()]));

  vm.runInNewContext(code, {
    document: {
      getElementById: (id) => elements.get(id),
    },
  });

  const get = (id) => elements.get(id);

  // Monthly is selected by default.
  assert.equal(get('price-pro').textContent, '€9');
  assert.equal(get('price-pro-max').textContent, '€19');
  assert.equal(get('billing-monthly').attributes['aria-pressed'], 'true');

  // Switching to Yearly updates all prices.
  get('billing-yearly').handlers.click();

  assert.equal(get('price-free').textContent, '€0');
  assert.equal(get('price-pro').textContent, '€90');
  assert.equal(get('price-pro-max').textContent, '€190');
  assert.equal(get('period-pro').textContent, '/ year');
  assert.equal(get('billing-yearly').attributes['aria-pressed'], 'true');
  assert.equal(get('billing-monthly').attributes['aria-pressed'], 'false');
  assert.equal(get('billing-yearly').classList.contains('is-active'), true);

  // Switching back restores monthly pricing.
  get('billing-monthly').handlers.click();

  assert.equal(get('price-pro').textContent, '€9');
  assert.equal(get('price-pro-max').textContent, '€19');
  assert.equal(get('period-pro').textContent, '/ month');
  assert.equal(get('billing-monthly').attributes['aria-pressed'], 'true');
});

