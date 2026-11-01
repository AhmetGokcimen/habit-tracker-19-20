'use strict';

// Clears the failed-login counters of ONE account (e.g. an admin locked by
// someone failing logins on purpose). Only rate-limit counters are removed:
// no password, session or role is touched. The reset is written to the
// append-only audit log (actor "cli") in the same atomic batch.
//
//   npm run unlock -- <username>            # local database
//   npm run unlock -- <username> --remote   # remote (Turso) database

const config = require('../src/config');
const db = require('../src/db');

const USERNAME = /^[A-Za-z0-9_]{3,30}$/;
const CLI_ACTOR = { id: 0, username: 'cli' };

async function resetLoginLocks(username) {
  if (typeof username !== 'string' || !USERNAME.test(username)) throw new Error('Give a valid username');
  const name = username.toLowerCase();
  const prefix = `login-acct-ip:${name}|`;
  const user = await db.get('SELECT id FROM users WHERE username = ?', [name]);
  const [deleted] = await db.batch([
    // substr instead of LIKE: "_" in usernames would be a LIKE wildcard.
    [
      'DELETE FROM rate_limit_windows WHERE bucket = ? OR substr(bucket, 1, ?) = ?',
      [`login-acct-day:${name}`, prefix.length, prefix],
    ],
    [
      `INSERT INTO admin_audit_log (actor_id, actor_username, action, target_type, target_id, details)
       VALUES (?, ?, 'login.unlock', 'user', ?, ?)`,
      [CLI_ACTOR.id, CLI_ACTOR.username, user?.id ?? 0, JSON.stringify({ username: name, known_user: Boolean(user) })],
    ],
  ]);
  return { username: name, userId: user?.id ?? null, removed: deleted.rowsAffected };
}

async function main() {
  const [username] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!config.database.filePath && !process.argv.includes('--remote')) {
    console.error('This is a remote database. Re-run with --remote if you mean it.');
    process.exit(1);
  }
  const result = await resetLoginLocks(username);
  db.close();
  console.log(
    `Unlocked account "${result.username}"${result.userId === null ? ' (no such user)' : ` (id ${result.userId})`}: ` +
      `cleared ${result.removed} failed-login counter(s). Logged to admin_audit_log as actor "cli".`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unlock failed:', err.message);
    process.exit(1);
  });
}

module.exports = { resetLoginLocks };
