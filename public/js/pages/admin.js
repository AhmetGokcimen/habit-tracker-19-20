// Admin panel (F2): usage report, user management and the audit log.
// Showing this page to a non-admin would reveal nothing: every endpoint it
// calls answers 403 unless the database says the caller is an admin.

import { api, ApiError } from '../api.js';
import { el, $, formatDate, formatTimestamp } from '../dom.js';
import { initPage, toast, errorMessage, confirmDialog } from '../shell.js';
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

async function load() {
  const [stats, { users }, { entries }] = await Promise.all([
    api.get('/api/admin/stats'),
    api.get('/api/admin/users'),
    api.get('/api/admin/audit-log'),
  ]);

  main.replaceChildren(
    el(
      'header',
      { class: 'page-head' },
      el('div', {}, el('p', { class: 'eyebrow', text: 'Administration' }), el('h1', { text: 'Admin' }), el('p', { class: 'lede', text: 'Manage accounts and review every admin action. Changes take effect immediately.' })),
    ),
    ledger(stats.totals),
    el('section', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Users' }), el('span', { class: 'mono muted', text: `${users.length} accounts` })), usersTable(users)),
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
