// Shared page shell: session check, top bar, toasts, dialogs, form errors.
// No page links to the admin panel (it is reached only by its URL). That is
// not what protects it: every admin API call is refused unless the database
// says the caller is an admin.

import { api, ApiError, goToLogin } from './api.js';
import { el, svg, $, $all } from './dom.js';
import { enableTilt } from './motion.js';

export function brandMark() {
  // Four tally strokes and the diagonal: the app's logo.
  return svg(
    'svg',
    { attrs: { viewBox: '0 0 32 32', 'aria-hidden': 'true' } },
    svg('rect', { attrs: { x: 1, y: 1, width: 30, height: 30, rx: 9, fill: '#0f2b2c' } }),
    ...[8, 13, 18, 23].map((x) =>
      svg('line', { attrs: { x1: x, y1: 8, x2: x, y2: 24, stroke: '#e6efec', 'stroke-width': 2.6, 'stroke-linecap': 'round' } }),
    ),
    svg('line', { attrs: { x1: 5, y1: 21, x2: 26, y2: 11, stroke: '#ff5e3a', 'stroke-width': 3, 'stroke-linecap': 'round' } }),
  );
}

const NAV = [
  { href: '/', label: 'Today', key: 'today' },
  { href: '/stats.html', label: 'Stats', key: 'stats' },
  { href: '/challenges.html', label: 'Challenges', key: 'challenges' },
  { href: '/explore.html', label: 'Explore', key: 'explore' },
  { href: '/subscription.html', label: 'Pricing', key: 'subscription' },
  { href: '/contact.html', label: 'Contact', key: 'contact' },
  { href: '/profile.html', label: 'Profile', key: 'profile' },
];

// ---- theme (system / light / dark), applied early by js/theme.js ----------

const THEMES = [
  ['system', '◐', 'Theme: follows your system'],
  ['light', '☀', 'Theme: light'],
  ['dark', '☾', 'Theme: dark'],
];

function currentTheme() {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function themeToggle() {
  const button = el('button', { class: 'btn btn-ghost btn-sm theme-toggle', attrs: { type: 'button' } });
  const sync = () => {
    const [, icon, label] = THEMES.find(([key]) => key === currentTheme());
    button.textContent = icon;
    button.setAttribute('aria-label', `${label}. Click to change.`);
    button.title = label;
  };
  button.addEventListener('click', () => {
    const next = THEMES[(THEMES.findIndex(([key]) => key === currentTheme()) + 1) % THEMES.length][0];
    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch {
      // storage blocked: the change lasts for this page only
    }
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    sync();
  });
  sync();
  return button;
}

function renderTopbar(user, active) {
  const header = $('#topbar');
  const logout = el('button', { class: 'btn btn-ghost btn-sm', text: 'Log out', attrs: { type: 'button' } });
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await api.post('/api/auth/logout');
    } finally {
      location.assign('/login.html');
    }
  });

  header.replaceChildren(
    el(
      'div',
      { class: 'topbar-inner' },
      el('a', { class: 'brand', attrs: { href: '/', 'aria-label': 'Habit Tracker home' } }, brandMark(), 'Habit Tracker'),
      el(
        'nav',
        { class: 'nav', attrs: { 'aria-label': 'Main' } },
        NAV.map((item) =>
          el('a', {
            text: item.label,
            attrs: { href: item.href, 'aria-current': item.key === active ? 'page' : undefined },
          }),
        ),
      ),
      el(
        'div',
        { class: 'account' },
        themeToggle(),
        el('a', { class: 'who', text: `@${user.username}`, attrs: { href: '/profile.html' } }),
        logout,
      ),
    ),
  );
}

function renderFooter() {
  let footer = document.getElementById('site-footer');

  if (!footer) {
    footer = el('footer', {
      class: 'site-footer',
      attrs: { id: 'site-footer' },
    });

    document.body.append(footer);
  }

  footer.replaceChildren(
    el(
      'div',
      { class: 'site-footer-inner' },

      // Brand information
      el(
        'div',
        { class: 'footer-brand' },
        el('a', {
          class: 'footer-logo',
          text: 'Habit Tracker',
          attrs: { href: '/' },
        }),
        el('p', {
          text: 'Small marks, every day. Build better habits, one day at a time.',
        }),
      ),

      // Footer navigation
      el(
        'div',
        { class: 'footer-links' },

        el(
          'nav',
          { attrs: { 'aria-label': 'Footer product links' } },
          el('h3', { text: 'Product' }),
          el('a', { text: 'Explore', attrs: { href: '/explore.html' } }),
          el('a', { text: 'Pricing', attrs: { href: '/subscription.html' } }),
          el('a', { text: 'Challenges', attrs: { href: '/challenges.html' } }),
        ),

        el(
          'nav',
          { attrs: { 'aria-label': 'Footer company links' } },
          el('h3', { text: 'Company' }),
          el('a', { text: 'Contact', attrs: { href: '/contact.html' } }),
        ),

        el(
          'div',
          { class: 'footer-legal' },
          el('h3', { text: 'Legal' }),
          el('p', { text: 'Legal pages coming soon.' }),
        ),
      ),

      // Footer bottom
      el(
        'div',
        { class: 'footer-bottom' },
        el('p', { text: `© ${new Date().getFullYear()} Habit Tracker` }),
        el('p', { text: 'Built for better habits.' }),
      ),
    ),
  );
}

/** Loads the session (redirecting to login if there is none) and draws the shell. */
export async function initPage({ active } = {}) {
  let user;
  try {
    ({ user } = await api.get('/api/auth/me'));
  } catch (err) {
    // No session: go to the login page and stop the page script here.
    if (err instanceof ApiError && err.status === 401) {
      goToLogin();
      return new Promise(() => {});
    }
    throw err;
  }
  renderTopbar(user, active);
  renderFooter();
  ensureToastRegion();
  enableTilt();
  // Loaded lazily: reminders.js imports this module.
  import('./reminders.js').then((m) => m.startReminders()).catch(() => {});
  return user;
}

// ---- toasts ---------------------------------------------------------------

function ensureToastRegion() {
  let region = $('#toasts');
  if (!region) {
    region = el('div', { class: 'toasts', attrs: { id: 'toasts', role: 'status', 'aria-live': 'polite' } });
    document.body.append(region);
  }
  return region;
}

/** action: optional { label, onClick } shown as a button (e.g. "Undo"). */
export function toast(message, { error = false, action = null } = {}) {
  const item = el('div', { class: `toast${error ? ' is-error' : ''}` }, el('span', { text: message }));
  const leave = () => {
    item.classList.add('is-leaving');
    item.addEventListener('animationend', () => item.remove(), { once: true });
    setTimeout(() => item.remove(), 400);
  };
  if (action) {
    const button = el('button', { class: 'toast-action', text: action.label, attrs: { type: 'button' } });
    button.addEventListener('click', () => {
      button.disabled = true;
      leave();
      action.onClick();
    });
    item.append(button);
  }
  ensureToastRegion().append(item);
  setTimeout(leave, action ? 6000 : 3200);
}

export function errorMessage(err) {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    if (err.status === 403) return 'You don’t have permission to do that.';
    return err.message;
  }
  return 'Could not reach the server. Check your connection and try again.';
}

// ---- dialogs ----------------------------------------------------------------

export function confirmDialog({ title, message, confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    const cancel = el('button', { class: 'btn btn-ghost', text: 'Cancel', attrs: { type: 'button', value: 'cancel' } });
    const confirm = el('button', {
      class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
      text: confirmLabel,
      attrs: { type: 'button', value: 'confirm' },
    });
    const dialog = el(
      'dialog',
      { class: 'dialog', attrs: { 'aria-labelledby': 'dialog-title' } },
      el('h2', { text: title, attrs: { id: 'dialog-title' } }),
      el('p', { class: 'muted', text: message }),
      el('div', { class: 'dialog-actions' }, cancel, confirm),
    );
    const finish = (result) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

// ---- forms --------------------------------------------------------------------

export function clearFormErrors(form) {
  for (const field of $all('.field', form)) {
    field.classList.remove('has-error');
    $('.field-error', field)?.remove();
  }
  $('.form-error', form)?.remove();
}

/** Shows server-side validation messages next to the matching fields. */
export function showFormErrors(form, err) {
  clearFormErrors(form);
  let placed = false;
  if (err instanceof ApiError) {
    for (const { field, message } of err.details) {
      const container = $(`.field[data-field="${CSS.escape(field)}"]`, form);
      if (!container) continue;
      container.classList.add('has-error');
      container.append(el('p', { class: 'field-error', text: message }));
      placed = true;
    }
  }
  if (!placed) {
    form.prepend(el('p', { class: 'form-error', text: errorMessage(err), attrs: { role: 'alert' } }));
  }
}

export async function withBusy(button, task) {
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.disabled = false;
  }
}
