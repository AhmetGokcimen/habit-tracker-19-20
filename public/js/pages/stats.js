// Statistics: the signed-in user's own completion numbers (GET /api/users/me/stats).
// Charts are plain SVG built with svg()/el() — no chart library, no innerHTML.
// Every chart is single-series (one hue), has a hover tooltip, and the
// per-habit table below doubles as the table view.

import { api } from '../api.js';
import { el, svg, $, formatShortDate } from '../dom.js';
import { initPage, toast, errorMessage } from '../shell.js';
import { reveal } from '../motion.js';
import { categoryChip, WEEKDAYS } from '../components.js';

const main = $('#main');
const RANGES = [
  ['30', '30 days'],
  ['90', '90 days'],
  ['365', '1 year'],
];
let range = '30';

// ---- tooltip --------------------------------------------------------------------

const tip = el('div', { class: 'chart-tip', attrs: { role: 'tooltip', hidden: true } });
document.body.append(tip);

function bindTip(target, lines) {
  const show = (event) => {
    tip.replaceChildren(...lines.map((line, i) => el(i === 0 ? 'strong' : 'span', { text: line })));
    tip.hidden = false;
    const x = Math.min(event.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const y = Math.max(event.clientY - tip.offsetHeight - 12, 8);
    tip.style.setProperty('--x', `${x}px`);
    tip.style.setProperty('--y', `${y}px`);
  };
  target.addEventListener('pointerenter', show);
  target.addEventListener('pointermove', show);
  target.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });
}

// ---- charts -----------------------------------------------------------------------

/**
 * Vertical bars of a percentage (0-100) anchored to the baseline.
 * items: [{ value: number|null, label, tip: [title, ...lines] }]
 */
function percentBars(items, { height = 160, labelEvery = 1, ariaLabel }) {
  const W = 1000;
  const slot = W / items.length;
  const gap = Math.min(2 * (W / 600), slot * 0.3); // ~2px surface gap
  const barW = Math.max(slot - gap, 1);
  const H = height;
  const grid = [0, 50, 100].map((p) =>
    svg('line', { class: 'chart-grid', attrs: { x1: 0, x2: W, y1: H - (p / 100) * H, y2: H - (p / 100) * H } }),
  );
  const bars = items.map((item, i) => {
    const x = i * slot + gap / 2;
    const h = item.value === null ? 0 : Math.max((item.value / 100) * H, item.value > 0 ? 3 : 0);
    const group = svg(
      'g',
      { class: 'chart-bar' },
      svg('rect', { class: 'chart-hit', attrs: { x: i * slot, y: 0, width: slot, height: H } }),
      item.value === null
        ? svg('rect', { class: 'chart-none', attrs: { x, y: H - 2, width: barW, height: 2 } })
        : svg('rect', { class: 'chart-fill', attrs: { x, y: H - h, width: barW, height: h, rx: Math.min(4, barW / 2) } }),
    );
    bindTip(group, item.tip);
    return group;
  });
  const chart = svg(
    'svg',
    { class: 'chart', attrs: { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': ariaLabel } },
    grid,
    bars,
  );
  const labels = el(
    'div',
    { class: 'chart-labels', vars: { '--n': items.length } },
    items.map((item, i) => el('span', { text: i % labelEvery === 0 ? item.label : '' })),
  );
  return el('div', { class: 'chart-wrap' }, el('div', { class: 'chart-axis' }, el('span', { text: '100%' }), el('span', { text: '50%' }), el('span', { text: '0%' })), el('div', {}, chart, labels));
}

/** Horizontal bars of counts with direct labels. rows: [{ label: Node, value }] */
function countBars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return el(
    'ul',
    { class: 'hbars' },
    rows.map((r) => {
      const bar = el('span', { class: 'hbar-fill', vars: { '--w': `${(r.value / max) * 100}%` } });
      const row = el('li', {}, r.label, el('span', { class: 'hbar' }, bar), el('span', { class: 'hbar-value', text: String(r.value) }));
      bindTip(row, [r.name, `${r.value} check-ins`]);
      return row;
    }),
  );
}

// ---- page ---------------------------------------------------------------------------

function tile(label, value, note) {
  return el('div', { class: 'stat-tile' }, el('dt', { text: label }), el('dd', { text: value }), note ? el('p', { class: 'hint', text: note }) : null);
}

const pct = (v) => (v === null ? '—' : `${v}%`);

function rangeFilter() {
  return el(
    'div',
    { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Time range' } },
    RANGES.map(([value, label]) => {
      const b = el('button', { class: 'chip-toggle', text: label, attrs: { type: 'button', 'aria-pressed': String(value === range) } });
      b.addEventListener('click', () => {
        if (value === range) return;
        range = value;
        load();
      });
      return b;
    }),
  );
}

function render(data) {
  const best = data.by_weekday.filter((w) => w.rate !== null).sort((a, b) => b.rate - a.rate)[0];
  const tiles = el(
    'dl',
    { class: 'stat-tiles' },
    tile('Completion', pct(data.totals.rate), `${data.totals.done} of ${data.totals.due} due check-ins`),
    tile('Check-ins', String(data.habits.reduce((s, h) => s + h.done, 0)), `in the last ${data.range} days`),
    tile('Best day', best ? WEEKDAYS[best.weekday - 1] : '—', best ? `${best.rate}% done on ${WEEKDAYS[best.weekday - 1]}s` : 'no data yet'),
  );

  const n = data.daily.length;
  const daily = percentBars(
    data.daily.map((d) => ({
      value: d.due === 0 ? null : Math.round((d.done / d.due) * 100),
      label: formatShortDate(d.date).split(',').pop().trim(),
      tip: [formatShortDate(d.date), d.due === 0 ? 'nothing due' : `${d.done} of ${d.due} done`, d.frozen ? `${d.frozen} frozen` : ''].filter(Boolean),
    })),
    { labelEvery: n <= 30 ? 7 : n <= 90 ? 14 : 61, ariaLabel: `Daily completion over the last ${n} days` },
  );

  const weekday = percentBars(
    data.by_weekday.map((w) => ({
      value: w.rate,
      label: WEEKDAYS[w.weekday - 1],
      tip: [WEEKDAYS[w.weekday - 1], w.due === 0 ? 'nothing due' : `${w.rate}% — ${w.done} of ${w.due}`],
    })),
    { height: 120, ariaLabel: 'Completion rate by weekday' },
  );

  const categories = data.by_category.length
    ? countBars(data.by_category.map((c) => ({ label: categoryChip(c.category), name: c.category, value: c.done })))
    : el('p', { class: 'muted', text: 'No check-ins in this range yet.' });

  const table = el(
    'table',
    { class: 'stat-table' },
    el('caption', { class: 'visually-hidden', text: 'Completion per habit' }),
    el('thead', {}, el('tr', {}, ['Habit', 'Done', 'Expected', 'Completion'].map((h) => el('th', { text: h, attrs: { scope: 'col' } })))),
    el(
      'tbody',
      {},
      data.habits.map((h) =>
        el(
          'tr',
          {},
          el('th', { attrs: { scope: 'row' } }, el('a', { text: h.title, attrs: { href: `/habit.html?id=${h.id}` } })),
          el('td', { class: 'mono', text: String(h.done) }),
          el('td', { class: 'mono', text: String(h.expected) }),
          el('td', {}, el('span', { class: 'meter', vars: { '--w': `${h.rate ?? 0}%` } }), el('span', { class: 'mono', text: pct(h.rate) })),
        ),
      ),
    ),
  );

  main.replaceChildren(
    el(
      'header',
      { class: 'page-head' },
      el('div', {}, el('p', { class: 'eyebrow', text: 'Your numbers' }), el('h1', { text: 'Statistics' }), el('p', { class: 'lede', text: 'How often you kept your habits when they were due. Only you can see this page.' })),
      rangeFilter(),
    ),
    tiles,
    el('section', { class: 'section card chart-card' }, el('h2', { text: 'Daily completion' }), daily),
    el(
      'div',
      { class: 'stats-grid section' },
      el('section', { class: 'card chart-card' }, el('h2', { text: 'By weekday' }), weekday),
      el('section', { class: 'card chart-card' }, el('h2', { text: 'By category' }), categories),
    ),
    el('section', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: 'Per habit' })), data.habits.length ? table : el('p', { class: 'muted', text: 'No habits yet.' })),
  );
}

async function load() {
  try {
    render(await api.get(`/api/users/me/stats?range=${range}`));
  } catch (err) {
    toast(errorMessage(err), { error: true });
  }
}

await initPage({ active: 'stats' });
await load();
reveal([...main.children]);
