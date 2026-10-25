// Reusable UI pieces: category chip, schedules, the stamped chain of days,
// streaks, and the create/edit habit dialog. All text is set with textContent via el().

import { api } from './api.js';
import { el, localISODate, addDays } from './dom.js';
import { showFormErrors, clearFormErrors, withBusy, toast } from './shell.js';

export const CATEGORIES = ['health', 'fitness', 'learning', 'productivity', 'mindfulness', 'social', 'other'];

export function categoryChip(category) {
  const safe = CATEGORIES.includes(category) ? category : 'other';
  return el('span', { class: 'chip', text: safe, dataset: { cat: safe } });
}

export function visibilityLabel(isPublic) {
  return el('span', { class: 'visibility', text: isPublic ? '● shared' : '○ private' });
}

// ---- schedules (mirror of src/services/schedule.js; the server decides streaks) ----

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday of a local "YYYY-MM-DD": 1 = Monday ... 7 = Sunday. */
export function isoWeekday(isoDate) {
  return ((new Date(`${isoDate}T12:00:00`).getDay() + 6) % 7) + 1;
}

/** Is the habit expected on this day? Weekly habits may be done any day. */
export function isDue(habit, isoDate) {
  const s = habit.schedule;
  return s?.type !== 'weekdays' || s.days.includes(isoWeekday(isoDate));
}

export function scheduleLabel(schedule) {
  if (schedule?.type === 'weekdays') {
    const days = [...schedule.days].sort((a, b) => a - b);
    if (days.join() === '1,2,3,4,5') return 'weekdays';
    if (days.join() === '6,7') return 'weekends';
    return days.map((d) => WEEKDAYS[d - 1]).join(' · ');
  }
  if (schedule?.type === 'weekly') return `${schedule.times}× a week`;
  return 'every day';
}

// Small deterministic tilt per date so stamped days look hand-made.
function stampRotation(isoDate) {
  let h = 0;
  for (const ch of isoDate) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return `${(h % 7) - 3}deg`;
}

/**
 * Last `days` days ending today; filled cells are days with a check-in,
 * faded cells are days the habit is not due.
 */
export function chain(dates, days = 21, habit = null) {
  const done = new Set(dates);
  const frozen = new Set(habit?.recent_freezes ?? []);
  const today = localISODate();
  const cells = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const isDone = done.has(date);
    const isFrozen = !isDone && frozen.has(date);
    const isOff = !isDone && !isFrozen && habit && !isDue(habit, date);
    const state = isDone ? ' is-done' : isFrozen ? ' is-frozen' : isOff ? ' is-off' : '';
    cells.push(
      el('span', {
        class: `day${state}${i === 0 ? ' is-today' : ''}`,
        attrs: { title: `${date}${isDone ? ' — checked in' : isFrozen ? ' — frozen' : isOff ? ' — rest day' : ''}` },
        vars: { '--r': isDone ? stampRotation(date) : '0deg', '--i': days - i },
      }),
    );
  }
  return el(
    'div',
    {},
    el('div', { class: 'chain', attrs: { role: 'img', 'aria-label': `${dates.filter((d) => d >= addDays(today, -(days - 1))).length} check-ins in the last ${days} days` } }, cells),
    el('div', { class: 'chain-legend', attrs: { 'aria-hidden': 'true' } }, el('span', { text: `${days} days ago` }), el('span', { text: 'today' })),
  );
}

/** streak = { current, unit: 'days' | 'weeks' } as computed by the server. */
export function streakBadge(streak) {
  const n = streak?.current ?? 0;
  const unit = streak?.unit === 'weeks' ? 'week' : 'day';
  return el('span', { class: 'streak' }, el('strong', { text: String(n) }), `${unit} streak`);
}

function field(name, label, control, hint) {
  return el(
    'div',
    { class: 'field', dataset: { field: name } },
    el('label', { text: label, attrs: { for: control.id } }),
    control,
    hint ? el('p', { class: 'hint', text: hint }) : null,
  );
}

/**
 * Opens the create / edit habit dialog. Resolves with the saved habit, or
 * null when cancelled. The server validates every field again.
 */
export function habitDialog(habit = null) {
  return new Promise((resolve) => {
    const title = el('input', { class: 'input', attrs: { id: 'hf-title', name: 'title', required: true, maxlength: 100 } });
    const description = el('textarea', { class: 'textarea', attrs: { id: 'hf-description', name: 'description', maxlength: 1000 } });
    const category = el(
      'select',
      { class: 'select', attrs: { id: 'hf-category', name: 'category', required: true } },
      CATEGORIES.map((c) => el('option', { text: c, attrs: { value: c } })),
    );
    const isPublic = el('input', { attrs: { type: 'checkbox', name: 'is_public', id: 'hf-public' } });
    const sched = scheduleField(habit?.schedule ?? { type: 'daily' });
    const reminder = el('input', { class: 'input input-time', attrs: { id: 'hf-reminder', name: 'reminder_time', type: 'time' } });
    reminder.value = habit?.reminder_time ?? '';

    if (habit) {
      title.value = habit.title;
      description.value = habit.description;
      category.value = habit.category;
      isPublic.checked = habit.is_public;
    }

    const cancel = el('button', { class: 'btn btn-ghost', text: 'Cancel', attrs: { type: 'button' } });
    const save = el('button', { class: 'btn btn-primary', text: habit ? 'Save changes' : 'Add habit', attrs: { type: 'submit' } });
    const form = el(
      'form',
      { class: 'form', attrs: { novalidate: true } },
      field('title', 'What will you do?', title),
      field('description', 'Notes (optional)', description, 'Up to 1000 characters.'),
      field('category', 'Category', category),
      sched.node,
      field('reminder_time', 'Remind me at (optional)', reminder, 'A reminder appears while Habit Tracker is open in a tab. Only you see this time.'),
      el(
        'div',
        { class: 'field', dataset: { field: 'is_public' } },
        el('label', { class: 'check', attrs: { for: 'hf-public' } }, isPublic, 'Share on Explore'),
        el('p', { class: 'hint', text: 'Others can see the title and description and leave comments. Your check-ins stay private.' }),
      ),
      el('div', { class: 'dialog-actions' }, cancel, save),
    );

    const dialog = el(
      'dialog',
      { class: 'dialog', attrs: { 'aria-labelledby': 'hf-heading' } },
      el('h2', { text: habit ? 'Edit habit' : 'New habit', attrs: { id: 'hf-heading' } }),
      el('div', { class: 'section' }, form),
    );

    const close = (result) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => close(null));
    dialog.addEventListener('cancel', () => close(null));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormErrors(form);
      if (!form.reportValidity()) return;
      const payload = {
        title: title.value.trim(),
        description: description.value.trim(),
        category: category.value,
        is_public: isPublic.checked,
        schedule: sched.value(),
        reminder_time: reminder.value ? reminder.value.slice(0, 5) : null,
      };
      await withBusy(save, async () => {
        try {
          const res = habit ? await api.patch(`/api/habits/${habit.id}`, payload) : await api.post('/api/habits', payload);
          close(res.habit);
        } catch (err) {
          showFormErrors(form, err);
        }
      });
    });

    document.body.append(dialog);
    dialog.showModal();
    title.focus();
  });
}

// "How often?" — daily, chosen weekdays, or N times a week.
function scheduleField(initial) {
  const name = `hf-sched-${Math.random().toString(36).slice(2, 8)}`;
  const radio = (value, label) => {
    const input = el('input', { attrs: { type: 'radio', name, value } });
    input.checked = initial.type === value;
    return { input, node: el('label', { class: 'check' }, input, label) };
  };
  const daily = radio('daily', 'Every day');
  const weekdays = radio('weekdays', 'On certain days');
  const weekly = radio('weekly', 'A number of times a week');

  const dayBoxes = WEEKDAYS.map((label, i) => {
    const box = el('input', { attrs: { type: 'checkbox', value: String(i + 1), 'aria-label': label } });
    box.checked = initial.type === 'weekdays' ? initial.days.includes(i + 1) : i < 5;
    return { box, node: el('label', { class: 'day-pick' }, box, el('span', { text: label })) };
  });
  const times = el(
    'select',
    { class: 'select select-sm', attrs: { 'aria-label': 'Times per week' } },
    [1, 2, 3, 4, 5, 6].map((n) => el('option', { text: `${n}× a week`, attrs: { value: String(n) } })),
  );
  times.value = String(initial.type === 'weekly' ? initial.times : 3);

  const dayRow = el('div', { class: 'day-picks' }, dayBoxes.map((d) => d.node));
  const timesRow = el('div', {}, times);
  const sync = () => {
    dayRow.hidden = !weekdays.input.checked;
    timesRow.hidden = !weekly.input.checked;
  };
  for (const r of [daily, weekdays, weekly]) r.input.addEventListener('change', sync);
  sync();

  const node = el(
    'fieldset',
    { class: 'field schedule-field', dataset: { field: 'schedule' } },
    el('legend', { text: 'How often?' }),
    daily.node,
    weekdays.node,
    dayRow,
    weekly.node,
    timesRow,
  );
  const value = () => {
    if (weekdays.input.checked) {
      return { type: 'weekdays', days: dayBoxes.filter((d) => d.box.checked).map((d) => Number(d.box.value)) };
    }
    if (weekly.input.checked) return { type: 'weekly', times: Number(times.value) };
    return { type: 'daily' };
  };
  return { node, value };
}

// ---- badges ---------------------------------------------------------------------

export function badgeTile(badge) {
  const { value, goal } = badge.progress;
  return el(
    'li',
    { class: `badge${badge.earned ? ' is-earned' : ''}`, attrs: { title: badge.description } },
    el('span', { class: 'badge-icon', text: badge.icon, attrs: { 'aria-hidden': 'true' } }),
    el('strong', { text: badge.title }),
    el('span', { class: 'hint', text: badge.description }),
    badge.earned
      ? el('span', { class: 'badge-state', text: 'Earned' })
      : el('span', { class: 'badge-progress', vars: { '--p': `${Math.round((value / goal) * 100)}%` }, attrs: { 'aria-label': `${value} of ${goal}` } }),
  );
}

/**
 * Toasts badges earned since the last visit. The list of already-seen badges
 * is a per-browser convenience in localStorage; the server is the source of
 * truth for what is earned. The first visit just records the current state.
 * Returns the newly earned badges.
 */
export function announceNewBadges(userId, badges) {
  const key = `badges-seen:${userId}`;
  const earned = badges.filter((b) => b.earned).map((b) => b.id);
  let seen = null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    seen = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : null;
    localStorage.setItem(key, JSON.stringify(earned));
  } catch {
    return [];
  }
  if (seen === null) return [];
  const fresh = badges.filter((b) => b.earned && !seen.includes(b.id));
  for (const b of fresh) toast(`${b.icon} New badge: ${b.title}`);
  return fresh;
}

// ---- "Don't break the chain" year calendar ------------------------------------------
//
// The paper wall calendar: twelve rows of months, a column per day of the
// month, and a big red X over every day you kept your habits.
//
// states: Map "YYYY-MM-DD" -> 'done' | 'partial' | 'frozen' | 'rest' | 'missed'
// Days without an entry are blank (before the habit existed, or in the future).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATE_TEXT = {
  done: 'kept — crossed off',
  partial: 'partly done',
  frozen: 'frozen',
  rest: 'rest day',
  missed: 'missed',
};

/** Longest and current run of 'done' days (frozen and rest days keep a run alive). */
export function chainRuns(states, year) {
  const today = localISODate();
  let run = 0;
  let longest = 0;
  for (let d = `${year}-01-01`; d <= `${year}-12-31` && d <= today; d = addDays(d, 1)) {
    const s = states.get(d);
    if (s === 'done') {
      run += 1;
      longest = Math.max(longest, run);
    } else if (s === 'frozen' || s === 'rest' || !s || d === today) {
      // keeps the run (today is still open)
    } else {
      run = 0;
    }
  }
  return { current: run, longest };
}

export function chainCalendar({ year, states, onYear, minYear = 2000 }) {
  const today = localISODate();
  const thisYear = Number(today.slice(0, 4));
  const grid = el('div', { class: 'wall-grid', attrs: { role: 'grid', 'aria-label': `Chain calendar ${year}` } });

  grid.append(el('span', { class: 'wall-corner', attrs: { 'aria-hidden': 'true' } }));
  for (let d = 1; d <= 31; d++) grid.append(el('span', { class: 'wall-daynum', text: String(d), attrs: { 'aria-hidden': 'true' } }));

  for (let m = 0; m < 12; m++) {
    const row = el('div', { class: 'wall-row', attrs: { role: 'row' } }, el('span', { class: 'wall-month', text: MONTHS[m], attrs: { role: 'rowheader' } }));
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    for (let d = 1; d <= 31; d++) {
      if (d > daysInMonth) {
        row.append(el('span', { class: 'wall-cell is-void', attrs: { 'aria-hidden': 'true' } }));
        continue;
      }
      const date = `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const state = states.get(date) ?? (date > today ? 'future' : 'blank');
      const label = `${MONTHS[m]} ${d}${STATE_TEXT[state] ? `: ${STATE_TEXT[state]}` : ''}`;
      row.append(
        el('span', {
          class: `wall-cell is-${state}${date === today ? ' is-today' : ''}`,
          attrs: { role: 'gridcell', title: label, 'aria-label': label },
          vars: { '--r': `${((d * 37 + m * 11) % 13) - 6}deg` },
        }),
      );
    }
    grid.append(row);
  }

  const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '‹', attrs: { type: 'button', 'aria-label': 'Previous year' } });
  const next = el('button', { class: 'btn btn-ghost btn-sm', text: '›', attrs: { type: 'button', 'aria-label': 'Next year' } });
  prev.disabled = year <= minYear;
  next.disabled = year >= thisYear;
  prev.addEventListener('click', () => onYear(year - 1));
  next.addEventListener('click', () => onYear(year + 1));

  const runs = chainRuns(states, year);
  const legend = el(
    'ul',
    { class: 'wall-legend' },
    [
      ['done', 'kept'],
      ['partial', 'partly'],
      ['frozen', 'frozen'],
      ['rest', 'rest day'],
      ['missed', 'missed'],
    ].map(([state, text]) => el('li', {}, el('span', { class: `wall-cell is-${state}`, attrs: { 'aria-hidden': 'true' } }), text)),
  );

  return el(
    'div',
    { class: 'wall card' },
    el(
      'div',
      { class: 'wall-head' },
      el(
        'div',
        {},
        el('h2', { text: 'Don’t break the chain' }),
        el('p', { class: 'hint', text: 'Every day you keep your habits gets a big red X. After a few days you have a chain — your only job is not to break it. Inspired by Barış Özcan’s “Zinciri Kırma” calendar.' }),
      ),
      el('div', { class: 'wall-year' }, prev, el('strong', { class: 'mono', text: String(year) }), next),
    ),
    el(
      'div',
      { class: 'wall-runs' },
      el('span', {}, el('strong', { text: String(runs.current) }), ' days in the current chain'),
      el('span', {}, el('strong', { text: String(runs.longest) }), ` longest in ${year}`),
    ),
    el('div', { class: 'wall-scroll' }, grid),
    legend,
  );
}
