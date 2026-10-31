// Shared behaviour of the login and register pages: the mascot stage with
// parallax tally marks, the password show/hide toggle, and safe redirects.

import { svg, $ } from './dom.js';
import { createMascot, bindPasswordMascot } from './mascot.js';
import { enableParallax } from './motion.js';
import { brandMark } from './shell.js';

// Decorative tally groups floating at different depths behind the mascot.
const FLOATS = [
  { x: '8%', y: '12%', w: '96px', depth: '18px', rot: '-14deg', c: 'rgba(255,255,255,0.07)' },
  { x: '72%', y: '8%', w: '70px', depth: '-26px', rot: '10deg', c: 'rgba(255,94,58,0.35)' },
  { x: '80%', y: '62%', w: '120px', depth: '30px', rot: '-6deg', c: 'rgba(255,255,255,0.06)' },
  { x: '12%', y: '70%', w: '64px', depth: '-16px', rot: '18deg', c: 'rgba(255,201,74,0.35)' },
  { x: '44%', y: '84%', w: '52px', depth: '10px', rot: '-22deg', c: 'rgba(255,255,255,0.08)' },
];

function tallyGlyph() {
  return svg(
    'svg',
    { attrs: { viewBox: '0 0 60 40', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round' } },
    ...[10, 22, 34, 46].map((x) => svg('line', { attrs: { x1: x, y1: 6, x2: x, y2: 34 } })),
    svg('line', { attrs: { x1: 4, y1: 30, x2: 54, y2: 10 } }),
  );
}

export function setupAuthStage() {
  const stage = $('.auth-stage');
  for (const f of FLOATS) {
    const glyph = tallyGlyph();
    glyph.setAttribute('class', 'float');
    for (const [k, v] of Object.entries({ '--x': f.x, '--y': f.y, '--w': f.w, '--depth': f.depth, '--rot': f.rot, '--c': f.c })) {
      glyph.style.setProperty(k, v);
    }
    stage.prepend(glyph);
  }
  enableParallax(stage);
  $('.brand-slot')?.replaceChildren(brandMark());

  const mascot = createMascot($('#mascot'), { covering: false });
  bindPasswordMascot(mascot, $('#password'), $('#toggle-password'));
  return mascot;
}

// Only same-site page paths are accepted as ?next= targets (no open redirect).
export function safeNextPath() {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^\/(?:[a-z]+\.html)?(?:\?id=[1-9][0-9]{0,9})?$/.test(next) ? next : '/';
}
