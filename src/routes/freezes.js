'use strict';

// Streak freezes: the owner marks a recently missed day so the streak survives.
//
//   POST /api/habits/:id/freezes  { freeze_date }
//
// Rules (all enforced here or in the database, never trusted from the client):
//   - owner only (policy habit.freeze);
//   - one of the last 7 days (validator), on a day the habit was due, with no check-in;
//   - at most FREEZES_PER_MONTH per user per calendar month. The count and the
//     insert are ONE statement, so parallel requests cannot exceed the allowance.

const express = require('express');
const db = require('../db');
const schemas = require('../validators/schemas');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const schedule = require('../services/schedule');
const { freezesLeft, FREEZES_PER_MONTH } = require('../services/freezes');
const { badRequest, conflict } = require('../utils/httpError');

const habitFreezes = express.Router({ mergeParams: true });
habitFreezes.use(requireAuth);

habitFreezes.post('/', authorize('habit', 'freeze'), validate({ body: schemas.freezeCreate }), async (req, res) => {
  const habit = req.resource;
  const { freeze_date } = req.valid.body;

  if (!schedule.isDueOn(habit, schedule.dayNumber(freeze_date))) {
    throw badRequest('This habit was not due on that day');
  }
  if (await db.get('SELECT 1 FROM checkins WHERE habit_id = ? AND checkin_date = ?', [habit.id, freeze_date])) {
    throw conflict('You already checked in on that day');
  }

  let result;
  try {
    result = await db.run(
      `INSERT INTO streak_freezes (habit_id, user_id, freeze_date)
       SELECT ?1, ?2, ?3
        WHERE (SELECT COUNT(*) FROM streak_freezes
                WHERE user_id = ?2 AND substr(freeze_date, 1, 7) = substr(?3, 1, 7)) < ?4`,
      [habit.id, req.user.id, freeze_date, FREEZES_PER_MONTH],
    );
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw conflict('That day is already frozen');
    throw err;
  }
  if (result.changes === 0) throw conflict('No streak freezes left for that month');

  res.status(201).json({
    freeze: { id: result.lastInsertRowid, habit_id: habit.id, freeze_date },
    freezes_left: await freezesLeft(req.user.id),
  });
});

module.exports = { habitFreezes };
