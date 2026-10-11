// Toasts are a visual layer only: every message is also spoken through
// announce(). Errors stay until dismissed, other kinds last ≥ 5 s and pause
// while hovered or focused. At most three are visible; repeats are merged.
import { html, toElement, isFocusable } from './dom.js';
import { icon } from './icons.js';
import { announce, focusHeading } from './a11y.js';

const MAX_VISIBLE = 3;
const MIN_MS = 5000;
const ACTION_MIN_MS = 10000;
const DEFAULT_MS = { info: 6000, success: 5000, warning: 8000, error: 0 };
const ICONS = { info: 'info', success: 'check-circle', warning: 'alert-triangle', error: 'alert-circle' };
const PREFIX = { warning: 'Warning: ', error: 'Error: ' };
const LEAVE_MS = 200;

const live = [];
let visibilityBound = false;

function getRegion() {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('section');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(region);
  }
  return region;
}

function startTimer(t) {
  clearTimeout(t.timer);
  t.timer = 0;
  if (t.duration <= 0 || t.paused || t.leaving) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  t.startedAt = Date.now();
  t.timer = setTimeout(() => remove(t), t.remaining);
}

function pauseTimer(t) {
  if (!t.timer) return;
  clearTimeout(t.timer);
  t.timer = 0;
  t.remaining = Math.max(1000, t.remaining - (Date.now() - t.startedAt));
}

function remove(t) {
  if (t.leaving) return;
  t.leaving = true;
  clearTimeout(t.timer);
  const idx = live.indexOf(t);
  if (idx >= 0) live.splice(idx, 1);
  const hadFocus = t.el.contains(document.activeElement);
  t.el.setAttribute('data-leaving', '');
  setTimeout(() => t.el.remove(), LEAVE_MS);
  if (hadFocus) {
    // Don't strand keyboard focus on a toast that is going away: the next
    // toast, else where focus came from, else the view heading.
    const next = live.length ? live[live.length - 1].el.querySelector('button') : null;
    const back = t.cameFrom && t.cameFrom.isConnected && isFocusable(t.cameFrom) && !t.cameFrom.closest('#toast-region') ? t.cameFrom : null;
    if (next) next.focus();
    else if (back) back.focus();
    else focusHeading();
  }
}

function enforceLimit() {
  while (live.length > MAX_VISIBLE) {
    // Drop the oldest non-error first; errors need an explicit dismissal.
    const victim = live.find((t) => t.kind !== 'error') || live[0];
    remove(victim);
  }
}

function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  // Timers stop while the tab is hidden so messages aren't missed.
  document.addEventListener('visibilitychange', () => {
    for (const t of live) {
      if (document.hidden) pauseTimer(t);
      else startTimer(t);
    }
  });
}

function durationFor(kind, timeout, hasAction) {
  if (kind === 'error') return 0;
  if (timeout === 0) return 0;
  const base = typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_MS[kind];
  return Math.max(base, hasAction ? ACTION_MIN_MS : MIN_MS);
}

/**
 * toast(message, { kind:'info'|'success'|'warning'|'error', action:{ label, onClick }, timeout }) → { dismiss() }
 * timeout 0 keeps the toast until dismissed; errors always persist.
 */
export function toast(message, { kind = 'info', action = null, timeout } = {}) {
  const text = String(message ?? '').trim();
  if (!text) return { dismiss() {}, el: null };
  if (!ICONS[kind]) kind = 'info';
  bindVisibility();

  const spoken = action && action.label ? `${text} ${action.label} available.` : text;
  announce(spoken, { assertive: kind === 'error' });

  const key = `${kind}|${text}|${action ? action.label : ''}`;
  const existing = live.find((t) => t.key === key && !t.leaving);
  if (existing) {
    // Same message again: refresh it instead of stacking a copy.
    existing.action = action;
    existing.remaining = existing.duration;
    live.splice(live.indexOf(existing), 1);
    live.push(existing);
    // Moving a node blurs it, so leave a toast that holds keyboard focus where it is.
    const region = getRegion();
    if (region.lastElementChild !== existing.el && !existing.el.contains(document.activeElement)) region.appendChild(existing.el);
    startTimer(existing);
    return existing.handle;
  }

  const el = toElement(html`<div class="toast toast--${kind}" data-kind="${kind}">
    <span class="toast__icon">${icon(ICONS[kind])}</span>
    <p class="toast__message">${PREFIX[kind] ? html`<span class="visually-hidden">${PREFIX[kind]}</span>` : ''}${text}</p>
    <div class="toast__actions">
      ${action && action.label ? html`<button type="button" class="btn btn--sm btn--ghost toast__action">${action.label}</button>` : ''}
      <button type="button" class="icon-btn icon-btn--sm toast__close" aria-label="Dismiss notification">${icon('x', { size: 16 })}</button>
    </div>
  </div>`);

  const duration = durationFor(kind, timeout, !!action);
  const t = { el, key, kind, action, duration, remaining: duration, timer: 0, startedAt: 0, paused: false, hovered: false, focused: false, leaving: false, cameFrom: null };
  t.handle = { dismiss: () => remove(t), el };

  const syncPause = () => {
    const shouldPause = t.hovered || t.focused;
    if (shouldPause && !t.paused) { t.paused = true; pauseTimer(t); }
    else if (!shouldPause && t.paused) { t.paused = false; startTimer(t); }
  };
  el.addEventListener('mouseenter', () => { t.hovered = true; syncPause(); });
  el.addEventListener('mouseleave', () => { t.hovered = false; syncPause(); });
  el.addEventListener('focusin', (e) => {
    if (e.relatedTarget && !el.contains(e.relatedTarget)) t.cameFrom = e.relatedTarget;
    t.focused = true;
    syncPause();
  });
  el.addEventListener('focusout', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    t.focused = false;
    syncPause();
  });

  el.querySelector('.toast__close').addEventListener('click', () => remove(t));
  const actionBtn = el.querySelector('.toast__action');
  if (actionBtn) {
    actionBtn.addEventListener('click', async () => {
      remove(t);
      try {
        // onClick per the pinned API; fn is accepted as an alias (DESIGN §5 wording).
        const run = t.action && (t.action.onClick || t.action.fn);
        if (typeof run === 'function') await run();
      } catch (err) {
        console.error(err);
      }
    });
  }

  live.push(t);
  getRegion().appendChild(el);
  enforceLimit();
  startTimer(t);
  return t.handle;
}

/** Remove every toast (used by tests and full resets). */
export function dismissAllToasts() {
  for (const t of [...live]) remove(t);
}
