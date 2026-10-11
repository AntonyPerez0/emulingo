// Accessibility plumbing: screen-reader announcements, view-heading focus,
// a scoped keyboard-shortcut registry with a help dialog, and the focus
// release that stops EmulatorJS from trapping the keyboard.
import { store } from '../core/store.js';
import { html } from './dom.js';
import { openDialog } from './dialog.js';

// ---- Announcements ----------------------------------------------------------

const DEDUPE_MS = 1500;
const CLEAR_AFTER_MS = 8000;
const FILL_DELAY_MS = 100;
let lastAnnouncement = { text: '', at: 0 };
const pending = { polite: null, assertive: null };
const clearTimers = { polite: 0, assertive: 0 };

// A modal dialog makes the rest of the page inert, and screen readers ignore
// live regions in inert content, so messages go to the regions dialog.js puts
// inside the topmost open dialog.
function liveRegion(kind) {
  const dialogs = document.querySelectorAll('dialog[open]');
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const r = dialogs[i].querySelector(`[data-live="${kind}"]`);
    if (r) return r;
  }
  return document.getElementById(kind === 'assertive' ? 'sr-alert' : 'sr-status');
}

/**
 * Speak a message through the shared live regions (#sr-status polite,
 * #sr-alert assertive). Identical messages within dedupeMs are dropped, and
 * messages within 100 ms of each other are spoken together. The region is
 * cleared first and refilled shortly after so screen readers re-announce
 * text that happens to equal the previous message.
 */
export function announce(msg, { assertive = false, dedupeMs = DEDUPE_MS } = {}) {
  const text = String(msg ?? '').replace(/\s+/g, ' ').trim();
  if (!text || typeof document === 'undefined') return;
  const now = Date.now();
  if (text === lastAnnouncement.text && now - lastAnnouncement.at < dedupeMs) return;
  lastAnnouncement = { text, at: now };

  const kind = assertive ? 'assertive' : 'polite';
  const first = liveRegion(kind);
  if (!first) return;

  // Messages queued before the fill are spoken together instead of overwriting each other.
  const queued = pending[kind];
  if (queued && !queued.done) {
    queued.text += ` ${text}`;
    return;
  }
  const job = { text, done: false };
  pending[kind] = job;
  clearTimeout(clearTimers[kind]);
  first.textContent = '';
  const fill = () => {
    if (job.done) return;
    job.done = true;
    // Resolved again: a dialog may have opened or closed since the call.
    const region = liveRegion(kind);
    if (!region) return;
    region.textContent = job.text;
    clearTimers[kind] = setTimeout(() => { if (region.textContent === job.text) region.textContent = ''; }, CLEAR_AFTER_MS);
  };
  // A short gap (not just a frame) so the cleared region is noticed and
  // identical text is spoken again.
  setTimeout(fill, FILL_DELAY_MS);
}

// ---- Focus helpers ----------------------------------------------------------

/** Move focus to a view's <h1> (made focusable with tabindex=-1) without scrolling past it. */
export function focusHeading(viewEl) {
  const root = viewEl
    || document.querySelector('section[data-view]:not([hidden])')
    || document.getElementById('main');
  if (!root) return null;
  const target = root.querySelector('h1') || root.querySelector('h2') || root;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  if (typeof target.getBoundingClientRect === 'function' && typeof target.scrollIntoView === 'function') {
    const r = target.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) target.scrollIntoView({ block: 'start' });
  }
  return target;
}

const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]';

function isVisible(el) {
  if (el.closest('[hidden], [inert]')) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  return el.getClientRects().length > 0;
}

/** Focusable, enabled, visible controls inside a container, in DOM order. */
export function focusableIn(container, { includeNegative = false } = {}) {
  if (!container) return [];
  const all = Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => {
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
    return isVisible(el);
  });
  if (includeNegative) return all;
  const tabbable = all.filter((el) => el.tabIndex >= 0);
  return tabbable.length ? tabbable : all;
}

// ---- Keyboard shortcuts -----------------------------------------------------

const registry = new Set();
let seq = 0;
let listening = false;

const KEY_ALIASES = { space: ' ', spacebar: ' ', esc: 'escape', del: 'delete', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', plus: '+' };
const MODIFIERS = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', meta: 'meta', cmd: 'meta' };

function normalizeKey(k) {
  const lower = String(k).toLowerCase();
  return KEY_ALIASES[lower] ?? (k.length === 1 ? k.toLowerCase() : lower);
}

function parseCombo(combo) {
  const out = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  let rest = String(combo);
  for (;;) {
    const m = /^([a-z]+)\+(.+)$/i.exec(rest);
    if (!m || !MODIFIERS[m[1].toLowerCase()]) break;
    out[MODIFIERS[m[1].toLowerCase()]] = true;
    rest = m[2];
  }
  out.key = normalizeKey(rest);
  return out;
}

function eventKey(e) {
  if (!e.key) return '';
  return normalizeKey(e.key === 'Spacebar' ? ' ' : e.key);
}

const isPrintable = (key) => key.length === 1;

function comboMatches(entry, e) {
  if (eventKey(e) !== entry.key) return false;
  if (!!e.ctrlKey !== entry.ctrl || !!e.altKey !== entry.alt || !!e.metaKey !== entry.meta) return false;
  if (entry.shift) return !!e.shiftKey;
  // Shift is part of typing symbols such as '?', so it only matters for named keys.
  return isPrintable(entry.key) || !e.shiftKey;
}

/** WCAG 2.1.4: single-character shortcuts can be switched off in Settings. */
export function shortcutsEnabled() {
  try { return store.get('shortcuts') !== false; } catch { return true; }
}

function isCharacterShortcut(entry) {
  return isPrintable(entry.key) && !entry.ctrl && !entry.alt && !entry.meta;
}

function currentScope() {
  return document.body ? document.body.dataset.view || '' : '';
}

function isEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.closest('input, select, textarea')) return true;
  if (el.isContentEditable) return true;
  return !!el.closest('[contenteditable]:not([contenteditable="false"])');
}

const ACTIVATABLE = 'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"]';

function modalOpen() {
  for (const d of document.querySelectorAll('dialog[open]')) {
    try { if (d.matches(':modal')) return true; } catch { return true; }
  }
  return false;
}

function inGame(el) {
  const game = document.getElementById('game');
  return !!(game && el && el.nodeType === 1 && game.contains(el));
}

function findShortcut(e, { gameOnly }) {
  const scope = currentScope();
  const enabled = shortcutsEnabled();
  let best = null;
  for (const entry of registry) {
    if (entry.scope !== 'global' && entry.scope !== scope) continue;
    if (gameOnly && !entry.allowInGame) continue;
    if (!enabled && isCharacterShortcut(entry)) continue;
    if (e.repeat && !entry.repeat) continue;
    if (!comboMatches(entry, e)) continue;
    // View-scoped beats global; otherwise the most recent registration wins.
    const rank = (entry.scope === 'global' ? 0 : 1e9) + entry.order;
    if (!best || rank > best.rank) best = { entry, rank };
  }
  return best ? best.entry : null;
}

function run(entry, e) {
  let result;
  try {
    result = entry.handler(e);
  } catch (err) {
    // A broken handler must not break every other key on the page.
    console.error(`[shortcuts] "${entry.combo}" failed`, err);
  }
  if (result !== false) e.preventDefault();
  return result !== false;
}

// Bubble phase on document: components that handle a key themselves call preventDefault first.
function onKeydown(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const target = e.target;
  if (inGame(target)) return;
  if (isEditable(target)) return;
  const key = eventKey(e);
  if ((key === ' ' || key === 'enter') && target && target.nodeType === 1 && target.closest(ACTIVATABLE)) return;
  if (modalOpen()) return;
  const entry = findShortcut(e, { gameOnly: false });
  if (entry) run(entry, e);
}

// Capture phase on window: EmulatorJS swallows every key inside #game, so
// shortcuts allowed in-game must run before it and stop the event.
function onGameKeydown(e) {
  if (e.isComposing || !inGame(e.target)) return;
  const entry = findShortcut(e, { gameOnly: true });
  if (entry && run(entry, e)) e.stopPropagation();
}

function ensureListeners() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('keydown', onGameKeydown, true);
}

/**
 * registerShortcut({ key, label, scope, handler, allowInGame, repeat, hidden }) → off()
 *   key: 't', '?', 'Escape', 'Space', '1', 'Shift+ArrowLeft', 'Ctrl+k' …
 *   scope: a view id ('review') or 'global'
 *   handler(event): return false to let the key through (no preventDefault)
 * Ignored while typing in fields, inside #game (unless allowInGame), while a
 * modal dialog is open, and for Enter/Space on buttons and links.
 */
export function registerShortcut({ key, label = '', scope = 'global', handler, allowInGame = false, repeat = false, hidden = false }) {
  if (!key || typeof handler !== 'function') throw new TypeError('registerShortcut needs a key and a handler');
  const entry = { ...parseCombo(key), combo: key, label, scope, handler, allowInGame, repeat, hidden, order: ++seq };
  registry.add(entry);
  ensureListeners();
  return () => registry.delete(entry);
}

/** The shortcuts currently registered (for the help dialog and tests). */
export function listShortcuts() {
  return Array.from(registry).map(({ combo, label, scope, allowInGame, hidden }) => ({ key: combo, label, scope, allowInGame, hidden }));
}

const KEY_NAMES = { ' ': 'Space', escape: 'Esc', enter: 'Enter', tab: 'Tab', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End', pageup: 'Page Up', pagedown: 'Page Down' };

/** Human-readable key names, e.g. 'Shift+ArrowLeft' → ['Shift', '←']. */
export function keyLabelParts(combo) {
  const c = parseCombo(combo);
  const parts = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.meta) parts.push('⌘');
  parts.push(KEY_NAMES[c.key] || (c.key.length === 1 ? c.key.toUpperCase() : c.key.replace(/^f(\d+)$/, 'F$1')));
  return parts;
}

function scopeTitle(scope) {
  if (scope === 'global') return 'Everywhere';
  const label = document.querySelector(`[data-nav="${scope}"] .app-nav__label`);
  return label ? label.textContent.trim() : scope.charAt(0).toUpperCase() + scope.slice(1);
}

function shortcutRows(entries) {
  return entries.map((s) => html`<div>
    <dt><span class="kbd-combo">${keyLabelParts(s.key).map((k) => html`<kbd>${k}</kbd>`)}</span></dt>
    <dd>${s.label}</dd>
  </div>`);
}

/** Open the keyboard-shortcut help dialog (also bound to '?'). */
export function showShortcutHelp() {
  const scope = currentScope();
  const visible = listShortcuts().filter((s) => !s.hidden && s.label);
  // Latest registration per key+scope, mirroring which handler would run.
  const seen = new Map();
  for (const s of visible) seen.set(`${s.scope}|${normalizeKey(s.key)}`, s);
  const unique = Array.from(seen.values());
  const groups = [scope, 'global']
    .filter((g, i, arr) => g && arr.indexOf(g) === i)
    .map((g) => ({ title: scopeTitle(g), items: unique.filter((s) => s.scope === g) }))
    .filter((g) => g.items.length);
  const off = !shortcutsEnabled();
  const content = html`
    ${off ? html`<p class="banner banner--warning"><span class="banner__content">Single-key shortcuts are turned off. You can turn them on in Settings.</span></p>` : ''}
    ${groups.length
      ? groups.map((g) => html`<section class="shortcut-group">
          <h3 class="shortcut-group__title">${g.title}</h3>
          <dl class="shortcut-list">${shortcutRows(g.items)}</dl>
        </section>`)
      : html`<p class="dialog__text">There are no shortcuts on this page.</p>`}
    <p class="dialog__text text-sm">Shortcuts don’t apply while you’re typing in a field. While the game has focus, press <kbd>Esc</kbd> or <kbd>Tab</kbd> to return to the app.</p>`;
  return openDialog({ title: 'Keyboard shortcuts', content, actions: [{ label: 'Close', kind: 'primary' }] });
}

let helpOff = null;

/** Install global keyboard behaviour: the '?' help shortcut and the skip link. Idempotent. */
export function initA11y() {
  ensureListeners();
  if (!helpOff) helpOff = registerShortcut({ key: '?', label: 'Show keyboard shortcuts', scope: 'global', handler: () => { showShortcutHelp(); } });
  const skip = document.querySelector('.skip-link');
  if (skip && !skip.dataset.bound) {
    skip.dataset.bound = '1';
    // Focus the current view's heading without changing the hash route.
    skip.addEventListener('click', (e) => {
      e.preventDefault();
      focusHeading();
    });
  }
}

// ---- EmulatorJS focus release (DESIGN 5b) -----------------------------------

const PASS_THROUGH_KEYS = new Set(['Enter', ' ', 'Spacebar', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const EJS_POPUPS = '.ejs_popup_container, .ejs_settings_parent, .ejs_context_menu, .ejs_cheat_parent';

function ejsPopupOpen(gameEl) {
  return Array.from(gameEl.querySelectorAll(EJS_POPUPS)).some((el) => !el.hidden && el.style.display !== 'none' && isVisible(el));
}

/**
 * EmulatorJS focuses #game and calls preventDefault on every key, which traps
 * keyboard users. This capture-phase handler runs first:
 *  - Tab / Shift+Tab inside #game → the toolbar's first / last control
 *    (skipping EmulatorJS's hidden in-frame buttons)
 *  - Escape → onEscape() (default: first toolbar control), unless an
 *    EmulatorJS popup is open
 *  - Enter, Space and arrows on EmulatorJS's own controls reach them natively
 *  - Tabbing into #game from outside lands on #game itself, not its buttons
 * Returns an uninstall function.
 */
export function installEmulatorFocusRelease({ gameEl, toolbarEl, onEscape } = {}) {
  if (!gameEl) throw new TypeError('installEmulatorFocusRelease needs gameEl');
  let lastTabAt = 0;

  const toToolbar = (last) => {
    const list = focusableIn(toolbarEl);
    const el = last ? list[list.length - 1] : list[0];
    if (el) el.focus();
    return !!el;
  };

  const onKey = (e) => {
    if (e.type === 'keydown' && e.key === 'Tab') lastTabAt = Date.now();
    const t = e.target;
    if (!t || t.nodeType !== 1 || !gameEl.contains(t)) return;

    if (e.key === 'Tab') {
      e.stopPropagation();
      if (e.type === 'keydown' && toToolbar(e.shiftKey)) e.preventDefault();
      return;
    }
    if (e.key === 'Escape' || e.key === 'Esc') {
      if (ejsPopupOpen(gameEl)) return;
      e.stopPropagation();
      if (e.type !== 'keydown') return;
      e.preventDefault();
      if (typeof onEscape === 'function') onEscape(e);
      else toToolbar(false);
      return;
    }
    // EmulatorJS's own buttons and sliders: keep the event away from its key handler so native activation works.
    if (t !== gameEl && PASS_THROUGH_KEYS.has(e.key) && t.matches('button, input, select, a[href], [role="button"], [role="slider"]')) {
      e.stopPropagation();
    }
  };

  // Keyboard focus that lands on one of EmulatorJS's (mostly invisible) controls
  // from outside the game goes to the game screen itself instead.
  const onFocusIn = (e) => {
    const t = e.target;
    if (!t || t === gameEl || !gameEl.contains(t)) return;
    const from = e.relatedTarget;
    if (from && gameEl.contains(from)) return;
    if (Date.now() - lastTabAt > 300) return;
    if (gameEl.tabIndex >= 0) gameEl.focus();
    else toToolbar(false);
  };

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);
  document.addEventListener('focusin', onFocusIn, true);
  return () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKey, true);
    document.removeEventListener('focusin', onFocusIn, true);
  };
}
