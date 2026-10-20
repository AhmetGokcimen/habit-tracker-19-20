'use strict';

const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');

db.init().then(() => {
  createApp().listen(config.port, () => {
    console.log(`Habit Tracker listening on http://localhost:${config.port}`);
  });
});
