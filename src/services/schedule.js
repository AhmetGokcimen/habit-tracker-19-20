'use strict';

// Habit schedules and streaks. The single place that decides whether a habit
// is due on a day and how long its streak is; routes only call these helpers.
//
// API shape of a schedule (validated by validators/schemas.js):
//   { type: 'daily' }
//   { type: 'weekdays', days: [1, 3, 5] }   ISO weekdays, 1 = Monday ... 7 = Sunday
//   { type: 'weekly', times: 3 }            3 times per Monday-to-Sunday week
//
// Database columns: frequency, days_mask (bit 0 = Monday), weekly_target.

const DAY_MS = 24 * 60 * 60 * 1000;

// Day numbers (days since 1970-01-01, UTC) make date arithmetic exact.
const dayNumber = (isoDate) => Math.round(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
const isoDate = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
// 1970-01-01 was a Thursday (ISO weekday 4).
const isoWeekday = (n) => (((n + 3) % 7) + 7) % 7 + 1;
// Monday-based week index; day -3 (1969-12-29) was a Monday.
const weekIndex = (n) => Math.floor((n + 3) / 7);

const todayNumber = () => Math.floor(Date.now() / DAY_MS);

function toColumns(schedule) {
  switch (schedule.type) {
    case 'weekdays':
      return {
        frequency: 'weekdays',
        days_mask: schedule.days.reduce((mask, d) => mask | (1 << (d - 1)), 0),
        weekly_target: 7,
      };
    case 'weekly':
      return { frequency: 'weekly', days_mask: 127, weekly_target: schedule.times };
    default:
      return { frequency: 'daily', days_mask: 127, weekly_target: 7 };
  }
}

function fromRow(row) {
  if (row.frequency === 'weekdays') {
    const days = [];
    for (let d = 1; d <= 7; d++) if (row.days_mask & (1 << (d - 1))) days.push(d);
    return { type: 'weekdays', days };
  }
  if (row.frequency === 'weekly') return { type: 'weekly', times: row.weekly_target };
  return { type: 'daily' };
}

/** Is a check-in expected on this day? Weekly habits may be done on any day. */
function isDueOn(row, n) {
  if (row.frequency !== 'weekdays') return true;
  return Boolean(row.days_mask & (1 << (isoWeekday(n) - 1)));
}

/**
 * Current and longest streak.
 *   daily / weekdays : counted in due days. A missed due day breaks the run,
 *                      except today (still open) and frozen days (kept, not counted).
 *                      A check-in on a day that is not due still counts.
 *   weekly           : counted in weeks that reached the target. The current
 *                      week is still open. A frozen day counts as one completion.
 *
 * @param row        habit row (frequency, days_mask, weekly_target)
 * @param doneDates  ISO dates on which the habit was completed
 * @param frozenDates ISO dates covered by a streak freeze
 * @param today      day number of "today" (defaults to the UTC date)
 */
function streaks(row, doneDates, frozenDates = [], today = todayNumber()) {
  const done = new Set(doneDates.map(dayNumber));
  const frozen = new Set(frozenDates.map(dayNumber));
  const unit = row.frequency === 'weekly' ? 'weeks' : 'days';
  if (done.size === 0) return { current: 0, longest: 0, unit };

  let first = Infinity;
  let last = today;
  for (const n of done) {
    first = Math.min(first, n);
    last = Math.max(last, n); // a client ahead of UTC may already be "tomorrow"
  }

  let run = 0;
  let longest = 0;

  if (unit === 'weeks') {
    const perWeek = new Map();
    for (const n of new Set([...done, ...frozen])) {
      if (n < first) continue;
      const w = weekIndex(n);
      perWeek.set(w, (perWeek.get(w) ?? 0) + 1);
    }
    const lastWeek = weekIndex(last);
    for (let w = weekIndex(first); w <= lastWeek; w++) {
      if ((perWeek.get(w) ?? 0) >= row.weekly_target) {
        run += 1;
        longest = Math.max(longest, run);
      } else if (w !== lastWeek) {
        run = 0;
      }
    }
    return { current: run, longest, unit };
  }

  for (let n = first; n <= last; n++) {
    if (done.has(n)) {
      run += 1;
      longest = Math.max(longest, run);
    } else if (isDueOn(row, n) && !frozen.has(n) && n < last) {
      run = 0;
    }
  }
  return { current: run, longest, unit };
}

module.exports = { toColumns, fromRow, isDueOn, streaks, dayNumber, isoDate, isoWeekday, weekIndex, todayNumber, DAY_MS };
