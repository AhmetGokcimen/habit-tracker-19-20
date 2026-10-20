'use strict';

// Single database client for the whole app (@libsql/client).
//   local / tests : DATABASE_URL=file:...      (plain SQLite file)
//   production    : DATABASE_URL=libsql://...  (Turso, hosted SQLite)
//
// All queries go through the helpers below with `?` placeholders and an args
// array — user input is never concatenated into SQL.

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const config = require('../config');

let client;
let ready;

function getClient() {
  if (!client) {
    const { url, authToken, filePath } = config.database;
    if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    client = createClient({ url, authToken });
  }
  return client;
}

// Applies schema.sql once per process (every statement is IF NOT EXISTS).
function init() {
  if (!ready) {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    ready = getClient()
      .executeMultiple(`PRAGMA foreign_keys = ON;\n${schema}`)
      .catch((err) => {
        ready = undefined;
        throw err;
      });
  }
  return ready;
}

// Converts libsql rows to plain objects keyed by column name.
function toObjects(result) {
  return result.rows.map((row) => Object.fromEntries(result.columns.map((col, i) => [col, row[i]])));
}

async function execute(sql, args = []) {
  await init();
  return getClient().execute({ sql, args });
}

async function get(sql, args) {
  return toObjects(await execute(sql, args))[0];
}

async function all(sql, args) {
  return toObjects(await execute(sql, args));
}

async function run(sql, args) {
  const result = await execute(sql, args);
  return {
    changes: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
  };
}

// Executes several statements atomically (all succeed or none do).
async function batch(statements) {
  await init();
  return getClient().batch(statements.map(([sql, args = []]) => ({ sql, args })), 'write');
}

function close() {
  if (client) client.close();
  client = undefined;
  ready = undefined;
}

module.exports = { init, get, all, run, batch, close };
