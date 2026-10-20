// Pointer-reactive motion. Only writes CSS custom properties (CSSOM); the
// actual animation is CSS transform/opacity. Disabled for reduced motion and
// on touch devices.

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

const MAX_TILT = 4; // degrees

export function enableTilt(root = document) {
  if (prefersReducedMotion() || !finePointer()) return;
  root.addEventListener('pointermove', (event) => {
    const card = event.target.closest?.('.tilt');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    card.style.setProperty('--ry', `${((x - 0.5) * MAX_TILT * 2).toFixed(2)}deg`);
    card.style.setProperty('--rx', `${((0.5 - y) * MAX_TILT * 2).toFixed(2)}deg`);
    card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  });
  root.addEventListener(
    'pointerout',
    (event) => {
      const card = event.target.closest?.('.tilt');
      if (card && !card.contains(event.relatedTarget)) {
        card.style.setProperty('--rx', '0deg');
        card.style.setProperty('--ry', '0deg');
      }
    },
    true,
  );
}

// Staggered entrance for the given elements.
export function reveal(elements) {
  elements.forEach((node, i) => {
    node.style.setProperty('--i', String(Math.min(i, 12)));
    node.classList.add('reveal');
  });
}

// Moves layered elements against the pointer (depth via --depth per element).
export function enableParallax(container) {
  if (prefersReducedMotion() || !finePointer()) return () => {};
  const handler = (event) => {
    const px = (event.clientX / innerWidth - 0.5) * 2;
    const py = (event.clientY / innerHeight - 0.5) * 2;
    container.style.setProperty('--px', px.toFixed(3));
    container.style.setProperty('--py', py.toFixed(3));
  };
  addEventListener('pointermove', handler);
  return () => removeEventListener('pointermove', handler);
}
