'use strict';

// Verify theme color tokens and prevent circular CSS variables.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'css', 'app.css'),
  'utf8'
);

test('light theme color tokens are valid and non-circular', () => {
  // Extract the light theme :root block.
  const root = css.match(/:root\s*\{([\s\S]*?)\}/);

  assert.ok(root, 'Light theme :root block is missing');

  const tokens = [
    'warm-tint',
    'warm-line',
    'yellow-tint',
    'ice',
    'ice-line',
    'ice-ink',
  ];

  for (const name of tokens) {
    const pattern = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
    const match = root[1].match(pattern);

    assert.ok(match, `Missing color token: --${name}`);

    // Each token should contain a valid six-digit hex color.
    assert.match(
      match[1].trim(),
      /^#[0-9a-f]{6}$/i,
      `Invalid or circular color token: --${name}`
    );
  }
});
