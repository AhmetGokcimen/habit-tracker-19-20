// "Today": the signed-in user's own habits, today's tally and quick check-in.

import { api, ApiError } from '../api.js';
import { el, $, localISODate, addDays, formatShortDate, formatDate } from '../dom.js';
import { initPage, toast, errorMessage } from '../shell.js';
import { reveal } from '../motion.js';
import { createMascot } from '../mascot.js';
import { categoryChip, visibilityLabel, chain, streakBadge, habitDialog, isDue, scheduleLabel, announceNewBadges } from '../components.js';

const main = $('#main');
const today = localISODate();
let habits = [];
let freezesLeft = 0;
let buddy = null; // { node, mascot, bubble }

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}.`;
}

const doneToday = (h) => h.recent_checkins.includes(today);

// A weekly habit is "due" today until this week's target is reached.
function dueToday(h) {
  if (h.schedule.type === 'weekly') return doneToday(h) || h.week_count < h.schedule.times;
  return isDue(h, today);
}

function todayTally() {
  const due = habits.filter(dueToday);
  const done = due.filter(doneToday).length;
  const strokes = due.map((h, i) =>
    el('span', {
      class: `stroke${doneToday(h) ? ' is-done' : ''}`,
      vars: { '--r': (i + 1) % 5 === 0 ? '-62deg' : '0deg' },
    }),
  );
  const label = habits.length === 0
    ? 'Nothing to check in yet.'
    : due.length === 0
      ? 'A rest day — nothing is due today.'
      : done === due.length
        ? 'Everything is checked in for today.'
        : null;
  return el(
    'div',
    { class: 'today-tally' },
    el('div', { class: 'tally', attrs: { 'aria-hidden': 'true' } }, strokes),
    el(
      'p',
      { class: 'tally-label' },
      label ?? [el('strong', { text: String(done) }), ` of ${due.length} checked in today`],
    ),
  );
}

async function undo(checkinId, title) {
  try {
    await api.del(`/api/checkins/${checkinId}`);
    toast(`Undone: ${title}`);
    await load();
  } catch (err) {
    toast(errorMessage(err), { error: true });
  }
}

async function checkIn(habit, button) {
  button.disabled = true;
  try {
    const { checkin } = await api.post(`/api/habits/${habit.id}/checkins`, { checkin_date: today });
    toast(`Checked in: ${habit.title}`, { action: { label: 'Undo', onClick: () => undo(checkin.id, habit.title) } });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409)) {
      button.disabled = false;
      toast(errorMessage(err), { error: true });
      return;
    }
  }
  await load();
  buddy?.mascot.react('happy');
}

function undoButton(checkinId, title) {
  const b = el('button', { class: 'btn btn-ghost btn-sm', text: 'Undo', attrs: { type: 'button', 'aria-label': `Undo today's check-in: ${title}` } });
  b.addEventListener('click', () => {
    b.disabled = true;
    undo(checkinId, title);
  });
  return b;
}

// Offer a freeze when yesterday was a missed due day right after a done
// (or frozen) day — i.e. when a freeze would actually save a streak.
function rescuable(habit) {
  if (habit.schedule.type === 'weekly' || freezesLeft === 0) return false;
  const yesterday = addDays(today, -1);
  const before = addDays(today, -2);
  const covered = (d) => habit.recent_checkins.includes(d) || habit.recent_freezes.includes(d);
  return isDue(habit, yesterday) && !covered(yesterday) && covered(before);
}

async function freezeYesterday(habit, button) {
  button.disabled = true;
  try {
    const res = await api.post(`/api/habits/${habit.id}/freezes`, { freeze_date: addDays(today, -1) });
    toast(`Streak saved with a freeze — ${res.freezes_left} left this month`);
    await load();
  } catch (err) {
    button.disabled = false;
    toast(errorMessage(err), { error: true });
  }
}

function habitCard(habit) {
  const isDone = doneToday(habit);
  const resting = !isDone && !dueToday(habit);
  const todays = habit.latest_checkins.find((c) => c.checkin_date === today);
  const action = isDone
    ? el(
        'div',
        { class: 'done-group' },
        el('span', { class: 'checked-stamp', text: '✓ done today' }),
        todays ? undoButton(todays.id, habit.title) : null,
      )
    : el('button', {
        class: `btn btn-sm ${resting ? 'btn-ghost' : 'btn-accent'}`,
        text: resting ? 'Do it anyway' : 'Check in',
        attrs: { type: 'button', 'aria-label': `Check in: ${habit.title}` },
      });
  if (!isDone) action.addEventListener('click', () => checkIn(habit, action));
  let rescue = null;
  if (rescuable(habit)) {
    rescue = el('button', { class: 'btn btn-ghost btn-sm freeze-btn', text: '❄ Freeze yesterday', attrs: { type: 'button', title: `Missed yesterday? Use a streak freeze (${freezesLeft} left this month).` } });
    rescue.addEventListener('click', () => freezeYesterday(habit, rescue));
  }
  const weekly = habit.schedule.type === 'weekly'
    ? el('p', { class: 'mono muted', text: `${habit.week_count} of ${habit.schedule.times} this week` })
    : null;

  return el(
    'article',
    { class: 'card tilt habit-card' },
    el('div', { class: 'meta' }, categoryChip(habit.category), el('span', { class: 'schedule', text: scheduleLabel(habit.schedule) }), visibilityLabel(habit.is_public)),
    el(
      'div',
      {},
      el('h3', {}, el('a', { text: habit.title, attrs: { href: `/habit.html?id=${habit.id}` } })),
      habit.description ? el('p', { class: 'desc', text: habit.description }) : null,
    ),
    chain(habit.recent_checkins, 21, habit),
    el(
      'div',
      { class: 'actions' },
      el(
        'div',
        {},
        streakBadge(habit.streak),
        weekly,
        rescue,
        el('p', { class: 'mono muted', text: habit.last_checkin ? `last: ${formatDate(habit.last_checkin)}` : 'no check-ins yet' }),
      ),
      action,
    ),
  );
}

async function addHabit() {
  const created = await habitDialog();
  if (created) {
    toast(`Added: ${created.title}`);
    await load();
  }
}

// Sprout reacts to today's progress and grows with the best current streak.
function buddyMood() {
  const due = habits.filter(dueToday);
  const done = due.filter(doneToday).length;
  const best = Math.max(0, ...habits.map((h) => (h.streak.unit === 'days' ? h.streak.current : h.streak.current * 7)));
  let mood = 'neutral';
  let line;
  if (habits.length === 0) line = 'Hi! Add a habit and I’ll keep you company.';
  else if (due.length === 0) line = 'Rest day. I’m just here to grow.';
  else if (done === 0) {
    mood = 'sleepy';
    line = 'Wake me up with your first check-in…';
  } else if (done < due.length) line = `${due.length - done} to go. You’ve got this!`;
  else {
    mood = 'proud';
    line = 'All done today. Look at me grow!';
  }
  return { mood, line, growth: Math.min(best, 30) / 30 };
}

function renderBuddy() {
  if (!buddy) {
    const node = el('div', { class: 'buddy-figure', attrs: { role: 'img', 'aria-label': 'Sprout, your habit buddy' } });
    const bubble = el('p', { class: 'buddy-bubble', attrs: { 'aria-live': 'polite' } });
    buddy = { node: el('div', { class: 'buddy' }, bubble, node), mascot: createMascot(node, { covering: false }), bubble };
    addEventListener('pointermove', (e) => buddy.mascot.lookAt(e.clientX, e.clientY));
  }
  const { mood, line, growth } = buddyMood();
  buddy.mascot.setMood(mood, growth);
  buddy.bubble.textContent = line;
  return buddy.node;
}

function render() {
  const user = main.dataset.username;
  const newButton = el('button', { class: 'btn btn-primary', text: '+ New habit', attrs: { type: 'button' } });
  newButton.addEventListener('click', addHabit);

  const head = el(
    'header',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('p', { class: 'eyebrow', text: formatShortDate(today) }),
      el('h1', { text: greeting(user) }),
      todayTally(),
    ),
    el('div', { class: 'head-side' }, renderBuddy(), newButton),
  );

  let body;
  if (habits.length === 0) {
    const start = el('button', { class: 'btn btn-accent', text: 'Add your first habit', attrs: { type: 'button' } });
    start.addEventListener('click', addHabit);
    body = el(
      'div',
      { class: 'empty' },
      el('h2', { text: 'Your journal is empty' }),
      el('p', { class: 'muted', text: 'Add one thing you want to do every day. You can keep it private or share it on Explore.' }),
      start,
    );
  } else {
    body = el('div', { class: 'grid' }, habits.map(habitCard));
  }

  main.replaceChildren(head, el('section', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Your habits' }), el('span', { class: 'mono muted', text: `${habits.length} total` })), body));
}

async function load() {
  ({ habits, freezes_left: freezesLeft } = await api.get('/api/habits/mine'));
  render();
  checkBadges();
}

async function checkBadges() {
  try {
    const { user, badges } = await api.get('/api/users/me');
    announceNewBadges(user.id, badges);
  } catch {
    // badges are a bonus; the page works without them
  }
}

const user = await initPage({ active: 'today' });
main.dataset.username = user.username;
await load();
reveal([...main.children, ...main.querySelectorAll('.habit-card')]);
