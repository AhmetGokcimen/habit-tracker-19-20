// Group challenges (F13): list, details with leaderboard, join and leave.
// Joining links ONE of your own habits and, with your explicit consent,
// shows your username and completed-day count to other signed-in users.

import { api, ApiError } from '../api.js';
import { el, $, fill, idFromQuery, localISODate, formatDate } from '../dom.js';
import { initPage, toast, errorMessage, withBusy, showFormErrors, clearFormErrors } from '../shell.js';
import { reveal } from '../motion.js';
import { categoryChip } from '../components.js';

const main = $('#main');
const today = localISODate();

function status(c) {
  if (c.start_date > today) return ['upcoming', `starts ${formatDate(c.start_date)}`];
  if (c.end_date < today) return ['ended', `ended ${formatDate(c.end_date)}`];
  return ['active', `until ${formatDate(c.end_date)}`];
}

function challengeCard(c) {
  const [state, when] = status(c);
  return el(
    'article',
    { class: `card tilt habit-card challenge-card is-${state}` },
    el('div', { class: 'meta' }, categoryChip(c.category), el('span', { class: 'mono muted', text: when })),
    el('div', {}, el('h3', {}, el('a', { text: c.title, attrs: { href: `/challenges.html?id=${c.id}` } })), c.description ? el('p', { class: 'desc', text: c.description }) : null),
    el('p', { class: 'byline', text: `${c.member_count} taking part${c.joined ? ' · you’re in' : ''}` }),
  );
}

async function renderList() {
  const { challenges } = await api.get('/api/challenges');
  fill(
    main,
    el(
      'header',
      { class: 'page-head' },
      el('div', {}, el('p', { class: 'eyebrow', text: 'Together' }), el('h1', { text: 'Challenges' }), el('p', { class: 'lede', text: 'Join a shared goal with one of your habits and see how everyone is doing.' })),
    ),
    challenges.length
      ? el('div', { class: 'grid' }, challenges.map(challengeCard))
      : el('div', { class: 'empty' }, el('h2', { text: 'No challenges right now' }), el('p', { class: 'muted', text: 'Administrators post new challenges here. Check back soon.' })),
  );
  reveal([...main.querySelectorAll('.habit-card')]);
}

function joinForm(c, habits) {
  const select = el(
    'select',
    { class: 'select', attrs: { id: 'join-habit', name: 'habit_id', required: true } },
    habits.map((h) => el('option', { text: h.title, attrs: { value: String(h.id) } })),
  );
  const consent = el('input', { attrs: { type: 'checkbox', id: 'join-consent', name: 'share_progress', required: true } });
  const submit = el('button', { class: 'btn btn-accent', text: 'Join challenge', attrs: { type: 'submit' } });
  const form = el(
    'form',
    { class: 'form card', attrs: { novalidate: true } },
    el('h3', { text: 'Join' }),
    el('div', { class: 'field', dataset: { field: 'habit_id' } }, el('label', { text: 'Which of your habits counts?', attrs: { for: 'join-habit' } }), select),
    el(
      'div',
      { class: 'field', dataset: { field: 'share_progress' } },
      el('label', { class: 'check', attrs: { for: 'join-consent' } }, consent, 'Show my username and number of completed days on the leaderboard'),
      el('p', { class: 'hint', text: 'Only the count of days inside the challenge is shared — never dates, notes or photos. You can leave at any time.' }),
    ),
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!form.reportValidity()) return;
    await withBusy(submit, async () => {
      try {
        await api.post(`/api/challenges/${c.id}/join`, { habit_id: Number(select.value), share_progress: consent.checked });
        toast(`You joined “${c.title}”`);
        await renderDetail(c.id);
      } catch (err) {
        showFormErrors(form, err);
      }
    });
  });
  return form;
}

function leaderboard(rows) {
  if (!rows.length) return el('p', { class: 'muted', text: 'Nobody has joined yet. Be the first!' });
  return el(
    'table',
    { class: 'stat-table leaderboard' },
    el('caption', { class: 'visually-hidden', text: 'Leaderboard' }),
    el('thead', {}, el('tr', {}, ['#', 'Member', 'Days done'].map((h) => el('th', { text: h, attrs: { scope: 'col' } })))),
    el(
      'tbody',
      {},
      rows.map((r) =>
        el(
          'tr',
          { class: r.is_me ? 'is-me' : '' },
          el('td', { class: 'mono', text: r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : String(r.rank) }),
          el('th', { attrs: { scope: 'row' }, text: `@${r.username}${r.is_me ? ' (you)' : ''}` }),
          el('td', { class: 'mono', text: String(r.days) }),
        ),
      ),
    ),
  );
}

async function renderDetail(id) {
  const [{ challenge: c, leaderboard: board, me }, { habits }] = await Promise.all([api.get(`/api/challenges/${id}`), api.get('/api/habits/mine')]);
  document.title = `${c.title} · Habit Tracker`;
  const [state, when] = status(c);

  let side;
  if (c.joined) {
    const leave = el('button', { class: 'btn btn-ghost', text: 'Leave challenge', attrs: { type: 'button' } });
    leave.addEventListener('click', () =>
      withBusy(leave, async () => {
        try {
          await api.del(`/api/challenges/${c.id}/membership`);
          toast('You left the challenge — you’re off the leaderboard');
          await renderDetail(c.id);
        } catch (err) {
          toast(errorMessage(err), { error: true });
        }
      }),
    );
    const linked = habits.find((h) => h.id === c.my_habit_id);
    side = el('div', { class: 'card' }, el('h3', { text: 'You’re in' }), el('p', { class: 'muted', text: `Counting “${linked?.title ?? 'your habit'}”. ${me ? `Rank ${me.rank} with ${me.days} days.` : ''}` }), leave);
  } else if (state === 'ended') {
    side = el('div', { class: 'card' }, el('p', { class: 'muted', text: 'This challenge has ended.' }));
  } else if (habits.length === 0) {
    side = el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Add a habit on Today first, then join with it.' }), el('a', { class: 'btn', text: 'Go to Today', attrs: { href: '/' } }));
  } else {
    side = joinForm(c, habits);
  }

  fill(
    main,
    el(
      'header',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, categoryChip(c.category), ` ${state} · ${when}`),
        el('h1', { class: 'detail-title', text: c.title }),
        el('p', { class: 'byline', text: `${formatDate(c.start_date)} – ${formatDate(c.end_date)} · ${c.member_count} taking part` }),
        c.description ? el('p', { class: 'description', text: c.description }) : null,
      ),
      el('a', { class: 'btn btn-ghost btn-sm', text: '← All challenges', attrs: { href: '/challenges.html' } }),
    ),
    el(
      'div',
      { class: 'detail section' },
      el('section', {}, el('div', { class: 'section-head' }, el('h2', { text: 'Leaderboard' }), el('span', { class: 'mono muted', text: 'days completed' })), leaderboard(board)),
      el('section', {}, side),
    ),
  );
}

await initPage({ active: 'challenges' });
const id = idFromQuery();
try {
  if (id) await renderDetail(id);
  else await renderList();
  reveal([...main.children]);
} catch (err) {
  const missing = err instanceof ApiError && err.status === 404;
  fill(main, el('div', { class: 'empty' }, el('h2', { text: missing ? 'Challenge not found' : 'Something went wrong' }), el('p', { class: 'muted', text: missing ? 'It may have been removed.' : errorMessage(err) }), el('a', { class: 'btn', text: 'All challenges', attrs: { href: '/challenges.html' } })));
}
