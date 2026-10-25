// Habit detail: description, private check-in history with proof photos
// (owner/admin only), and the public comment thread.
// Buttons are only shown to people who may use them; the server re-checks
// every action anyway.

import { api, ApiError } from '../api.js';
import { el, $, idFromQuery, localISODate, addDays, formatDate, formatTimestamp } from '../dom.js';
import { initPage, toast, errorMessage, confirmDialog, showFormErrors, clearFormErrors, withBusy } from '../shell.js';
import { reveal } from '../motion.js';
import { categoryChip, visibilityLabel, streakBadge, habitDialog, isDue, scheduleLabel, chainCalendar } from '../components.js';

const MAX_PHOTO_BYTES = 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const main = $('#main');
const habitId = idFromQuery();
let user;
let habit;
let checkins = [];
let streak = null;
let freezes = [];
let freezesLeft = 0;
let chainYear = Number(localISODate().slice(0, 4));
let year = { done: [], partial: [], frozen: [] };
let comments = [];

const isOwner = () => habit.owner.id === user.id;
const isAdmin = () => user.role === 'admin';

function message(title, text) {
  main.replaceChildren(
    el('div', { class: 'empty' }, el('h2', { text: title }), el('p', { class: 'muted', text }), el('a', { class: 'btn', text: 'Back to Today', attrs: { href: '/' } })),
  );
}

// ---- header -------------------------------------------------------------------

function ownerTools() {
  const tools = [];
  if (isOwner()) {
    const edit = el('button', { class: 'btn btn-sm', text: 'Edit', attrs: { type: 'button' } });
    edit.addEventListener('click', async () => {
      const saved = await habitDialog(habit);
      if (saved) {
        habit = saved;
        toast('Changes saved');
        await refresh();
      }
    });

    const share = el('button', { class: 'btn btn-sm', text: habit.is_public ? 'Make private' : 'Share on Explore', attrs: { type: 'button' } });
    share.addEventListener('click', () =>
      withBusy(share, async () => {
        try {
          ({ habit } = await api.patch(`/api/habits/${habit.id}`, { is_public: !habit.is_public }));
          toast(habit.is_public ? 'Shared on Explore' : 'Now private');
          await refresh();
        } catch (err) {
          toast(errorMessage(err), { error: true });
        }
      }),
    );
    tools.push(edit, share);
  }
  if (isOwner() || isAdmin()) {
    const del = el('button', { class: 'btn btn-sm btn-danger', text: isOwner() ? 'Delete' : 'Remove habit', attrs: { type: 'button' } });
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete this habit?',
        message: `“${habit.title}” and all of its check-ins, photos and comments will be removed. This can’t be undone.`,
        confirmLabel: 'Delete habit',
      });
      if (!ok) return;
      try {
        await api.del(`/api/habits/${habit.id}`);
        location.assign(isOwner() ? '/' : '/explore.html');
      } catch (err) {
        toast(errorMessage(err), { error: true });
      }
    });
    tools.push(del);
  }
  return el('div', { class: 'owner-tools' }, tools);
}

function header() {
  return el(
    'header',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('p', { class: 'eyebrow' }, categoryChip(habit.category), ' ', visibilityLabel(habit.is_public)),
      el('h1', { class: 'detail-title section', text: habit.title }),
      el('p', { class: 'byline', text: `by @${habit.owner.username} · ${scheduleLabel(habit.schedule)}${habit.target_count > 1 ? ` · ${habit.target_count} ${habit.unit} a day` : ''} · since ${formatDate(habit.created_at)}` }),
      habit.description ? el('p', { class: 'description', text: habit.description }) : null,
    ),
    ownerTools(),
  );
}

// ---- check-ins (private) ------------------------------------------------------

function heatmap() {
  const done = new Set(checkins.filter((c) => c.amount >= habit.target_count).map((c) => c.checkin_date));
  const frozen = new Set(freezes);
  const today = localISODate();
  const start = addDays(today, -83);
  const lead = (new Date(`${start}T12:00:00`).getDay() + 6) % 7; // Monday-first rows
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(el('span', { class: 'day is-future' }));
  for (let i = 0; i < 84; i++) {
    const date = addDays(start, i);
    const off = !done.has(date) && !isDue(habit, date);
    const ice = !done.has(date) && frozen.has(date);
    const state = done.has(date) ? ' is-done' : ice ? ' is-frozen' : off ? ' is-off' : '';
    const title = `${formatDate(date)}${done.has(date) ? ' — checked in' : ice ? ' — frozen' : ''}`;
    if (isOwner() && date <= today) {
      // The owner can fill in or clear any past day straight from the calendar.
      const cell = el('button', {
        class: `day day-btn${state}`,
        attrs: { type: 'button', title, 'aria-label': `${title}. ${done.has(date) ? 'Remove check-in' : 'Check in for this day'}` },
      });
      cell.addEventListener('click', () => toggleDay(date));
      cells.push(cell);
    } else {
      cells.push(el('span', { class: `day${state}`, attrs: { title } }));
    }
  }
  return el('div', { class: 'heatmap', attrs: { role: isOwner() ? 'group' : 'img', 'aria-label': `${checkins.length} check-ins recorded` } }, cells);
}

async function toggleDay(date) {
  const existing = checkins.find((c) => c.checkin_date === date);
  try {
    if (existing) {
      const ok = await confirmDialog({
        title: 'Remove this check-in?',
        message: `The check-in for ${formatDate(date)}${existing.note || existing.has_photo ? ', with its note and photo,' : ''} will be removed.`,
        confirmLabel: 'Remove check-in',
      });
      if (!ok) return;
      await api.del(`/api/checkins/${existing.id}`);
      toast(`Removed ${formatDate(date)}`);
    } else {
      await api.post(`/api/habits/${habit.id}/checkins`, { checkin_date: date });
      toast(`Checked in for ${formatDate(date)}`);
    }
    await refresh();
  } catch (err) {
    toast(errorMessage(err), { error: true });
  }
}

// Missed due days in the last 7 days that a freeze could cover.
function freezableDays() {
  const done = new Set(checkins.map((c) => c.checkin_date));
  const frozen = new Set(freezes);
  const today = localISODate();
  const days = [];
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i);
    if (d >= habit.created_at.slice(0, 10) && isDue(habit, d) && !done.has(d) && !frozen.has(d)) days.push(d);
  }
  return days;
}

function freezePanel() {
  const days = freezableDays();
  const button = el('button', { class: 'btn btn-ghost btn-sm freeze-btn', text: '❄ Freeze a missed day', attrs: { type: 'button' } });
  button.disabled = freezesLeft === 0 || days.length === 0;
  button.addEventListener('click', async () => {
    const day = await pickFreezeDay(days);
    if (!day) return;
    try {
      await api.post(`/api/habits/${habit.id}/freezes`, { freeze_date: day });
      toast(`${formatDate(day)} is frozen — your streak is safe`);
      await refresh();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  });
  const text = freezesLeft === 0
    ? 'No streak freezes left this month.'
    : `${freezesLeft} streak freeze${freezesLeft === 1 ? '' : 's'} left this month.`;
  return el('div', { class: 'freeze-panel' }, el('p', { class: 'mono muted', text }), button);
}

function pickFreezeDay(days) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'dialog', attrs: { 'aria-labelledby': 'fz-title' } });
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const choices = days.map((d) => {
      const b = el('button', { class: 'btn', text: formatDate(d), attrs: { type: 'button' } });
      b.addEventListener('click', () => finish(d));
      return b;
    });
    const cancel = el('button', { class: 'btn btn-ghost', text: 'Cancel', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', () => finish(null));
    dialog.append(
      el('h2', { text: 'Freeze a missed day', attrs: { id: 'fz-title' } }),
      el('p', { class: 'muted', text: 'A frozen day keeps your streak alive. You get 2 per month; this can’t be undone.' }),
      el('div', { class: 'freeze-choices' }, choices),
      el('div', { class: 'dialog-actions' }, cancel),
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}

function checkinForm() {
  const today = localISODate();
  const date = el('input', { class: 'input', attrs: { id: 'ci-date', name: 'checkin_date', type: 'date', required: true, max: today, min: '2000-01-01' } });
  date.value = today;
  const measured = habit.target_count > 1;
  const amount = el('input', { class: 'input input-num', attrs: { id: 'ci-amount', name: 'amount', type: 'number', min: 1, max: 100000, step: 1, required: true } });
  amount.value = String(habit.target_count);
  const note = el('textarea', { class: 'textarea', attrs: { id: 'ci-note', name: 'note', maxlength: 500, placeholder: 'How did it go? (optional)' } });
  const photo = el('input', { attrs: { id: 'ci-photo', name: 'photo', type: 'file', accept: PHOTO_TYPES.join(',') } });
  const submit = el('button', { class: 'btn btn-accent', text: 'Check in', attrs: { type: 'submit' } });

  const form = el(
    'form',
    { class: 'form card', attrs: { novalidate: true } },
    el('h3', { text: 'Add a check-in' }),
    el('div', { class: 'field', dataset: { field: 'checkin_date' } }, el('label', { text: 'Day', attrs: { for: 'ci-date' } }), date),
    measured
      ? el('div', { class: 'field', dataset: { field: 'amount' } }, el('label', { text: `How many ${habit.unit || 'times'}? (goal ${habit.target_count})`, attrs: { for: 'ci-amount' } }), amount)
      : null,
    el('div', { class: 'field', dataset: { field: 'note' } }, el('label', { text: 'Note', attrs: { for: 'ci-note' } }), note),
    el(
      'div',
      { class: 'field', dataset: { field: 'photo' } },
      el('label', { class: 'file-drop', attrs: { for: 'ci-photo' } }, el('span', { class: 'label', text: 'Proof photo (optional)' }), el('span', { class: 'hint', text: 'JPEG, PNG or WebP, up to 1 MB. Only you and admins can see it.' }), photo),
    ),
    submit,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!form.reportValidity()) return;

    // Convenience checks only — the server inspects the actual file bytes.
    const file = photo.files[0];
    if (file && (file.size > MAX_PHOTO_BYTES || !PHOTO_TYPES.includes(file.type))) {
      showFormErrors(form, new ApiError(400, { error: 'Choose a JPEG, PNG or WebP image of 1 MB or less.' }));
      return;
    }
    const data = new FormData();
    data.append('checkin_date', date.value);
    data.append('note', note.value.trim());
    if (measured) data.append('amount', amount.value);
    if (file) data.append('photo', file);

    await withBusy(submit, async () => {
      try {
        await api.upload('POST', `/api/habits/${habit.id}/checkins`, data);
        toast(`Checked in for ${formatDate(date.value)}`);
        await refresh();
      } catch (err) {
        showFormErrors(form, err);
      }
    });
  });
  return form;
}

function checkinItem(c) {
  const tools = [];
  if (isOwner() && c.has_photo) {
    const removePhoto = el('button', { class: 'btn btn-ghost btn-sm', text: 'Remove photo', attrs: { type: 'button' } });
    removePhoto.addEventListener('click', async () => {
      try {
        await api.del(`/api/checkins/${c.id}/photo`);
        await refresh();
      } catch (err) {
        toast(errorMessage(err), { error: true });
      }
    });
    tools.push(removePhoto);
  }
  const del = el('button', { class: 'btn btn-ghost btn-sm', text: 'Delete', attrs: { type: 'button', 'aria-label': `Delete check-in for ${c.checkin_date}` } });
  del.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete this check-in?', message: `The check-in for ${formatDate(c.checkin_date)} will be removed.`, confirmLabel: 'Delete check-in' });
    if (!ok) return;
    try {
      await api.del(`/api/checkins/${c.id}`);
      await refresh();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  });
  tools.push(del);

  return el(
    'li',
    { class: 'log-item' },
    el(
      'span',
      { class: 'date' },
      formatDate(c.checkin_date),
      habit.target_count > 1 ? el('span', { class: `amount${c.amount >= habit.target_count ? ' is-met' : ''}`, text: `${c.amount} / ${habit.target_count} ${habit.unit}` }) : null,
    ),
    el(
      'div',
      {},
      el('p', { class: c.note ? 'note' : 'note muted', text: c.note || 'No note' }),
      c.photo_url
        ? el('img', { class: 'photo', attrs: { src: c.photo_url, alt: `Proof photo for ${c.checkin_date}`, loading: 'lazy' } })
        : null,
    ),
    el('div', { class: 'owner-tools' }, tools),
  );
}

function checkinSection() {
  return el(
    'section',
    { attrs: { 'aria-labelledby': 'checkins-heading' } },
    el(
      'div',
      { class: 'section-head' },
      el('h2', { text: 'Check-ins', attrs: { id: 'checkins-heading' } }),
      streakBadge(streak),
    ),
    el('p', { class: 'mono muted', text: isOwner() ? 'Last 12 weeks · tap a day to fill it in or clear it · private to you and admins' : 'Last 12 weeks · private to you and admins' }),
    el('div', { class: 'section' }, heatmap()),
    isOwner() ? freezePanel() : null,
    isOwner() ? el('div', { class: 'section' }, checkinForm()) : null,
    el(
      'div',
      { class: 'section' },
      checkins.length
        ? el('ul', { class: 'log' }, checkins.map(checkinItem))
        : el('p', { class: 'muted', text: 'No check-ins yet.' }),
    ),
  );
}

// ---- comments (public) --------------------------------------------------------

function commentItem(c) {
  const mine = c.author.id === user.id;
  const body = el('p', { class: 'comment-body', text: c.body });
  const tools = el('div', { class: 'comment-tools' });

  if (mine) {
    const edit = el('button', { class: 'btn btn-ghost btn-sm', text: 'Edit', attrs: { type: 'button' } });
    edit.addEventListener('click', () => {
      const area = el('textarea', { class: 'textarea', attrs: { maxlength: 500, 'aria-label': 'Edit comment' } });
      area.value = c.body;
      const save = el('button', { class: 'btn btn-primary btn-sm', text: 'Save', attrs: { type: 'button' } });
      const cancel = el('button', { class: 'btn btn-ghost btn-sm', text: 'Cancel', attrs: { type: 'button' } });
      const editor = el('div', { class: 'form' }, area, el('div', { class: 'comment-tools' }, save, cancel));
      body.replaceWith(editor);
      tools.hidden = true;
      area.focus();
      cancel.addEventListener('click', () => {
        editor.replaceWith(body);
        tools.hidden = false;
      });
      save.addEventListener('click', () =>
        withBusy(save, async () => {
          try {
            await api.patch(`/api/comments/${c.id}`, { body: area.value.trim() });
            await loadComments();
          } catch (err) {
            toast(errorMessage(err), { error: true });
          }
        }),
      );
    });
    tools.append(edit);
  }
  if (mine || isOwner() || isAdmin()) {
    const del = el('button', { class: 'btn btn-ghost btn-sm', text: mine ? 'Delete' : 'Remove', attrs: { type: 'button' } });
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Remove this comment?', message: 'It will disappear for everyone.', confirmLabel: 'Remove comment' });
      if (!ok) return;
      try {
        await api.del(`/api/comments/${c.id}`);
        await loadComments();
      } catch (err) {
        toast(errorMessage(err), { error: true });
      }
    });
    tools.append(del);
  }

  return el(
    'li',
    { class: `comment${mine ? ' is-mine' : ''}` },
    el(
      'div',
      { class: 'comment-head' },
      el('span', { class: 'comment-author', text: `@${c.author.username}` }),
      el('span', { class: 'mono muted', text: formatTimestamp(c.created_at) + (c.updated_at ? ' · edited' : '') }),
    ),
    body,
    tools.childElementCount ? tools : null,
  );
}

function commentForm() {
  const area = el('textarea', { class: 'textarea', attrs: { id: 'comment-body', name: 'body', required: true, maxlength: 500, placeholder: 'Say something encouraging' } });
  const submit = el('button', { class: 'btn btn-primary', text: 'Post comment', attrs: { type: 'submit' } });
  const form = el(
    'form',
    { class: 'form', attrs: { novalidate: true } },
    el('div', { class: 'field', dataset: { field: 'body' } }, el('label', { class: 'visually-hidden', text: 'Comment', attrs: { for: 'comment-body' } }), area),
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!form.reportValidity()) return;
    await withBusy(submit, async () => {
      try {
        await api.post(`/api/habits/${habit.id}/comments`, { body: area.value.trim() });
        area.value = '';
        await loadComments();
      } catch (err) {
        showFormErrors(form, err);
      }
    });
  });
  return form;
}

function commentSection() {
  const canRead = habit.is_public || isOwner() || isAdmin();
  return el(
    'section',
    { attrs: { 'aria-labelledby': 'comments-heading' } },
    el('div', { class: 'section-head' }, el('h2', { text: 'Comments', attrs: { id: 'comments-heading' } }), el('span', { class: 'mono muted', text: String(comments.length) })),
    canRead && comments.length ? el('ul', { class: 'thread' }, comments.map(commentItem)) : null,
    canRead && !comments.length ? el('p', { class: 'muted', text: habit.is_public ? 'No comments yet. Be the first to cheer them on.' : 'No comments.' }) : null,
    habit.is_public
      ? el('div', { class: 'section' }, commentForm())
      : el('p', { class: 'muted section', text: 'Comments are off while this habit is private.' }),
  );
}

// ---- data & rendering ---------------------------------------------------------

async function loadComments() {
  if (habit.is_public || isOwner() || isAdmin()) {
    ({ comments } = await api.get(`/api/habits/${habit.id}/comments`));
  } else {
    comments = [];
  }
  render();
}

async function refresh() {
  ({ habit } = await api.get(`/api/habits/${habitId}`));
  if (isOwner() || isAdmin()) {
    [{ checkins, streak, freezes, freezes_left: freezesLeft }] = await Promise.all([api.get(`/api/habits/${habit.id}/checkins`), loadYear()]);
  }
  await loadComments();
}

function habitWall() {
  const today = localISODate();
  const created = habit.created_at.slice(0, 10);
  const done = new Set(year.done);
  const partial = new Set(year.partial);
  const frozen = new Set(year.frozen);
  const states = new Map();
  for (let d = `${chainYear}-01-01`; d <= `${chainYear}-12-31` && d <= today; d = addDays(d, 1)) {
    if (done.has(d)) states.set(d, 'done');
    else if (d < created) continue;
    else if (frozen.has(d)) states.set(d, 'frozen');
    else if (partial.has(d)) states.set(d, 'partial');
    else if (habit.schedule.type === 'weekly' || d === today) continue;
    else if (!isDue(habit, d)) states.set(d, 'rest');
    else states.set(d, 'missed');
  }
  return chainCalendar({
    year: chainYear,
    states,
    minYear: Math.min(Number(created.slice(0, 4)), ...year.done.map((d) => Number(d.slice(0, 4)))),
    onYear: async (y) => {
      chainYear = y;
      await loadYear();
      render();
      $('#chain')?.scrollIntoView({ block: 'nearest' });
    },
  });
}

async function loadYear() {
  ({ done: year.done, partial: year.partial, frozen: year.frozen } = await api.get(`/api/habits/${habit.id}/checkins/year?year=${chainYear}`));
}

function render() {
  document.title = `${habit.title} · Habit Tracker`;
  const canSee = isOwner() || isAdmin();
  const left = canSee ? checkinSection() : el('section', {}, el('div', { class: 'empty' }, el('h2', { text: 'Check-ins are private' }), el('p', { class: 'muted', text: `Only @${habit.owner.username} can see their check-in history.` })));
  main.replaceChildren(
    header(),
    canSee ? el('section', { class: 'section', attrs: { id: 'chain' } }, habitWall()) : null,
    el('div', { class: 'detail section' }, left, commentSection()),
  );
}

user = await initPage();
if (!habitId) {
  message('Habit not found', 'The link is missing a valid habit id.');
} else {
  try {
    await refresh();
    reveal([...main.children]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) message('This habit is private', 'Only its owner can see it.');
    else if (err instanceof ApiError && err.status === 404) message('Habit not found', 'It may have been deleted.');
    else message('Something went wrong', errorMessage(err));
  }
}
