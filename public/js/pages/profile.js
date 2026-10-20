// Profile: the signed-in user's private account details (F5), personal stats
// and password change. Only /api/users/me is used — there is no user id in
// this page or its requests.

import { api, ApiError } from '../api.js';
import { el, $, formatDate } from '../dom.js';
import { initPage, toast, showFormErrors, clearFormErrors, withBusy } from '../shell.js';
import { reveal } from '../motion.js';

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
const { user, stats } = await api.get('/api/users/me');

main.replaceChildren(
  el(
    'header',
    { class: 'page-head' },
    el('div', {}, el('p', { class: 'eyebrow', text: 'Your account' }), el('h1', { text: `@${user.username}` }), el('p', { class: 'lede', text: 'Your details, your numbers, and your password.' })),
  ),
  ledger(stats),
  el(
    'div',
    { class: 'profile-grid section' },
    el('section', {}, el('div', { class: 'section-head' }, el('h2', { text: 'Account' })), details(user)),
    el('section', {}, el('div', { class: 'section-head' }, el('h2', { text: 'Security' })), passwordForm()),
  ),
);
reveal([...main.children]);
