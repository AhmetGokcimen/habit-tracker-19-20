// "Sprout" — a small coral habit buddy with a seedling on its head.
// Built entirely from SVG primitives here (no image files, no third-party art).
//
// Login states:
//   is-covering  paws over the eyes (default, password hidden)
//   (no class)   paws lowered, eyes open and following the pointer (password shown)
// Dashboard moods (see setMood): is-sleepy, (none), is-proud; --growth scales the sprout.
// Visual states are CSS classes (see css/mascot.css); this module toggles them
// and writes the pointer direction into --px / --py for the pupils.

import { svg } from './dom.js';

const INK = '#0f2b2c';

function buildSvg() {
  return svg(
    'svg',
    { attrs: { viewBox: '0 0 240 240', role: 'img', 'aria-label': 'Sprout, the habit buddy' } },
    svg('ellipse', { attrs: { cx: 120, cy: 224, rx: 64, ry: 9, fill: 'rgba(0,0,0,0.28)' } }),
    svg(
      'g',
      { class: 'm-body-group' },
      svg(
        'g',
        { class: 'm-sprout' },
        svg('path', { attrs: { d: 'M120 70 C119 56 117 46 122 34', stroke: '#23816f', 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round' } }),
        svg('path', { attrs: { d: 'M120 50 C106 36 90 40 87 49 C100 56 112 56 120 50 Z', fill: '#3fb59a' } }),
        svg('path', { attrs: { d: 'M122 38 C134 22 153 24 157 33 C146 43 132 44 122 38 Z', fill: '#23816f' } }),
      ),
      svg('ellipse', { attrs: { cx: 120, cy: 144, rx: 82, ry: 76, fill: '#ff5e3a' } }),
      svg('ellipse', { attrs: { cx: 92, cy: 104, rx: 26, ry: 12, fill: '#fff', opacity: 0.2, transform: 'rotate(-24 92 104)' } }),
      svg('ellipse', { attrs: { cx: 76, cy: 162, rx: 13, ry: 8, fill: '#ffc94a', opacity: 0.9 } }),
      svg('ellipse', { attrs: { cx: 164, cy: 162, rx: 13, ry: 8, fill: '#ffc94a', opacity: 0.9 } }),
      svg(
        'g',
        { class: 'm-eyes' },
        svg('ellipse', { attrs: { cx: 94, cy: 135, rx: 16, ry: 18, fill: '#fff' } }),
        svg('ellipse', { attrs: { cx: 146, cy: 135, rx: 16, ry: 18, fill: '#fff' } }),
        svg(
          'g',
          { class: 'm-pupils' },
          svg('circle', { attrs: { cx: 94, cy: 136, r: 8.5, fill: INK } }),
          svg('circle', { attrs: { cx: 146, cy: 136, r: 8.5, fill: INK } }),
          svg('circle', { attrs: { cx: 97, cy: 132, r: 2.6, fill: '#fff' } }),
          svg('circle', { attrs: { cx: 149, cy: 132, r: 2.6, fill: '#fff' } }),
        ),
      ),
      svg(
        'g',
        { class: 'm-eyes-closed' },
        svg('path', { attrs: { d: 'M80 138 Q94 146 108 138', stroke: INK, 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round' } }),
        svg('path', { attrs: { d: 'M132 138 Q146 146 160 138', stroke: INK, 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round' } }),
      ),
      svg('path', {
        class: 'm-mouth-flat',
        attrs: { d: 'M110 172 L130 172', stroke: INK, 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round' },
      }),
      svg('path', {
        class: 'm-mouth-smile',
        attrs: { d: 'M108 168 Q120 180 132 168', stroke: INK, 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round' },
      }),
      svg('ellipse', { class: 'm-mouth-o', attrs: { cx: 120, cy: 172, rx: 6.5, ry: 8, fill: INK } }),
      paw('m-arm m-arm-left', 52),
      paw('m-arm m-arm-right', 188),
    ),
    svg('text', { class: 'm-zzz', attrs: { x: 186, y: 72, 'aria-hidden': 'true' }, text: 'z z' }),
  );
}

// A mitten-shaped paw: lighter than the body with an outline and finger
// creases. Large enough (20x26) to fully hide an eye (16x18) when centred on it.
function paw(className, cx) {
  const crease = { stroke: '#c9381a', 'stroke-width': 2.5, 'stroke-linecap': 'round', fill: 'none' };
  return svg(
    'g',
    { class: className },
    svg('ellipse', { attrs: { cx, cy: 184, rx: 20, ry: 26, fill: '#ff8a6b', stroke: '#c9381a', 'stroke-width': 3 } }),
    svg('path', { attrs: { d: `M${cx - 8} 166 L${cx - 8} 177`, ...crease } }),
    svg('path', { attrs: { d: `M${cx} 163 L${cx} 175`, ...crease } }),
    svg('path', { attrs: { d: `M${cx + 8} 166 L${cx + 8} 177`, ...crease } }),
  );
}

export function createMascot(container, { covering = true } = {}) {
  // Start with the paws already over the eyes (class set before the SVG is
  // inserted, so there is no opening animation that would reveal the eyes).
  container.classList.add('mascot');
  if (covering) container.classList.add('is-covering');
  container.replaceChildren(buildSvg());

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  return {
    set(state, on) {
      container.classList.toggle(`is-${state}`, on);
    },
    // Momentary reaction ("oops" on failed login, "happy" on success).
    react(state) {
      container.classList.remove(`is-${state}`);
      void container.getBoundingClientRect(); // restart the animation
      container.classList.add(`is-${state}`);
      setTimeout(() => container.classList.remove(`is-${state}`), 700);
    },
    // Dashboard mood: 'sleepy' (nothing done yet), 'neutral', 'proud' (all done).
    // growth 0..1 makes the sprout on its head bigger as streaks grow.
    setMood(mood, growth = 0) {
      container.classList.toggle('is-sleepy', mood === 'sleepy');
      container.classList.toggle('is-proud', mood === 'proud');
      container.style.setProperty('--growth', String(Math.max(0, Math.min(1, growth))));
    },
    // Points the pupils towards a screen coordinate.
    lookAt(clientX, clientY) {
      if (reduced) return;
      const rect = container.getBoundingClientRect();
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height * 0.56);
      const dist = Math.hypot(dx, dy) || 1;
      const strength = Math.min(1, dist / 260);
      container.style.setProperty('--px', ((dx / dist) * strength).toFixed(3));
      container.style.setProperty('--py', ((dy / dist) * strength).toFixed(3));
    },
  };
}

/**
 * Wires the mascot to a password field and its show/hide button:
 *  - password hidden (the default) -> paws over the eyes
 *  - password shown                -> paws lowered, eyes open
 */
export function bindPasswordMascot(mascot, passwordInput, toggleButton) {
const sync = () => {
  const isPasswordFocused = document.activeElement === passwordInput;
  const isPasswordHidden = passwordInput.type === 'password';

  mascot.set('covering', isPasswordFocused && isPasswordHidden);
};

passwordInput.addEventListener('focus', sync);
passwordInput.addEventListener('blur', sync);
  toggleButton.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    toggleButton.textContent = show ? 'Hide' : 'Show';
    toggleButton.setAttribute('aria-pressed', String(show));
    toggleButton.setAttribute('aria-label', show ? 'Hide password' : 'Show password');

passwordInput.focus({ preventScroll: true });
sync();
  });
  sync();

  addEventListener('pointermove', (event) => mascot.lookAt(event.clientX, event.clientY));
}
