'use strict';

// Single database handle for the whole app. node:sqlite (built into Node 24)
// is used instead of a native addon so installation needs no compiler.
// All queries in this codebase go through db.prepare(...) with `?` placeholders —
// user input is never concatenated into SQL.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

let db;

function open(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const handle = new DatabaseSync(dbPath);
  handle.exec('PRAGMA foreign_keys = ON;');
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return handle;
}

function getDb() {
  if (!db) db = open(config.isTest ? ':memory:' : config.dbPath);
  return db;
}

// Runs fn inside a transaction; rolls back on any thrown error.
function transaction(fn) {
  const handle = getDb();
  handle.exec('BEGIN');
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { getDb, transaction };
