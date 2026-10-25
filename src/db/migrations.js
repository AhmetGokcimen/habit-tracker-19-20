'use strict';

// Upgrades a database created by an older schema.sql.
//
// schema.sql only uses CREATE ... IF NOT EXISTS, which never changes a table
// that already exists, so columns added after the first release would be
// missing on the deployed (Turso) database. Every such column is listed here
// with the same definition as in schema.sql and added when it is missing.
//
// Table and column names are constants from this file, never user input.
// Two serverless instances may start at the same time: a "duplicate column"
// error just means the other one won the race.

const ADDED_COLUMNS = [
  ['habits', 'frequency', "TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekdays', 'weekly'))"],
  ['habits', 'days_mask', 'INTEGER NOT NULL DEFAULT 127 CHECK (days_mask BETWEEN 1 AND 127)'],
  ['habits', 'weekly_target', 'INTEGER NOT NULL DEFAULT 7 CHECK (weekly_target BETWEEN 1 AND 7)'],
  ['habits', 'reminder_time', "TEXT CHECK (reminder_time IS NULL OR reminder_time GLOB '[0-2][0-9]:[0-5][0-9]')"],
];

// Indexes and triggers that use added columns. They run after the columns
// exist, so they cannot live in schema.sql. Every statement is IF NOT EXISTS.
const AFTER_COLUMNS = '';

async function migrate(client) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (info.rows.some((row) => row.name === column)) continue;
    try {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
  if (AFTER_COLUMNS.trim()) await client.executeMultiple(AFTER_COLUMNS);
}

module.exports = { migrate, ADDED_COLUMNS };
