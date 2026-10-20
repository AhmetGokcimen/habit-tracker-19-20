// Reusable UI pieces: category chip, the stamped chain of days, streaks,
// and the create/edit habit dialog. All text is set with textContent via el().

import { api } from './api.js';
import { el, localISODate, addDays } from './dom.js';
import { showFormErrors, clearFormErrors, withBusy } from './shell.js';

export const CATEGORIES = ['health', 'fitness', 'learning', 'productivity', 'mindfulness', 'social', 'other'];

export function categoryChip(category) {
  const safe = CATEGORIES.includes(category) ? category : 'other';
  return el('span', { class: 'chip', text: safe, dataset: { cat: safe } });
}

export function visibilityLabel(isPublic) {
  return el('span', { class: 'visibility', text: isPublic ? '● shared' : '○ private' });
}

// Small deterministic tilt per date so stamped days look hand-made.
function stampRotation(isoDate) {
  let h = 0;
  for (const ch of isoDate) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return `${(h % 7) - 3}deg`;
}

/** Last `days` days ending today; filled cells are days with a check-in. */
export function chain(dates, days = 21) {
  const done = new Set(dates);
  const today = localISODate();
  const cells = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const isDone = done.has(date);
    cells.push(
      el('span', {
        class: `day${isDone ? ' is-done' : ''}${i === 0 ? ' is-today' : ''}`,
        attrs: { title: `${date}${isDone ? ' — checked in' : ''}` },
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

/** Consecutive days up to today (or up to yesterday if today is still open). */
export function currentStreak(dates) {
  const done = new Set(dates);
  let day = localISODate();
  if (!done.has(day)) day = addDays(day, -1);
  let streak = 0;
  while (done.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

export function streakBadge(n) {
  return el('span', { class: 'streak' }, el('strong', { text: String(n) }), 'day streak');
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
