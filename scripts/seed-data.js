'use strict';

// Single source of truth for the demo data. scripts/seed.js inserts it and
// scripts/update-readme.js renders SEED_ACCOUNTS into README.md.
//
// No passwords here: scripts/seed.js generates a random one per account on
// every run and prints them once. They are shared with the evaluator privately.

const SEED_ACCOUNTS = [
  { username: 'alice', email: 'alice@example.com', role: 'user' },
  { username: 'bob', email: 'bob@example.com', role: 'user' },
  { username: 'carol', email: 'carol@example.com', role: 'user' },
  { username: 'admin', email: 'admin@example.com', role: 'admin' },
  { username: 'moderator', email: 'moderator@example.com', role: 'admin' },
];

// [owner, title, description, category, isPublic, check-ins in the last 30 days]
const SEED_HABITS = [
  ['alice', 'Morning run', '5 km before breakfast. Rain or shine.', 'fitness', true, 14],
  ['alice', 'Read 20 pages', 'Currently reading a history of maps.', 'learning', true, 18],
  ['alice', 'No phone after 10pm', 'Charge it in the kitchen.', 'mindfulness', true, 9],
  ['alice', 'Therapy homework', 'Private notes for my sessions.', 'health', false, 6],
  ['alice', 'Call grandma', 'Every Sunday at least.', 'social', false, 4],
  ['bob', 'Drink 2 litres of water', 'Two bottles at the desk.', 'health', true, 20],
  ['bob', 'Practice guitar', '15 minutes of scales, then a song.', 'learning', true, 11],
  ['bob', 'Inbox zero by 6pm', '', 'productivity', true, 8],
  ['bob', 'Push-ups', '3 sets, add one rep a week.', 'fitness', true, 16],
  ['bob', 'Budget review', 'Check spending against the plan.', 'productivity', false, 5],
  ['carol', 'Meditate 10 minutes', 'Guided session after lunch.', 'mindfulness', true, 19],
  ['carol', 'Learn Turkish vocabulary', '10 new words a day.', 'learning', true, 22],
  ['carol', 'Cook dinner at home', 'No takeaway on weekdays.', 'health', true, 12],
  ['carol', 'Write in a journal', 'Three lines minimum.', 'mindfulness', false, 15],
  ['carol', 'Stretch before bed', '', 'fitness', true, 10],
  ['carol', 'Message an old friend', 'One person a week.', 'social', true, 4],
  ['admin', 'Review moderation queue', 'Daily check of reported content.', 'productivity', false, 7],
  ['admin', 'Walk 8,000 steps', '', 'fitness', true, 13],
  ['admin', 'Water the plants', 'Monstera needs it every 3 days.', 'other', true, 9],
  ['moderator', 'Learn SQL window functions', 'One exercise a day.', 'learning', true, 8],
  ['moderator', 'Evening walk', 'Leave the phone at home.', 'fitness', false, 11],
  ['moderator', 'Gratitude list', 'Three things, every night.', 'mindfulness', true, 16],
];

const CHECKIN_NOTES = [
  'Felt great today.',
  'Hard to start, glad I did it.',
  'Did half — still counts.',
  'Easy one today.',
  'Late, but done.',
  '',
  '',
  '',
];

// [habit title, commenter, comment]
const SEED_COMMENTS = [
  ['Morning run', 'bob', 'Rain or shine is serious commitment. Respect!'],
  ['Morning run', 'carol', 'What app do you use to track distance?'],
  ['Read 20 pages', 'carol', 'A history of maps sounds great — title please?'],
  ['Drink 2 litres of water', 'alice', 'The two-bottle trick works for me too.'],
  ['Practice guitar', 'moderator', 'Scales first is the right call. Keep going.'],
  ['Push-ups', 'alice', 'Adding one rep a week adds up fast!'],
  ['Push-ups', 'carol', 'How many are you at now?'],
  ['Meditate 10 minutes', 'bob', 'After lunch is a clever slot.'],
  ['Learn Turkish vocabulary', 'alice', 'Kolay gelsin! Ten words a day really adds up.'],
  ['Learn Turkish vocabulary', 'bob', 'Which word list are you using?'],
  ['Cook dinner at home', 'admin', 'Saves money too. Nice one.'],
  ['Walk 8,000 steps', 'bob', 'Steady streak!'],
  ['Gratitude list', 'carol', 'I started this after seeing yours.'],
  ['Learn SQL window functions', 'alice', 'ROW_NUMBER changed my life.'],
  ['Stretch before bed', 'moderator', 'Good for sleep, I can confirm.'],
];

module.exports = { SEED_ACCOUNTS, SEED_HABITS, CHECKIN_NOTES, SEED_COMMENTS };
