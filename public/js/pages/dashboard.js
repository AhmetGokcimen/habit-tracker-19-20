// "Today": the signed-in user's own habits, today's tally and quick check-in.

import { api, ApiError } from '../api.js';
import { el, $, fill, localISODate, addDays, formatShortDate, formatDate } from '../dom.js';
import { initPage, toast, errorMessage } from '../shell.js';
import { reveal } from '../motion.js';
import { createMascot } from '../mascot.js';
import { categoryChip, visibilityLabel, chain, streakBadge, habitDialog, isDue, scheduleLabel, announceNewBadges, chainCalendar } from '../components.js';

const main = $('#main');
const today = localISODate();
let habits = [];
let freezesLeft = 0;
let buddy = null; // { node, mascot, bubble }
let arranging = false;
let archivedList = null; // null = not loaded / hidden
let chainYear = Number(today.slice(0, 4));
let chainDays = [];

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

// Measurable habits: today's amount with -/+ steps (atomic on the server).
function todayAmount(habit) {
  return habit.latest_checkins.find((c) => c.checkin_date === today)?.amount ?? 0;
}

async function step(habit, delta, buttons) {
  buttons.forEach((b) => (b.disabled = true));
  try {
    const before = doneToday(habit);
    const res = await api.post(`/api/habits/${habit.id}/checkins/progress`, { checkin_date: today, delta });
    const amount = res.checkin?.amount ?? 0;
    if (!before && amount >= habit.target_count) toast(`Goal reached: ${habit.title}`);
    await load();
    if (!before && amount >= habit.target_count) buddy?.mascot.react('happy');
  } catch (err) {
    buttons.forEach((b) => (b.disabled = false));
    toast(errorMessage(err), { error: true });
  }
}

function counter(habit) {
  const amount = todayAmount(habit);
  const unit = habit.unit || 'times';
  const minus = el('button', { class: 'btn btn-ghost btn-sm', text: '−', attrs: { type: 'button', 'aria-label': `Remove one from ${habit.title}` } });
  const plus = el('button', { class: 'btn btn-accent btn-sm', text: '+1', attrs: { type: 'button', 'aria-label': `Add one to ${habit.title}` } });
  minus.disabled = amount === 0;
  minus.addEventListener('click', () => step(habit, -1, [minus, plus]));
  plus.addEventListener('click', () => step(habit, 1, [minus, plus]));
  return el(
    'div',
    { class: 'counter' },
    el(
      'div',
      { class: 'counter-text' },
      el('strong', { text: String(amount) }),
      ` / ${habit.target_count} ${unit}`,
      el('span', { class: 'counter-bar', vars: { '--w': `${Math.min(100, (amount / habit.target_count) * 100)}%` } }),
    ),
    el('div', { class: 'counter-buttons' }, minus, plus),
  );
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

// ---- arrange (drag and drop, plus up/down buttons for keyboards) ----------------

async function saveOrder() {
  try {
    await api.put('/api/habits/order', { ids: habits.map((h) => h.id) });
  } catch (err) {
    toast(errorMessage(err), { error: true });
    await load();
  }
}

function move(habit, by) {
  const from = habits.indexOf(habit);
  const to = from + by;
  if (to < 0 || to >= habits.length) return;
  habits.splice(from, 1);
  habits.splice(to, 0, habit);
  render();
  saveOrder();
  $(`[data-arrange="${habit.id}"][data-dir="${by < 0 ? 'up' : 'down'}"]`)?.focus();
}

function arrangeTools(habit) {
  const i = habits.indexOf(habit);
  const up = el('button', { class: 'btn btn-ghost btn-sm', text: '↑', dataset: { arrange: String(habit.id), dir: 'up' }, attrs: { type: 'button', 'aria-label': `Move ${habit.title} up` } });
  const down = el('button', { class: 'btn btn-ghost btn-sm', text: '↓', dataset: { arrange: String(habit.id), dir: 'down' }, attrs: { type: 'button', 'aria-label': `Move ${habit.title} down` } });
  up.disabled = i === 0;
  down.disabled = i === habits.length - 1;
  up.addEventListener('click', () => move(habit, -1));
  down.addEventListener('click', () => move(habit, 1));
  return el('div', { class: 'arrange-tools' }, el('span', { class: 'grip', text: '⠿ drag', attrs: { 'aria-hidden': 'true' } }), up, down);
}

let dragging = null;

function makeDraggable(card, habit) {
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    dragging = habit;
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    dragging = null;
    card.classList.remove('is-dragging');
  });
  card.addEventListener('dragover', (e) => {
    if (dragging && dragging !== habit) e.preventDefault();
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragging || dragging === habit) return;
    habits.splice(habits.indexOf(dragging), 1);
    habits.splice(habits.indexOf(habit) + (e.offsetY > card.offsetHeight / 2 ? 1 : 0), 0, dragging);
    render();
    saveOrder();
  });
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
  const measured = habit.target_count > 1 ? counter(habit) : null;
  let rescue = null;
  if (rescuable(habit)) {
    rescue = el('button', { class: 'btn btn-ghost btn-sm freeze-btn', text: '❄ Freeze yesterday', attrs: { type: 'button', title: `Missed yesterday? Use a streak freeze (${freezesLeft} left this month).` } });
    rescue.addEventListener('click', () => freezeYesterday(habit, rescue));
  }
  const weekly = habit.schedule.type === 'weekly'
    ? el('p', { class: 'mono muted', text: `${habit.week_count} of ${habit.schedule.times} this week` })
    : null;

  const card = el(
    'article',
    { class: `card habit-card${arranging ? ' is-arranging' : ' tilt'}` },
    arranging ? arrangeTools(habit) : null,
    el('div', { class: 'meta' }, categoryChip(habit.category), el('span', { class: 'schedule', text: scheduleLabel(habit.schedule) }), visibilityLabel(habit.is_public)),
    el(
      'div',
      {},
      el('h3', {}, el('a', { text: habit.title, attrs: { href: `/habit.html?id=${habit.id}` } })),
      habit.description ? el('p', { class: 'desc', text: habit.description }) : null,
    ),
    chain(habit.recent_checkins, 21, habit),
    measured,
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
      measured && !isDone ? null : action,
    ),
  );
  if (arranging) makeDraggable(card, habit);
  return card;
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

  const arrange = el('button', { class: 'btn btn-ghost btn-sm', text: arranging ? 'Done arranging' : 'Arrange', attrs: { type: 'button', 'aria-pressed': String(arranging) } });
  arrange.hidden = habits.length < 2;
  arrange.addEventListener('click', () => {
    arranging = !arranging;
    render();
  });
  const showArchived = el('button', { class: 'btn btn-ghost btn-sm', text: archivedList ? 'Hide archived' : 'Archived', attrs: { type: 'button' } });
  showArchived.addEventListener('click', toggleArchived);

  fill(
    main,
    head,
    el(
      'section',
      { class: 'section' },
      el(
        'div',
        { class: 'section-head' },
        el('h2', { text: 'Your habits' }),
        el('div', { class: 'section-tools' }, el('span', { class: 'mono muted', text: `${habits.length} active` }), arrange, showArchived),
      ),
      body,
      archivedList ? archivedSection() : null,
    ),
    habits.length ? el('section', { class: 'section', attrs: { id: 'chain' } }, wallCalendar()) : null,
  );
}

// ---- archived habits -----------------------------------------------------------

async function toggleArchived() {
  if (archivedList) {
    archivedList = null;
  } else {
    try {
      ({ habits: archivedList } = await api.get('/api/habits/mine?archived=1'));
    } catch (err) {
      toast(errorMessage(err), { error: true });
      return;
    }
  }
  render();
}

function archivedSection() {
  return el(
    'div',
    { class: 'archived section' },
    el('h3', { text: 'Archived' }),
    archivedList.length === 0
      ? el('p', { class: 'muted', text: 'Nothing archived. Archive a habit from its page to pause it without losing its history.' })
      : el(
          'ul',
          { class: 'archived-list' },
          archivedList.map((h) => {
            const restore = el('button', { class: 'btn btn-sm', text: 'Restore', attrs: { type: 'button', 'aria-label': `Restore ${h.title}` } });
            restore.addEventListener('click', async () => {
              restore.disabled = true;
              try {
                await api.patch(`/api/habits/${h.id}`, { archived: false });
                toast(`Restored: ${h.title}`);
                archivedList = archivedList.filter((x) => x.id !== h.id);
                await load();
              } catch (err) {
                restore.disabled = false;
                toast(errorMessage(err), { error: true });
              }
            });
            return el('li', {}, el('a', { text: h.title, attrs: { href: `/habit.html?id=${h.id}` } }), el('span', { class: 'mono muted', text: `${h.checkin_count} check-ins` }), restore);
          }),
        ),
  );
}

// Overall day state for the wall calendar: X when everything due was done.
function wallCalendar() {
  const first = habits.reduce((min, h) => (h.created_at.slice(0, 10) < min ? h.created_at.slice(0, 10) : min), today);
  const states = new Map();
  for (const d of chainDays) {
    if (d.date < first || d.date > today) continue;
    let state;
    if (d.due === 0) state = 'rest';
    else if (d.done === d.due) state = 'done';
    else if (d.done + d.frozen === d.due) state = 'frozen';
    else if (d.done > 0) state = 'partial';
    else if (d.date !== today) state = 'missed';
    if (state) states.set(d.date, state);
  }
  return chainCalendar({
    year: chainYear,
    states,
    minYear: Number(first.slice(0, 4)),
    onYear: async (year) => {
      chainYear = year;
      await loadChain();
      render();
      $('#chain')?.scrollIntoView({ block: 'nearest' });
    },
  });
}

async function loadChain() {
  try {
    ({ days: chainDays } = await api.get(`/api/users/me/chain?year=${chainYear}`));
  } catch {
    chainDays = [];
  }
}

async function load() {
  [{ habits, freezes_left: freezesLeft }] = await Promise.all([api.get('/api/habits/mine'), loadChain()]);
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
