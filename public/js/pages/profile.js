// Profile: the signed-in user's private account details (F5), personal stats
// and password change. Only /api/users/me is used — there is no user id in
// this page or its requests.

import { api, ApiError } from '../api.js';
import { el, $, formatDate } from '../dom.js';
import { initPage, toast, showFormErrors, clearFormErrors, withBusy } from '../shell.js';
import { reveal } from '../motion.js';
import { badgeTile, announceNewBadges } from '../components.js';
import { notificationPermission, requestNotifications } from '../reminders.js';

const main = $('#main');

function ledger(stats) {
  const rows = [
    ['Habits', stats.habits],
    ['Shared', stats.public_habits],
    ['Check-ins', stats.checkins],
    ['Proof photos', stats.photos],
    ['Comments', stats.comments],
    ['Longest streak', `${stats.longest_streak}d`],
    ['Current best', `${stats.best_current_streak}d`],
  ];
  return el('dl', { class: 'ledger' }, rows.map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: String(value) }))));
}

function details(user) {
  const row = (label, value, note) =>
    el('div', { class: 'detail-row' }, el('dt', { text: label }), el('dd', {}, el('span', { text: value }), note ? el('span', { class: 'hint', text: note }) : null));
  return el(
    'dl',
    { class: 'card account-details' },
    row('Username', `@${user.username}`, 'Shown on habits you share.'),
    row('Email', user.email, 'Private — only you and administrators can see it.'),
    row('Member since', formatDate(user.created_at)),
  );
}

function remindersCard() {
  const status = el('p', { class: 'mono muted' });
  const button = el('button', { class: 'btn', text: 'Allow notifications', attrs: { type: 'button' } });
  const sync = () => {
    const p = notificationPermission();
    status.textContent = {
      granted: 'Notifications are on for this browser.',
      denied: 'Notifications are blocked in your browser settings — reminders show inside the page instead.',
      default: 'Reminders show inside the page. Allow notifications to get them as system alerts.',
      unsupported: 'This browser has no notifications — reminders show inside the page.',
    }[p];
    button.hidden = p !== 'default';
  };
  button.addEventListener('click', async () => {
    await requestNotifications();
    sync();
  });
  sync();
  return el(
    'div',
    { class: 'card account-details' },
    el('p', { text: 'Set a reminder time on any habit (Edit → “Remind me at”). You get one nudge a day while Habit Tracker is open, only if the habit is still due.' }),
    status,
    button,
  );
}

function exportCard() {
  return el(
    'div',
    { class: 'card account-details' },
    el('p', { text: 'Download everything you created: habits, check-ins, freezes and comments. Photos are not included.' }),
    el(
      'div',
      { class: 'export-links' },
      el('a', { class: 'btn', text: 'Download JSON', attrs: { href: '/api/users/me/export?format=json', download: true } }),
      el('a', { class: 'btn', text: 'Check-ins as CSV', attrs: { href: '/api/users/me/export?format=csv', download: true } }),
    ),
  );
}

function passwordField(id, name, label, autocomplete, hint) {
  const input = el('input', { class: 'input', attrs: { id, name, type: 'password', autocomplete, required: true, maxlength: name === 'current_password' ? 200 : 72 } });
  return el(
    'div',
    { class: 'field', dataset: { field: name } },
    el('label', { text: label, attrs: { for: id } }),
    input,
    hint ? el('p', { class: 'hint', text: hint }) : null,
  );
}

function passwordForm() {
  const submit = el('button', { class: 'btn btn-primary', text: 'Change password', attrs: { type: 'submit' } });
  const form = el(
    'form',
    { class: 'form card', attrs: { novalidate: true } },
    el('h3', { text: 'Change password' }),
    passwordField('pw-current', 'current_password', 'Current password', 'current-password'),
    passwordField('pw-new', 'new_password', 'New password', 'new-password', 'At least 8 characters, with a letter and a digit.'),
    passwordField('pw-confirm', 'confirm', 'Repeat new password', 'new-password'),
    el('p', { class: 'hint', text: 'Changing your password signs you out on every other device.' }),
    submit,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!form.reportValidity()) return;
    if (form.new_password.value !== form.confirm.value) {
      showFormErrors(form, new ApiError(400, { error: 'Check the new password', details: [{ field: 'confirm', message: 'The two new passwords don’t match' }] }));
      return;
    }
    await withBusy(submit, async () => {
      try {
        await api.post('/api/users/me/password', {
          current_password: form.current_password.value,
          new_password: form.new_password.value,
        });
        form.reset();
        toast('Password changed. Other devices were signed out.');
      } catch (err) {
        showFormErrors(form, err);
      }
    });
  });
  return form;
}

await initPage({ active: 'profile' });
const { user, stats, badges } = await api.get('/api/users/me');
announceNewBadges(user.id, badges);
const earnedCount = badges.filter((b) => b.earned).length;

main.replaceChildren(
  el(
    'header',
    { class: 'page-head' },
    el('div', {}, el('p', { class: 'eyebrow', text: 'Your account' }), el('h1', { text: `@${user.username}` }), el('p', { class: 'lede', text: 'Your details, your numbers, and your password.' })),
  ),
  ledger(stats),
  el(
    'section',
    { class: 'section', attrs: { 'aria-labelledby': 'badges-heading' } },
    el('div', { class: 'section-head' }, el('h2', { text: 'Badges', attrs: { id: 'badges-heading' } }), el('span', { class: 'mono muted', text: `${earnedCount} of ${badges.length}` })),
    el('ul', { class: 'badges' }, badges.map(badgeTile)),
  ),
  el(
    'div',
    { class: 'profile-grid section' },
    el('section', {}, el('div', { class: 'section-head' }, el('h2', { text: 'Account' })), details(user), el('div', { class: 'section-head section' }, el('h2', { text: 'Reminders' })), remindersCard(), el('div', { class: 'section-head section' }, el('h2', { text: 'Your data' })), exportCard()),
    el('section', {}, el('div', { class: 'section-head' }, el('h2', { text: 'Security' })), passwordForm()),
  ),
);
reveal([...main.children]);
