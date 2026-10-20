'use strict';

// Unit tests for the central authorization policy table (src/middleware/authorize.js).
// HTTP-level IDOR tests live next to each feature's route tests.

require('./helpers');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { can, parseId } = require('../src/middleware/authorize');

const alice = { id: 1, role: 'user' };
const bob = { id: 2, role: 'user' };
const admin = { id: 3, role: 'admin' };

const privateHabit = { id: 10, user_id: alice.id, is_public: 0 };
const publicHabit = { id: 11, user_id: alice.id, is_public: 1 };
const aliceCheckin = { id: 20, user_id: alice.id, habit_owner_id: alice.id };

describe('authorization policies', () => {
  test('only the owner may update a habit; owner or admin may delete', () => {
    assert.equal(can(alice, 'habit', 'update', privateHabit), true);
    assert.equal(can(bob, 'habit', 'update', publicHabit), false);
    assert.equal(can(admin, 'habit', 'update', privateHabit), false);
    assert.equal(can(bob, 'habit', 'delete', publicHabit), false);
    assert.equal(can(admin, 'habit', 'delete', privateHabit), true);
  });

  test('check-ins are private to their owner and admins, even on public habits', () => {
    assert.equal(can(bob, 'habit', 'listCheckins', publicHabit), false);
    assert.equal(can(bob, 'checkin', 'read', aliceCheckin), false);
    assert.equal(can(bob, 'checkin', 'delete', aliceCheckin), false);
    assert.equal(can(admin, 'checkin', 'read', aliceCheckin), true);
    assert.equal(can(alice, 'checkin', 'update', aliceCheckin), true);
  });

  test('private habits are invisible to other users; anonymous users get nothing', () => {
    assert.equal(can(bob, 'habit', 'read', privateHabit), false);
    assert.equal(can(bob, 'habit', 'read', publicHabit), true);
    assert.equal(can(bob, 'habit', 'addComment', privateHabit), false);
    assert.equal(can(undefined, 'habit', 'read', publicHabit), false);
  });

  test('ids must be plain positive integers', () => {
    assert.equal(parseId('42'), 42);
    for (const bad of ['0', '-1', '1.5', '1e3', '01', '1 OR 1=1', '../1', '', undefined, '99999999999']) {
      assert.equal(parseId(bad), null, `expected ${bad} to be rejected`);
    }
  });
});
