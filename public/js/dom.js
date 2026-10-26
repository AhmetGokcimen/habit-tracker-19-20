// Safe DOM construction. This is the ONLY way pages create markup:
//   - text always goes through textContent / text nodes (never innerHTML),
//   - attributes go through setAttribute with inline handlers (on*) refused,
//   - URLs must be same-origin relative paths.
// Server data can therefore never become HTML or script.

const SVG_NS = 'http://www.w3.org/2000/svg';
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);

function isSafeUrl(value) {
  // Only app-relative paths like "/habit.html?id=3" or "/api/checkins/5/photo".
  return typeof value === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(value);
}

function setAttributes(node, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith('on') || lower === 'style' || lower === 'srcdoc') {
      throw new Error(`Refusing to set attribute "${name}"`);
    }
    if (URL_ATTRS.has(lower) && !isSafeUrl(String(value))) {
      throw new Error(`Refusing unsafe URL for "${name}"`);
    }
    node.setAttribute(name, value === true ? '' : String(value));
  }
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * el('a', { class: 'x', text: title, attrs: { href }, on: { click }, vars: { '--i': 2 } }, ...children)
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  build(node, props, children);
  return node;
}

export function svg(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  build(node, props, children);
  return node;
}

function build(node, props, children) {
  const { class: className, text, attrs, on, vars, dataset } = props;
  if (className) node.setAttribute('class', className);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) setAttributes(node, attrs);
  if (dataset) Object.assign(node.dataset, dataset);
  // CSS custom properties are set through the CSSOM, which CSP permits.
  if (vars) for (const [k, v] of Object.entries(vars)) node.style.setProperty(k, String(v));
  if (on) for (const [event, handler] of Object.entries(on)) node.addEventListener(event, handler);
  append(node, children);
}

/** Replaces a node's children; like el(), skips null / undefined / false. */
export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $all(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

// "2026-10-20" in the user's local calendar.
export function localISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localISODate(d);
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const shortFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export function formatDate(isoDate) {
  return dateFormatter.format(new Date(`${isoDate.slice(0, 10)}T12:00:00`));
}

export function formatShortDate(isoDate) {
  return shortFormatter.format(new Date(`${isoDate}T12:00:00`));
}

// SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS".
export function formatTimestamp(sqlTimestamp) {
  const d = new Date(`${sqlTimestamp.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

// Reads ?name= from the current URL and accepts only a positive integer id.
export function idFromQuery(name = 'id') {
  const raw = new URLSearchParams(location.search).get(name);
  return raw && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
}
