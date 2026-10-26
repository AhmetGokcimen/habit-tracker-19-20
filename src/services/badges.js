'use strict';

// Badges are derived on the fly from the user's own numbers (see
// routes/users.js /me). Nothing is stored and nothing can be "claimed" by a
// request, so there is no endpoint to tamper with. Several badges come from
// private check-ins, so badges are only ever shown to their owner.

const BADGES = [
  { id: 'first-checkin', icon: '🌱', title: 'First mark', description: 'Check in for the first time.', metric: 'checkins', goal: 1 },
  { id: 'streak-7', icon: '🔥', title: 'One week strong', description: 'Reach a 7-day streak.', metric: 'longest_streak', goal: 7 },
  { id: 'streak-30', icon: '🏅', title: 'Month of momentum', description: 'Reach a 30-day streak.', metric: 'longest_streak', goal: 30 },
  { id: 'streak-100', icon: '💯', title: 'Century', description: 'Reach a 100-day streak.', metric: 'longest_streak', goal: 100 },
  { id: 'checkins-50', icon: '✍️', title: 'Fifty marks', description: 'Check in 50 times.', metric: 'checkins', goal: 50 },
  { id: 'checkins-100', icon: '📒', title: 'Full notebook', description: 'Check in 100 times.', metric: 'checkins', goal: 100 },
  { id: 'checkins-365', icon: '🗓️', title: 'A year of marks', description: 'Check in 365 times.', metric: 'checkins', goal: 365 },
  { id: 'first-photo', icon: '📸', title: 'Proof positive', description: 'Add a proof photo to a check-in.', metric: 'photos', goal: 1 },
  { id: 'sharer', icon: '📣', title: 'Out loud', description: 'Share a habit on Explore.', metric: 'public_habits', goal: 1 },
  { id: 'collector', icon: '🗂️', title: 'Full shelf', description: 'Keep 5 habits.', metric: 'habits', goal: 5 },
  { id: 'encourager', icon: '👏', title: 'Cheerleader', description: 'Leave 10 encouraging comments.', metric: 'comments', goal: 10 },
  { id: 'ice', icon: '❄️', title: 'Cool head', description: 'Save a streak with a freeze.', metric: 'freezes', goal: 1 },
];

/** stats: numeric counters keyed by metric name. */
function evaluateBadges(stats) {
  return BADGES.map(({ id, icon, title, description, metric, goal }) => {
    const value = Math.min(Number(stats[metric]) || 0, goal);
    return { id, icon, title, description, earned: value >= goal, progress: { value, goal } };
  });
}

module.exports = { BADGES, evaluateBadges };
