'use strict';

// The README's demo-account table must match scripts/seed-data.js exactly,
// so the accounts are only ever maintained in one place — and no password may
// ever appear in either.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { renderInto, README } = require('../scripts/update-readme');
const { SEED_ACCOUNTS } = require('../scripts/seed-data');
const { generatePassword } = require('../scripts/seed');
const schemas = require('../src/validators/schemas');

test('README demo accounts are generated from seed-data.js (run npm run readme:accounts)', () => {
  const readme = fs.readFileSync(README, 'utf8');
  assert.equal(readme, renderInto(readme));
});

test('seed data has at least two accounts per role, all valid under the register rules', () => {
  for (const role of ['user', 'admin']) {
    assert.ok(SEED_ACCOUNTS.filter((a) => a.role === role).length >= 2, role);
  }
  for (const { username, email } of SEED_ACCOUNTS) {
    assert.equal(schemas.register.safeParse({ username, email, password: generatePassword() }).success, true, username);
  }
});

test('no password is stored in the seed data or published in the README', () => {
  assert.ok(SEED_ACCOUNTS.every((a) => !('password' in a)));
  assert.doesNotMatch(fs.readFileSync(README, 'utf8'), /Passw0rd|\| Password \|/);
});

test('generated seed passwords are long, random and unique', () => {
  const sample = Array.from({ length: 200 }, generatePassword);
  assert.ok(sample.every((p) => p.length === 24 && /[A-Za-z]/.test(p) && /[0-9]/.test(p)));
  assert.equal(new Set(sample).size, sample.length);
});
