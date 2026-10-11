// Tiny DOM toolkit: an escape-by-default `html` tagged template, rendering,
// event delegation and focus-preserving re-renders. Every view builds markup
// with `html`, so stored or OCR'd text can never inject markup.

/** Marker type for trusted markup. Extends String so it still works anywhere a string does. */
export class SafeHtml extends String {}

const isSafe = (v) => v instanceof SafeHtml;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
const ESCAPE_RE = /[&<>"'`]/g;

export function escapeHtml(value) {
  return String(value).replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** Mark a string as trusted markup. Only for markup we generate ourselves (icons, components). */
export function raw(str) {
  return new SafeHtml(str == null ? '' : String(str));
}

// ---- Context analysis -------------------------------------------------------
// The static parts of a template tell us where each ${} hole sits: in text, in a
// quoted or unquoted attribute value, inside a tag (attribute position) or in a
// comment. Each context gets its own escaping. Results are cached per call site.

const S = { TEXT: 0, TAG_NAME: 1, IN_TAG: 2, ATTR_NAME: 3, AFTER_NAME: 4, BEFORE_VALUE: 5, VALUE_DQ: 6, VALUE_SQ: 7, VALUE_UNQ: 8, COMMENT: 9 };
const WS = /\s/;
const contextCache = new WeakMap();

function analyze(strings) {
  let cached = contextCache.get(strings);
  if (cached) return cached;
  const holes = [];
  let state = S.TEXT;
  let attr = '';
  let valueStart = true;
  for (let p = 0; p < strings.length; p++) {
    const str = strings[p];
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      switch (state) {
        case S.TEXT:
          if (c === '<') {
            if (str.startsWith('!--', i + 1)) { state = S.COMMENT; i += 3; }
            else if (/[a-zA-Z/!?]/.test(str[i + 1] || '')) state = S.TAG_NAME;
          }
          break;
        case S.TAG_NAME:
          if (c === '>') state = S.TEXT;
          else if (WS.test(c)) state = S.IN_TAG;
          break;
        case S.IN_TAG:
          if (c === '>') state = S.TEXT;
          else if (!WS.test(c) && c !== '/') { state = S.ATTR_NAME; attr = c; }
          break;
        case S.ATTR_NAME:
          if (c === '=') { state = S.BEFORE_VALUE; valueStart = true; }
          else if (c === '>') state = S.TEXT;
          else if (WS.test(c)) state = S.AFTER_NAME;
          else if (c === '/') state = S.IN_TAG;
          else attr += c;
          break;
        case S.AFTER_NAME:
          if (c === '=') { state = S.BEFORE_VALUE; valueStart = true; }
          else if (c === '>') state = S.TEXT;
          else if (!WS.test(c) && c !== '/') { state = S.ATTR_NAME; attr = c; }
          break;
        case S.BEFORE_VALUE:
          if (c === '"') state = S.VALUE_DQ;
          else if (c === "'") state = S.VALUE_SQ;
          else if (c === '>') state = S.TEXT;
          else if (!WS.test(c)) { state = S.VALUE_UNQ; valueStart = false; }
          break;
        // Leading whitespace doesn't fix a URL's scheme (browsers strip it), so the value still "starts".
        case S.VALUE_DQ:
          if (c === '"') state = S.IN_TAG; else if (!WS.test(c)) valueStart = false;
          break;
        case S.VALUE_SQ:
          if (c === "'") state = S.IN_TAG; else if (!WS.test(c)) valueStart = false;
          break;
        case S.VALUE_UNQ:
          if (WS.test(c)) state = S.IN_TAG;
          else if (c === '>') state = S.TEXT;
          break;
        case S.COMMENT:
          if (c === '-' && str.startsWith('-->', i)) { state = S.TEXT; i += 2; }
          break;
      }
    }
    if (p === strings.length - 1) break;
    // Describe the hole that follows this static chunk.
    const name = attr.toLowerCase();
    if (state === S.TEXT) holes.push({ type: 'text' });
    else if (state === S.COMMENT) holes.push({ type: 'comment' });
    else if (state === S.VALUE_DQ || state === S.VALUE_SQ) holes.push({ type: 'attr', name, start: valueStart });
    else if (state === S.BEFORE_VALUE || state === S.VALUE_UNQ) {
      holes.push({ type: 'unquoted', name, start: state === S.BEFORE_VALUE });
      state = S.VALUE_UNQ;
    } else if (state === S.ATTR_NAME) holes.push({ type: 'attrname', prefix: attr });
    else holes.push({ type: 'tag' });
    // A hole occupies part of a value, so later text in the same value is not at its start.
    valueStart = false;
  }
  cached = holes;
  contextCache.set(strings, cached);
  return cached;
}

// ---- Serialisers per context -----------------------------------------------

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'cite', 'data', 'background', 'srcset', 'ping']);
const UNSAFE_URL = /^(?:javascript|vbscript|data(?!:image\/(?:png|gif|jpe?g|webp|avif);))\s*:/i;
const ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

function sanitizeUrl(value) {
  // Browsers ignore control characters and whitespace inside the scheme, so strip them before checking.
  const probe = String(value).replace(/[\u0000- \u007f-\u009f]/g, '');
  return UNSAFE_URL.test(probe) ? 'about:invalid#blocked' : value;
}

function textValue(v) {
  if (v == null || v === false || v === true) return '';
  if (isSafe(v)) return String(v);
  if (Array.isArray(v)) return v.map(textValue).join('');
  return escapeHtml(v);
}

function attrString(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== false && x !== '').map(attrString).join(' ');
  return String(v);
}

function attrValue(v, hole) {
  let s = attrString(v);
  if (hole.start && URL_ATTRS.has(hole.name)) s = sanitizeUrl(s);
  return escapeHtml(s);
}

function unquotedValue(v, hole) {
  // Encode whitespace and '=' too: inside an unquoted value they would end the attribute.
  const s = attrValue(v, hole).replace(/[\s=]/g, (c) => `&#${c.charCodeAt(0)};`);
  return hole.start && s === '' ? '""' : s;
}

// ARIA states and enumerated attributes need the literal "true"/"false": an empty
// aria-pressed is not "pressed", and a missing one is not a toggle button at all.
const ENUMERATED = /^(?:aria-(?:pressed|expanded|checked|selected|hidden|disabled|busy|invalid|current|modal|readonly|required|atomic|multiline|multiselectable)|spellcheck|draggable|contenteditable)$/i;

function attrMap(obj) {
  const out = [];
  for (const [name, value] of Object.entries(obj)) {
    if (value == null) continue;
    if (!ATTR_NAME_RE.test(name) || /^on/i.test(name)) {
      console.warn('[html] dropped unsafe attribute name:', name);
      continue;
    }
    if (typeof value === 'boolean' && ENUMERATED.test(name)) { out.push(`${name}="${value}"`); continue; }
    if (value === false) continue;
    if (value === true) { out.push(name); continue; }
    out.push(`${name}="${attrValue(value, { name: name.toLowerCase(), start: true })}"`);
  }
  return out.join(' ');
}

function tagValue(v) {
  if (v == null || v === false || v === true || v === '') return '';
  if (isSafe(v)) return String(v);
  if (Array.isArray(v)) return v.map(tagValue).filter(Boolean).join(' ');
  if (typeof v === 'object') return attrMap(v);
  const s = String(v).trim();
  // A bare boolean attribute name such as 'disabled' is allowed; anything else could inject attributes.
  if (ATTR_NAME_RE.test(s) && !/^on/i.test(s)) return s;
  console.warn('[html] dropped a string in attribute position:', s);
  return '';
}

function serialize(v, hole) {
  switch (hole.type) {
    case 'text': return textValue(v);
    case 'attr': return attrValue(v, hole);
    case 'unquoted': return unquotedValue(v, hole);
    case 'tag': return tagValue(v);
    case 'attrname': {
      const s = v == null ? '' : String(v);
      // The finished name must not become an event handler (o${'nclick'}).
      return /^[-a-zA-Z0-9_:.]*$/.test(s) && !/^on/i.test(hole.prefix + s) ? s : '';
    }
    case 'comment': return escapeHtml(textValue(v)).replace(/--/g, '- -');
    default: return '';
  }
}

/**
 * Escape-by-default HTML template.
 *   html`<p title="${t}">${text}</p>`  → both interpolations escaped
 *   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` → nested results kept
 *   html`<button ${{ disabled: busy, 'aria-pressed': on }}>` → attribute map
 *     (null/undefined skip; true/false toggle boolean attributes, but ARIA
 *      states such as aria-pressed get "true"/"false")
 *   ${cond && html`…`} renders nothing when cond is false.
 */
export function html(strings, ...values) {
  const holes = analyze(strings);
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += serialize(values[i], holes[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

/** Replace an element's content. Plain strings are treated as text, never as markup. */
export function render(el, tpl) {
  if (!el) return el;
  el.innerHTML = isSafe(tpl) ? String(tpl) : escapeHtml(tpl ?? '');
  return el;
}

/** Parse a template into a DocumentFragment. */
export function fragment(tpl) {
  const t = document.createElement('template');
  t.innerHTML = isSafe(tpl) ? String(tpl) : escapeHtml(tpl ?? '');
  return t.content;
}

/** Parse a template and return its first element. */
export function toElement(tpl) {
  return fragment(tpl).firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Delegated listener: handler(event, matchedEl) runs when the event target is
 * inside an element matching `selector` within `root`. Returns an off() function.
 * Use focusin/focusout rather than focus/blur (they do not bubble).
 */
export function on(root, type, selector, handler, options) {
  const listener = (e) => {
    const t = e.target;
    const start = t && t.nodeType === 1 ? t : t && t.parentElement;
    const match = start && start.closest ? start.closest(selector) : null;
    if (!match) return;
    if (root !== window && root !== match && !root.contains(match)) return;
    handler(e, match);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

let uidCounter = 0;
export function uid(prefix = 'uid') {
  uidCounter += 1;
  return `${prefix}-${uidCounter.toString(36)}`;
}

export function debounce(fn, ms) {
  let timer = null;
  let lastArgs = null;
  const run = () => { timer = null; const a = lastArgs; lastArgs = null; fn(...a); };
  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.cancel = () => { clearTimeout(timer); timer = null; lastArgs = null; };
  debounced.flush = () => { if (timer) { clearTimeout(timer); run(); } };
  return debounced;
}

// ---- Focus-preserving re-render ---------------------------------------------

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

export function isFocusable(el) {
  if (!el || el.nodeType !== 1 || !el.matches(FOCUSABLE)) return false;
  if (el.disabled) return false;
  if (el.closest('[hidden], [inert]')) return false;
  return true;
}

function focusablesIn(el) {
  return Array.from(el.querySelectorAll(FOCUSABLE)).filter(isFocusable);
}

function keyedIn(root) {
  return Array.from(root.querySelectorAll('[data-key]'));
}

function describeInner(keyed, active) {
  if (keyed === active) return null;
  for (const a of ['data-action', 'name', 'id']) {
    const v = active.getAttribute(a);
    if (v) return { attr: a, value: v };
  }
  return { index: focusablesIn(keyed).indexOf(active) };
}

function resolveInner(keyed, inner) {
  if (inner && inner.attr) {
    const match = Array.from(keyed.querySelectorAll(`[${inner.attr}]`)).find((n) => n.getAttribute(inner.attr) === inner.value);
    if (isFocusable(match)) return match;
  }
  if (inner && inner.index >= 0) {
    const list = focusablesIn(keyed);
    if (list[inner.index]) return list[inner.index];
  }
  if (isFocusable(keyed)) return keyed;
  return focusablesIn(keyed)[0] || null;
}

function headingFor(root) {
  const scope = root.closest ? root.closest('section, main') || root : root;
  return root.querySelector('h1, h2, h3') || (scope !== root && scope.querySelector('h1, h2, h3')) || null;
}

function focusEl(el) {
  if (!el) return;
  if (/^H[1-6]$/.test(el.tagName) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

function snapshotFocus(root) {
  const active = document.activeElement;
  if (!active || active === document.body || active === root || !root.contains(active)) return null;
  const keyed = active.closest('[data-key]');
  const key = keyed && root.contains(keyed) ? keyed : null;
  const snap = {
    key: key ? key.dataset.key : null,
    keyIndex: key ? keyedIn(root).indexOf(key) : -1,
    inner: key ? describeInner(key, active) : null,
    index: focusablesIn(root).indexOf(active),
    selection: null,
  };
  if (typeof active.selectionStart === 'number') {
    try { snap.selection = [active.selectionStart, active.selectionEnd]; } catch { /* not a text input */ }
  }
  return snap;
}

function restoreFocus(root, snap) {
  let target = null;
  if (snap.key != null) {
    const keyed = keyedIn(root);
    const same = keyed.find((el) => el.dataset.key === snap.key);
    if (same) target = resolveInner(same, snap.inner);
    else if (keyed.length && snap.keyIndex >= 0) {
      // The row is gone (deleted or filtered out): focus the one that took its place.
      target = resolveInner(keyed[Math.min(snap.keyIndex, keyed.length - 1)], snap.inner);
    }
  } else if (snap.index >= 0) {
    const list = focusablesIn(root);
    if (list.length) target = list[Math.min(snap.index, list.length - 1)];
  }
  if (!target) target = headingFor(root);
  focusEl(target);
  if (target && snap.selection && typeof target.setSelectionRange === 'function') {
    try { target.setSelectionRange(snap.selection[0], snap.selection[1]); } catch { /* not a text input */ }
  }
}

/**
 * Run fn (which re-renders part of root) and put focus back where it was:
 * same data-key element (and the same control inside it), else the element at
 * the same index, else the nearest heading. Returns fn's result (awaited if async).
 */
export function rerender(root, fn) {
  const snap = root ? snapshotFocus(root) : null;
  const result = fn();
  // Only step in when the re-render actually dropped focus; a targeted update
  // (or fn moving focus on purpose) is left alone.
  const finish = () => {
    const now = document.activeElement;
    if (snap && (!now || now === document.body || !now.isConnected)) restoreFocus(root, snap);
  };
  if (result && typeof result.then === 'function') return result.then((v) => { finish(); return v; });
  finish();
  return result;
}
