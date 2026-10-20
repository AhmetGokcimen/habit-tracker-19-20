'use strict';

// The README's demo-account table must match scripts/seed-data.js exactly,
// so the credentials are only ever maintained in one place.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { renderInto, README } = require('../scripts/update-readme');
const { SEED_ACCOUNTS } = require('../scripts/seed-data');
const schemas = require('../src/validators/schemas');

test('README demo accounts are generated from seed-data.js (run npm run readme:accounts)', () => {
  const readme = fs.readFileSync(README, 'utf8');
  assert.equal(readme, renderInto(readme));
});

test('seed data has at least two accounts per role, all valid under the register rules', () => {
  for (const role of ['user', 'admin']) {
    assert.ok(SEED_ACCOUNTS.filter((a) => a.role === role).length >= 2, role);
  }
  for (const { username, email, password } of SEED_ACCOUNTS) {
    assert.equal(schemas.register.safeParse({ username, email, password }).success, true, username);
  }
});
