// Hash router for the five app views (#/play, #/review, #/dictionary, #/deck,
// #/settings). Views are hidden, never unmounted, so the running game and OCR
// state survive navigation. Back/Forward work through the browser history.
import { html, render } from './dom.js';
import { icon } from './icons.js';
import { focusHeading } from './a11y.js';
import { toast } from './toast.js';

const APP_NAME = 'Emulingo';
const entries = new Map();
const listeners = new Set();
let current = null;
let defaultId = 'play';
let navToken = 0;
let started = false;

/** '#/deck?q=hallo' → { id: 'deck', params: { q: 'hallo' } } (null for non-route hashes). */
export function parseHash(hash) {
  const m = /^#\/([\w-]+)\/?(?:\?(.*))?$/.exec(hash || '');
  if (!m) return null;
  return { id: m[1], params: Object.fromEntries(new URLSearchParams(m[2] || '')) };
}

export function buildHash(id, params) {
  // Unset params are left out rather than written as 'undefined' or 'null'.
  const kept = Object.entries(params || {}).filter(([, v]) => v != null && v !== '');
  const query = kept.length ? `?${new URLSearchParams(kept.map(([k, v]) => [k, String(v)]))}` : '';
  return `#/${id}${query}`;
}

function navLabel(id) {
  const el = document.querySelector(`[data-nav="${id}"] .app-nav__label`);
  return el ? el.textContent.trim() : '';
}

function toEntry(item) {
  if (!item) return null;
  const view = item.default && typeof item.default === 'object' ? item.default : item;
  const loader = typeof view.load === 'function' && typeof view.mount !== 'function' ? view.load : null;
  const id = view.id;
  if (!id) throw new TypeError('Each view needs an id');
  return {
    id,
    title: view.title || navLabel(id) || id.charAt(0).toUpperCase() + id.slice(1),
    view: loader ? null : view,
    loader,
    mounted: false,
    mounting: null,
    // body[data-view] mirrors the current view for CSS, so match the section element only
    section: document.querySelector(`section[data-view="${id}"]`),
  };
}

function updateChrome(entry) {
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.getAttribute('data-nav') === entry.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${entry.title} · ${APP_NAME}`;
  document.body.dataset.view = entry.id;
}

function renderLoading(entry) {
  render(entry.section, html`<div class="page">
    <h1 class="visually-hidden" tabindex="-1">${entry.title}</h1>
    <div class="boot"><span class="spinner-wrap" role="status"><span class="spinner spinner--lg" aria-hidden="true"></span><span>Loading…</span></span></div>
  </div>`);
}

function renderError(entry, err) {
  console.error(`[router] view "${entry.id}" failed`, err);
  render(entry.section, html`<div class="page page--narrow">
    <div class="page-header"><div class="page-header__text"><h1 tabindex="-1">${entry.title}</h1></div></div>
    <div class="banner banner--danger" role="alert">
      ${icon('alert-triangle')}
      <div class="banner__content">
        <p class="banner__title">This page couldn’t load</p>
        <p>Reloading usually fixes it. Your games, cards and settings are safe.</p>
      </div>
      <div class="banner__actions"><button type="button" class="btn btn--sm" data-router-reload>${icon('refresh-cw', { size: 16 })}<span>Reload</span></button></div>
    </div>
  </div>`);
  const btn = entry.section.querySelector('[data-router-reload]');
  if (btn) btn.addEventListener('click', () => location.reload());
}

async function ensureMounted(entry) {
  if (entry.mounted) return;
  if (!entry.mounting) {
    entry.mounting = (async () => {
      if (!entry.view) {
        renderLoading(entry);
        const mod = await entry.loader();
        entry.view = mod && mod.default ? mod.default : mod;
      }
      entry.section.replaceChildren();
      await entry.view.mount(entry.section);
      entry.mounted = true;
    })();
    entry.mounting.catch(() => { entry.mounting = null; });
  }
  await entry.mounting;
}

function emit(id, prevId, params) {
  for (const fn of listeners) {
    try { fn(id, prevId, params); } catch (err) { console.error(err); }
  }
  window.dispatchEvent(new CustomEvent('viewchange', { detail: { id, prev: prevId, params } }));
}

async function route(target, { initial = false } = {}) {
  let id = target && target.id;
  let params = (target && target.params) || {};
  if (!entries.has(id)) {
    // Unknown or empty route: show the default view without adding a history entry.
    id = defaultId;
    params = {};
    history.replaceState(history.state, '', buildHash(id));
  }
  const token = ++navToken;
  const entry = entries.get(id);
  const prev = current;
  if (prev && prev !== entry) {
    try { if (prev.view && prev.mounted && prev.view.hide) prev.view.hide(); } catch (err) { console.error(err); }
    if (prev.section) prev.section.hidden = true;
  }
  current = entry;
  entry.params = params;
  if (entry.section) entry.section.hidden = false;
  updateChrome(entry);

  try {
    await ensureMounted(entry);
  } catch (err) {
    if (token === navToken) renderError(entry, err);
  }
  if (token !== navToken) return;
  if (entry.mounted && entry.view.show) {
    try {
      await entry.view.show(params);
    } catch (err) {
      // The view is mounted (it may hold the running game): keep its DOM and report instead.
      console.error(`[router] view "${entry.id}" failed to show`, err);
      if (token === navToken) toast('Part of this page didn’t update. Reloading usually fixes it.', { kind: 'warning' });
    }
  }
  if (token !== navToken) return;
  if (!initial) {
    if (typeof window.scrollTo === 'function') {
      try { window.scrollTo(0, 0); } catch { /* jsdom */ }
    }
    focusHeading(entry.section);
  }
  emit(entry.id, prev ? prev.id : null, params);
}

// A plain fragment ('#about', or '#' from a stray link) is an in-page anchor,
// not a route: stay on the current view, put its route back in the URL and
// move to the target if it exists there.
function scrollToAnchor(hash) {
  history.replaceState(history.state, '', buildHash(current.id, current.params));
  let id = '';
  try { id = decodeURIComponent(hash.slice(1)); } catch { id = hash.slice(1); }
  const target = id ? document.getElementById(id) : null;
  if (!target || target.closest('[hidden]')) return;
  if (!target.matches('a[href], button, input, select, textarea, summary, [tabindex]')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
}

function onHashChange() {
  const parsed = parseHash(location.hash);
  if (!parsed && current) {
    scrollToAnchor(location.hash);
    return;
  }
  route(parsed);
}

/**
 * initRouter(views, { defaultView = 'play' })
 *   views: array (or object map) of view modules `{ id, title, icon, mount, show, hide }`,
 *          or lazy entries `{ id, title, load: () => import('./views/x.js') }`.
 * Shows the view named by the current hash without moving focus (first load).
 */
export function initRouter(views, { defaultView } = {}) {
  const list = Array.isArray(views) ? views : Object.values(views || {});
  for (const item of list) {
    const entry = toEntry(item);
    if (!entry.section) {
      console.warn(`[router] no <section data-view="${entry.id}"> for view`);
      continue;
    }
    entries.set(entry.id, entry);
  }
  defaultId = defaultView && entries.has(defaultView) ? defaultView : entries.keys().next().value;
  if (!started) {
    started = true;
    window.addEventListener('hashchange', onHashChange);
  }
  return route(parseHash(location.hash), { initial: true });
}

/** Navigate to a view (adds a history entry). Re-shows and refocuses if already there. */
export function navigate(id, params) {
  const hash = buildHash(id, params);
  if (location.hash === hash) return route(parseHash(hash));
  location.hash = hash;
  return undefined;
}

export function currentView() {
  return current ? current.id : null;
}

export function currentParams() {
  return current ? { ...current.params } : {};
}

/** Subscribe to view changes: fn(id, prevId, params). Returns an unsubscribe function. */
export function onViewChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Show a count on a nav item (e.g. due cards on Review). The link's accessible
 * name gains the hidden label, e.g. "Review, 3 cards due".
 */
export function setNavBadge(id, count, { label } = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const badge = document.querySelector(`[data-badge="${id}"]`);
  const sr = document.querySelector(`[data-badge-label="${id}"]`);
  if (badge) {
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
  if (sr) sr.textContent = n === 0 ? '' : `, ${label || `${n} ${n === 1 ? 'card' : 'cards'} due`}`;
}

/** Test helper: forget registered views and listeners. */
export function _resetRouter() {
  entries.clear();
  listeners.clear();
  current = null;
  navToken = 0;
  if (started) window.removeEventListener('hashchange', onHashChange);
  started = false;
}
