'use strict';

// The README's demo-account table must match scripts/seed-data.js exactly,
// so the accounts are only ever maintained in one place — and no password may
// ever appear in either.

// Test environment first: scripts/seed loads config, which needs JWT_SECRET.
require('./helpers');

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

test('the README names no seed account', () => {
  const readme = fs.readFileSync(README, 'utf8');
  const start = readme.indexOf('<!-- seed-accounts:start');
  const section = readme.slice(start, readme.indexOf('<!-- seed-accounts:end -->'));
  const roles = new Set(SEED_ACCOUNTS.map((a) => a.role));
  for (const { username } of SEED_ACCOUNTS) {
    if (roles.has(username)) {
      // A name that is also a role word ("admin") may appear as that word, but
      // never written like a username in the account section (`admin`, | admin |).
      assert.doesNotMatch(section, new RegExp(`\`${username}\`|\\|\\s*${username}\\s*\\|`, 'i'), username);
    } else {
      assert.doesNotMatch(readme, new RegExp(`\\b${username}\\b`, 'i'), username);
    }
  }
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
