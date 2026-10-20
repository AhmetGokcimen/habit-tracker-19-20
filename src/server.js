'use strict';

const config = require('./config');
const { getDb } = require('./db');
const { createApp } = require('./app');

getDb();
createApp().listen(config.port, () => {
  console.log(`Habit Tracker listening on http://localhost:${config.port}`);
});
