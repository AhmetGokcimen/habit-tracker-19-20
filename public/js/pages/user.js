// Public profile: someone's shared habits and a follow button (F11).
// Only public data is shown; the server returns 404 for people who share nothing.

import { api, ApiError } from '../api.js';
import { el, $, idFromQuery, formatDate } from '../dom.js';
import { initPage, toast, errorMessage, withBusy } from '../shell.js';
import { reveal } from '../motion.js';
import { categoryChip } from '../components.js';

const main = $('#main');
const userId = idFromQuery();

function message(title, text) {
  main.replaceChildren(el('div', { class: 'empty' }, el('h2', { text: title }), el('p', { class: 'muted', text }), el('a', { class: 'btn', text: 'Back to Explore', attrs: { href: '/explore.html' } })));
}

function habitCard(h) {
  return el(
    'article',
    { class: 'card tilt habit-card' },
    el('div', { class: 'meta' }, categoryChip(h.category), el('span', { class: 'byline', text: `since ${formatDate(h.created_at)}` })),
    el('div', {}, el('h3', {}, el('a', { text: h.title, attrs: { href: `/habit.html?id=${h.id}` } })), h.description ? el('p', { class: 'desc', text: h.description }) : null),
  );
}

function render(data) {
  document.title = `@${data.user.username} · Habit Tracker`;
  let action = null;
  if (!data.is_me) {
    action = el('button', { class: `btn ${data.you_follow ? '' : 'btn-primary'}`, text: data.you_follow ? 'Following ✓' : 'Follow', attrs: { type: 'button', 'aria-pressed': String(data.you_follow) } });
    action.addEventListener('click', () =>
      withBusy(action, async () => {
        try {
          if (data.you_follow) await api.del(`/api/users/${data.user.id}/follow`);
          else await api.put(`/api/users/${data.user.id}/follow`);
          toast(data.you_follow ? `Unfollowed @${data.user.username}` : `Following @${data.user.username} — their shared habits appear on Explore`);
          render(await api.get(`/api/users/${data.user.id}/public`));
        } catch (err) {
          toast(errorMessage(err), { error: true });
        }
      }),
    );
  }
  const followers = data.follower_count === 1 ? '1 follower' : `${data.follower_count} followers`;
  main.replaceChildren(
    el(
      'header',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow', text: data.is_me ? 'Your public profile' : 'Profile' }),
        el('h1', { text: `@${data.user.username}` }),
        el('p', { class: 'lede', text: `${followers} · ${data.habits.length} shared habit${data.habits.length === 1 ? '' : 's'}` }),
      ),
      action,
    ),
    el(
      'section',
      { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', { text: 'Shared habits' })),
      el('div', { class: 'grid' }, data.habits.map(habitCard)),
    ),
    el('p', { class: 'hint section', text: 'Only habits that are shared on Explore appear here. Check-ins are always private.' }),
  );
  reveal([...main.querySelectorAll('.habit-card')]);
}

await initPage({ active: 'explore' });
if (!userId) {
  message('Profile not found', 'The link is missing a valid user id.');
} else {
  try {
    render(await api.get(`/api/users/${userId}/public`));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) message('No public profile', 'This person doesn’t share any habits right now.');
    else message('Something went wrong', errorMessage(err));
  }
}
