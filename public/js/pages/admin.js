// Admin panel (F2): usage report, user management and the audit log.
// Showing this page to a non-admin would reveal nothing: every endpoint it
// calls answers 403 unless the database says the caller is an admin.

import { api, ApiError } from '../api.js';
import { el, $, formatDate, formatTimestamp, localISODate, addDays } from '../dom.js';
import { initPage, toast, errorMessage, confirmDialog, showFormErrors, clearFormErrors, withBusy } from '../shell.js';
import { CATEGORIES } from '../components.js';
import { reveal } from '../motion.js';

const main = $('#main');
let me;

function ledger(totals) {
  const rows = [
    ['Users', totals.users],
    ['Admins', totals.admins],
    ['Habits', totals.habits],
    ['Shared', totals.public_habits],
    ['Check-ins', totals.checkins],
    ['Comments', totals.comments],
  ];
  return el('dl', { class: 'ledger' }, rows.map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: String(value) }))));
}

const MB = 1024 * 1024;
const formatMB = (bytes) => `${(bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1)} MB`;
// At or above this share of the cap the section asks the admin to act.
const STORAGE_WARN_PERCENT = 90;

// Service-wide proof-photo storage and the accounts that store the most.
function photoStorage({ storage, top_users: topUsers }) {
  const pct = storage.used_percent;
  const full = pct >= 100;
  const bar = el(
    'span',
    {
      class: 'hbar',
      attrs: {
        role: 'progressbar',
        'aria-label': 'Photo storage used',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.min(pct, 100)),
      },
    },
    el('span', { class: 'hbar-fill', vars: { '--w': `${Math.min(pct, 100)}%` } }),
  );
  const summary = el('p', {
    class: 'mono',
    text: `${formatMB(storage.used_bytes)} of ${formatMB(storage.cap_bytes)} used (${pct}%) · ${formatMB(storage.per_user_quota_bytes)} per user`,
  });
  const warning =
    pct >= STORAGE_WARN_PERCENT
      ? el('p', {
          class: 'form-error',
          attrs: { role: 'status' },
          text: full
            ? 'Storage is full: new proof photos are refused for everyone. Check the accounts below and delete any that abuse it.'
            : 'Storage is almost full. Check the accounts below for abuse before new photos are refused for everyone.',
        })
      : null;

  const table = topUsers.length
    ? el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'table' },
          el('thead', {}, el('tr', {}, ['User', 'Photos', 'Stored', 'Of quota'].map((h) => el('th', { text: h, attrs: { scope: 'col' } })))),
          el(
            'tbody',
            {},
            topUsers.map((u) =>
              el(
                'tr',
                {},
                el('td', { text: `@${u.username}` }),
                el('td', { class: 'mono', text: String(u.photo_count) }),
                el('td', { class: 'mono', text: formatMB(u.photo_bytes) }),
                el('td', { class: 'mono', text: `${u.quota_percent}%` }),
              ),
            ),
          ),
        ),
      )
    : el('p', { class: 'muted', text: 'No proof photos stored yet.' });

  return el(
    'section',
    { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', { text: 'Photo storage' }), el('span', { class: 'mono muted', text: `top ${topUsers.length} accounts` })),
    summary,
    bar,
    warning,
    table,
  );
}

function roleSelect(user) {
  const select = el(
    'select',
    { class: 'select', attrs: { 'aria-label': `Role for @${user.username}`, disabled: user.id === me.id } },
    ['user', 'admin'].map((r) => el('option', { text: r, attrs: { value: r } })),
  );
  select.value = user.role;
  select.addEventListener('change', async () => {
    const role = select.value;
    const ok = await confirmDialog({
      title: role === 'admin' ? 'Make this user an admin?' : 'Remove admin rights?',
      message: `@${user.username} will ${role === 'admin' ? 'be able to manage users and remove any content' : 'lose access to the admin panel'} immediately.`,
      confirmLabel: role === 'admin' ? 'Make admin' : 'Remove admin',
      danger: role !== 'admin',
    });
    if (!ok) {
      select.value = user.role;
      return;
    }
    try {
      await api.patch(`/api/admin/users/${user.id}/role`, { role });
      toast(`@${user.username} is now ${role === 'admin' ? 'an admin' : 'a regular user'}`);
      await load();
    } catch (err) {
      select.value = user.role;
      toast(errorMessage(err), { error: true });
    }
  });
  return select;
}

function deleteButton(user) {
  const button = el('button', {
    class: 'btn btn-danger btn-sm',
    text: 'Delete',
    attrs: { type: 'button', disabled: user.id === me.id, 'aria-label': `Delete @${user.username}` },
  });
  button.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Delete @${user.username}?`,
      message: 'Their habits, check-ins, photos and comments are deleted and they are signed out everywhere. This can’t be undone.',
      confirmLabel: 'Delete user',
    });
    if (!ok) return;
    try {
      await api.del(`/api/admin/users/${user.id}`);
      toast(`Deleted @${user.username}`);
      await load();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  });
  return button;
}

function usersTable(users) {
  const head = ['User', 'Email', 'Role', 'Habits', 'Check-ins', 'Comments', 'Joined', ''];
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'table' },
      el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h, attrs: { scope: 'col' } })))),
      el(
        'tbody',
        {},
        users.map((u) =>
          el(
            'tr',
            {},
            el('td', { text: `@${u.username}${u.id === me.id ? ' (you)' : ''}` }),
            el('td', { text: u.email }),
            el('td', {}, roleSelect(u)),
            el('td', { class: 'mono', text: String(u.habit_count) }),
            el('td', { class: 'mono', text: String(u.checkin_count) }),
            el('td', { class: 'mono', text: String(u.comment_count) }),
            el('td', { class: 'mono', text: formatDate(u.created_at) }),
            el('td', {}, deleteButton(u)),
          ),
        ),
      ),
    ),
  );
}

// Human-readable sentence for an audit entry; every value is plain text.
function describe(entry) {
  const d = entry.details || {};
  switch (entry.action) {
    case 'admin.login':
      return `@${entry.actor_username} signed in`;
    case 'user.role_change':
      return `@${entry.actor_username} changed @${d.username}'s role from ${d.from} to ${d.to}`;
    case 'user.delete':
      return `@${entry.actor_username} deleted user @${d.username}`;
    case 'habit.delete':
      return `@${entry.actor_username} removed habit “${d.title}” (#${entry.target_id})`;
    case 'checkin.delete':
      return `@${entry.actor_username} removed check-in #${entry.target_id}`;
    case 'comment.delete':
      return `@${entry.actor_username} removed comment #${entry.target_id}`;
    default:
      return `@${entry.actor_username}: ${entry.action} ${entry.target_type} #${entry.target_id}`;
  }
}

function auditList(entries) {
  if (!entries.length) return el('p', { class: 'muted', text: 'No admin actions recorded yet.' });
  return el(
    'ul',
    { class: 'audit' },
    entries.map((e) => el('li', {}, el('span', { class: 'when', text: formatTimestamp(e.created_at) }), el('span', { text: describe(e) }))),
  );
}

// ---- challenges (F13) -------------------------------------------------------------

function challengeForm() {
  const input = (id, name, type, extra = {}) => el('input', { class: 'input', attrs: { id, name, type, required: true, ...extra } });
  const title = input('ch-title', 'title', 'text', { maxlength: 100 });
  const description = el('textarea', { class: 'textarea', attrs: { id: 'ch-desc', name: 'description', maxlength: 1000 } });
  const category = el('select', { class: 'select', attrs: { id: 'ch-cat', name: 'category' } }, CATEGORIES.map((c) => el('option', { text: c, attrs: { value: c } })));
  const start = input('ch-start', 'start_date', 'date');
  const end = input('ch-end', 'end_date', 'date');
  start.value = localISODate();
  end.value = addDays(localISODate(), 29);
  const submit = el('button', { class: 'btn btn-primary', text: 'Create challenge', attrs: { type: 'submit' } });
  const field = (name, label, control) => el('div', { class: 'field', dataset: { field: name } }, el('label', { text: label, attrs: { for: control.id } }), control);
  const form = el(
    'form',
    { class: 'form card', attrs: { novalidate: true } },
    el('h3', { text: 'New challenge' }),
    field('title', 'Title', title),
    field('description', 'Description', description),
    field('category', 'Category', category),
    el('div', { class: 'target-row' }, field('start_date', 'Starts', start), field('end_date', 'Ends', end)),
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!form.reportValidity()) return;
    await withBusy(submit, async () => {
      try {
        await api.post('/api/admin/challenges', {
          title: title.value.trim(),
          description: description.value.trim(),
          category: category.value,
          start_date: start.value,
          end_date: end.value,
        });
        toast('Challenge created');
        await load();
      } catch (err) {
        showFormErrors(form, err);
      }
    });
  });
  return form;
}

function challengeList(challenges) {
  if (!challenges.length) return el('p', { class: 'muted', text: 'No current challenges.' });
  return el(
    'ul',
    { class: 'archived-list' },
    challenges.map((c) => {
      const del = el('button', { class: 'btn btn-danger btn-sm', text: 'Delete', attrs: { type: 'button', 'aria-label': `Delete challenge ${c.title}` } });
      del.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Delete this challenge?', message: `“${c.title}” and its leaderboard will be removed for everyone. Members keep their habits.`, confirmLabel: 'Delete challenge' });
        if (!ok) return;
        try {
          await api.del(`/api/admin/challenges/${c.id}`);
          toast('Challenge deleted');
          await load();
        } catch (err) {
          toast(errorMessage(err), { error: true });
        }
      });
      return el('li', {}, el('a', { text: c.title, attrs: { href: `/challenges.html?id=${c.id}` } }), el('span', { class: 'mono muted', text: `${formatDate(c.start_date)} – ${formatDate(c.end_date)} · ${c.member_count} members` }), del);
    }),
  );
}

async function load() {
  const [stats, photos, { users }, { entries }, { challenges }] = await Promise.all([
    api.get('/api/admin/stats'),
    api.get('/api/admin/photo-storage'),
    api.get('/api/admin/users'),
    api.get('/api/admin/audit-log'),
    api.get('/api/challenges'),
  ]);

  main.replaceChildren(
    el(
      'header',
      { class: 'page-head' },
      el('div', {}, el('p', { class: 'eyebrow', text: 'Administration' }), el('h1', { text: 'Admin' }), el('p', { class: 'lede', text: 'Manage accounts and review every admin action. Changes take effect immediately.' })),
    ),
    ledger(stats.totals),
    photoStorage(photos),
    el('section', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Users' }), el('span', { class: 'mono muted', text: `${users.length} accounts` })), usersTable(users)),
    el(
      'section',
      { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', { text: 'Challenges' }), el('span', { class: 'mono muted', text: `${challenges.length} current` })),
      el('div', { class: 'profile-grid' }, challengeList(challenges), challengeForm()),
    ),
    el('section', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Audit log' }), el('span', { class: 'mono muted', text: 'append-only' })), auditList(entries)),
  );
}

me = await initPage({ active: 'admin' });
try {
  await load();
  reveal([...main.children]);
} catch (err) {
  const forbidden = err instanceof ApiError && err.status === 403;
  main.replaceChildren(
    el(
      'div',
      { class: 'empty' },
      el('h2', { text: forbidden ? 'Admins only' : 'Something went wrong' }),
      el('p', { class: 'muted', text: forbidden ? 'This page is for administrators.' : errorMessage(err) }),
      el('a', { class: 'btn', text: 'Back to Today', attrs: { href: '/' } }),
    ),
  );
}
