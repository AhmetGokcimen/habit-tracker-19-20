// "Today": the signed-in user's own habits, today's tally and quick check-in.

import { api, ApiError } from '../api.js';
import { el, $, localISODate, formatShortDate, formatDate } from '../dom.js';
import { initPage, toast, errorMessage } from '../shell.js';
import { reveal } from '../motion.js';
import { categoryChip, visibilityLabel, chain, currentStreak, streakBadge, habitDialog } from '../components.js';

const main = $('#main');
const today = localISODate();
let habits = [];

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}.`;
}

function todayTally() {
  const done = habits.filter((h) => h.recent_checkins.includes(today)).length;
  const strokes = habits.map((h, i) =>
    el('span', {
      class: `stroke${h.recent_checkins.includes(today) ? ' is-done' : ''}`,
      vars: { '--r': (i + 1) % 5 === 0 ? '-62deg' : '0deg' },
    }),
  );
  const label = habits.length === 0
    ? 'Nothing to check in yet.'
    : done === habits.length
      ? 'Everything is checked in for today.'
      : null;
  return el(
    'div',
    { class: 'today-tally' },
    el('div', { class: 'tally', attrs: { 'aria-hidden': 'true' } }, strokes),
    el(
      'p',
      { class: 'tally-label' },
      label ?? [el('strong', { text: String(done) }), ` of ${habits.length} checked in today`],
    ),
  );
}

async function checkIn(habit, button) {
  button.disabled = true;
  try {
    await api.post(`/api/habits/${habit.id}/checkins`, { checkin_date: today });
    toast(`Checked in: ${habit.title}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409)) {
      button.disabled = false;
      toast(errorMessage(err), { error: true });
      return;
    }
  }
  habit.recent_checkins = [...new Set([...habit.recent_checkins, today])].sort();
  habit.checkin_count += 1;
  render();
}

function habitCard(habit) {
  const doneToday = habit.recent_checkins.includes(today);
  const action = doneToday
    ? el('span', { class: 'checked-stamp', text: '✓ done today' })
    : el('button', { class: 'btn btn-accent btn-sm', text: 'Check in', attrs: { type: 'button', 'aria-label': `Check in: ${habit.title}` } });
  if (!doneToday) action.addEventListener('click', () => checkIn(habit, action));

  return el(
    'article',
    { class: 'card tilt habit-card' },
    el('div', { class: 'meta' }, categoryChip(habit.category), visibilityLabel(habit.is_public)),
    el(
      'div',
      {},
      el('h3', {}, el('a', { text: habit.title, attrs: { href: `/habit.html?id=${habit.id}` } })),
      habit.description ? el('p', { class: 'desc', text: habit.description }) : null,
    ),
    chain(habit.recent_checkins),
    el(
      'div',
      { class: 'actions' },
      el(
        'div',
        {},
        streakBadge(currentStreak(habit.recent_checkins)),
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
    newButton,
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
  ({ habits } = await api.get('/api/habits/mine'));
  render();
}

const user = await initPage({ active: 'today' });
main.dataset.username = user.username;
await load();
reveal([...main.children, ...main.querySelectorAll('.habit-card')]);
