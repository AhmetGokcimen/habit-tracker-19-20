'use strict';

// Local entry point (npm start). On Vercel, src/app.js is the entry instead.

const config = require('./config');
const db = require('./db');
const app = require('./app');

db.init().then(() => {
  app.listen(config.port, () => {
    console.log(`Habit Tracker listening on http://localhost:${config.port}`);
  });
});
