// Explore: search and filter public habits (F7). The query string is only ever
// passed to the API through URLSearchParams and shown back via input.value /
// textContent, so a crafted ?q= cannot inject markup (no reflected XSS).

import { api } from '../api.js';
import { el, $ } from '../dom.js';
import { initPage, toast, errorMessage, showFormErrors, clearFormErrors } from '../shell.js';
import { reveal } from '../motion.js';
import { CATEGORIES, categoryChip } from '../components.js';

const form = $('#search-form');
const results = $('#results');
const pager = $('#pager');
const count = $('#result-count');
const chips = $('#categories');

function readState() {
  const params = new URLSearchParams(location.search);
  const category = params.get('category');
  const frequency = params.get('frequency');
  const goalType = params.get('goal_type');
  const sort = params.get('sort');
  const page = Number(params.get('page'));
  return {
    q: (params.get('q') ?? '').slice(0, 50),
    category: CATEGORIES.includes(category) ? category : '',
    frequency: ['daily', 'weekdays', 'weekly'].includes(frequency) ? frequency : '',
    goal_type: ['simple', 'measurable'].includes(goalType) ? goalType : '',
    sort: ['newest', 'oldest', 'popular', 'discussed'].includes(sort) ? sort : 'newest',
    page: Number.isInteger(page) && page > 0 && page <= 1000 ? page : 1,
  };
}

let state = readState();

function syncUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.category) params.set('category', state.category);
  if (state.frequency) params.set('frequency', state.frequency);
  if (state.goal_type) params.set('goal_type', state.goal_type);
  if (state.sort !== 'newest') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function renderChips() {
  const options = [['', 'all'], ...CATEGORIES.map((c) => [c, c])];
  chips.replaceChildren(
    ...options.map(([value, label]) => {
      const chip = el('button', {
        class: 'chip chip-toggle',
        text: label,
        dataset: value ? { cat: value } : {},
        attrs: { type: 'button', 'aria-pressed': String(state.category === value) },
      });
      chip.addEventListener('click', () => {
        state = { ...state, category: value, page: 1 };
        renderChips();
        search();
      });
      return chip;
    }),
  );
}


function renderActiveFilters() {
  const container = $('#active-filters');

  const active = [
    ['q', state.q, `Search: ${state.q}`],
    ['category', state.category, `Category: ${state.category}`],
    ['sort', state.sort !== 'newest', `Sort: ${state.sort}`],
    ['frequency', state.frequency, `Frequency: ${state.frequency}`],
    ['goal_type', state.goal_type, `Goal: ${state.goal_type}`],
  ].filter(([, value]) => Boolean(value));

  container.hidden = active.length === 0;

  container.replaceChildren(...active.map(([key, , label]) => {
    const button = el('button', {
      class: 'chip chip-toggle',
      text: `${label} ×`,
      attrs: {
        type: 'button',
        'aria-label': `Remove ${label} filter`,
      },
    });

    button.addEventListener('click', () => {
      state = {
        ...state,
        [key]: key === 'sort' ? 'newest' : '',
        page: 1,
      };

      form.q.value = state.q;
      $('#sort').value = state.sort;
      $('#frequency').value = state.frequency;
      $('#goal-type').value = state.goal_type;

      renderChips();
      search();
    });

    return button;
  }));
}


function resultCard(habit) {
  const comments = [
    habit.comment_count === 1 ? '1 comment' : `${habit.comment_count} comments`,
    habit.reaction_count ? `${habit.reaction_count} cheer${habit.reaction_count === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  return el(
    'article',
    { class: 'card tilt habit-card' },
    el('div', { class: 'meta' }, categoryChip(habit.category), el('span', { class: 'byline', text: comments })),
    el(
      'div',
      {},
      el('h3', {}, el('a', { text: habit.title, attrs: { href: `/habit.html?id=${habit.id}` } })),
      habit.description ? el('p', { class: 'desc', text: habit.description }) : null,
    ),
    el('p', { class: 'byline owner-link' }, 'by ', el('a', { text: `@${habit.owner.username}`, attrs: { href: `/user.html?id=${habit.owner.id}` } })),
  );
}

// Shared habits of people you follow (public data only).
async function loadFeed() {
  const feed = $('#feed');
  try {
    const { habits } = await api.get('/api/feed');
    feed.replaceChildren(
      el('div', { class: 'section-head' }, el('h2', { text: 'From people you follow' }), el('span', { class: 'mono muted', text: String(habits.length) })),
      habits.length
        ? el('div', { class: 'grid' }, habits.slice(0, 6).map(resultCard))
        : el('p', { class: 'muted', text: 'Follow people from their profile (tap their @name) to see what they share here.' }),
    );
  } catch {
    feed.replaceChildren();
  }
}

function pageButton(label, page, disabled) {
  const button = el('button', { class: 'btn btn-sm', text: label, attrs: { type: 'button', disabled } });
  button.addEventListener('click', () => {
    state = { ...state, page };
    search();
    scrollTo({ top: 0, behavior: 'smooth' });
  });
  return button;
}

async function search() {
  syncUrl();
  renderActiveFilters();
  clearFormErrors(form);
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.q) params.set('q', state.q);
  if (state.category) params.set('category', state.category);
  if (state.frequency) params.set('frequency', state.frequency);
  if (state.goal_type) params.set('goal_type', state.goal_type);
  if (state.sort !== 'newest') params.set('sort', state.sort);

  results.replaceChildren(el('span', { class: 'loading', attrs: { 'aria-label': 'Loading' } }));
  try {
    const data = await api.get(`/api/habits?${params}`);
    if (data.habits.length === 0) {
      results.replaceChildren(
        el(
          'div',
          { class: 'empty' },
          el('h3', { text: state.q ? `No shared habits match “${state.q}”` : 'No shared habits here yet' }),
          el('p', { class: 'muted', text: 'Try another word or category — or share one of your own habits from Today.' }),
        ),
      );
    } else {
      const cards = data.habits.map(resultCard);
      results.replaceChildren(el('div', { class: 'grid' }, cards));
      reveal(cards);
    }
    count.textContent = `page ${data.page}`;
    pager.replaceChildren(
      pageButton('← Newer', state.page - 1, state.page <= 1),
      pageButton('Older →', state.page + 1, !data.has_more),
    );
  } catch (err) {
    results.replaceChildren();
    showFormErrors(form, err);
    toast(errorMessage(err), { error: true });
  }
}

await initPage({ active: 'explore' });
form.q.value = state.q;

const goalTypeSelect = $('#goal-type');
goalTypeSelect.value = state.goal_type;

// Automatically filter habits when the goal type changes.
goalTypeSelect.addEventListener('change', () => {
  state = {
    ...state,
    q: form.q.value.trim().slice(0, 50),
    goal_type: goalTypeSelect.value,
    page: 1,
  };
  search();
});

const frequencySelect = $('#frequency');
frequencySelect.value = state.frequency;

// Automatically filter habits when frequency changes.
frequencySelect.addEventListener('change', () => {
  state = {
    ...state,
    q: form.q.value.trim().slice(0, 50),
    frequency: frequencySelect.value,
    page: 1,
  };
  search();
});

const sortSelect = $('#sort');
sortSelect.value = state.sort;

// Automatically update results when the sorting option changes.
sortSelect.addEventListener('change', () => {
  state = {
    ...state,
    q: form.q.value.trim().slice(0, 50),
    sort: sortSelect.value,
    page: 1,
  };
  search();
});

renderChips();
form.addEventListener('submit', (event) => {
  event.preventDefault();
  state = { ...state, q: form.q.value.trim().slice(0, 50), page: 1 };
  search();
});

const resetButton = $('#reset-filters');

// Reset all search filters to their default values.
resetButton.addEventListener('click', () => {
  state = {
    q: '',
    category: '',
    frequency: '',
    goal_type: '',
    sort: 'newest',
    page: 1,
  };

  form.q.value = '';
  frequencySelect.value = '';
  goalTypeSelect.value = '';
  sortSelect.value = 'newest';

  renderChips();
  search();
});

await Promise.all([search(), loadFeed()]);
