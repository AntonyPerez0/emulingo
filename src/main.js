// Boot: styles and theme first (no flash), then data, then the router.
// Views load lazily, and a failing data layer or view shows an accessible
// error panel (or that view's error state) instead of a blank page.
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import { initTheme } from './ui/theme.js';
import { html, render } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { initA11y, registerShortcut } from './ui/a11y.js';
import { initComponents } from './ui/components.js';
import { initRouter, onViewChange, setNavBadge, parseHash } from './ui/router.js';
import { initLangChip } from './ui/langdialog.js';
import * as db from './core/db.js';

const VIEWS = [
  { id: 'play', title: 'Play', load: () => import('./ui/views/play/index.js') },
  { id: 'review', title: 'Review', load: () => import('./ui/views/review.js') },
  { id: 'dictionary', title: 'Dictionary', load: () => import('./ui/views/dictionary.js') },
  { id: 'deck', title: 'Deck', load: () => import('./ui/views/deck.js') },
  { id: 'settings', title: 'Settings', load: () => import('./ui/views/settings.js') },
];

/** Fill the static shell's icon placeholders (<span data-icon="name">). */
function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    render(el, icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 20 }));
  }
}

function showBootError(err) {
  console.error('[emulingo] boot failed', err);
  const main = document.getElementById('main');
  if (!main) return;
  for (const s of main.querySelectorAll('section[data-view]')) s.hidden = true;
  const boot = document.getElementById('boot');
  if (boot) boot.remove();
  const detail = err && (err.message || String(err));
  const panel = document.createElement('div');
  panel.className = 'boot-error';
  render(panel, html`<div class="card stack-4" role="alert">
    <div class="empty-state__icon empty-state__icon--danger" aria-hidden="true">${icon('alert-triangle', { size: 28 })}</div>
    <h1 tabindex="-1">Emulingo couldn’t start</h1>
    <p class="text-muted">Something went wrong while opening your saved data. Reloading usually fixes it. If it keeps happening, your browser may be blocking site storage — for example in a private window.</p>
    ${detail ? html`<details class="disclosure"><summary>Technical details</summary><pre class="text-sm text-muted">${detail}</pre></details>` : ''}
    <div class="cluster"><button type="button" class="btn btn--primary" data-boot-reload>${icon('refresh-cw', { size: 18 })}<span>Reload</span></button></div>
  </div>`);
  main.prepend(panel);
  panel.querySelector('[data-boot-reload]').addEventListener('click', () => location.reload());
}

// ---- Global error handling ----------------------------------------------------

const ERROR_TOAST_GAP_MS = 30000;

function isOwnScript(filename) {
  if (!filename) return true;
  // EmulatorJS runs its cores from blob: URLs, which report our origin.
  if (filename.startsWith('blob:')) return false;
  try { return new URL(filename, location.href).origin === location.origin; } catch { return false; }
}

function installErrorHandlers() {
  let lastToastAt = 0;
  const report = (err, source) => {
    console.error(`[emulingo] ${source}`, err);
    const now = Date.now();
    if (now - lastToastAt < ERROR_TOAST_GAP_MS) return;
    lastToastAt = now;
    toast('Something went wrong. If the app stops responding, reload the page.', {
      kind: 'error',
      action: { label: 'Reload', onClick: () => location.reload() },
    });
  };
  window.addEventListener('error', (e) => {
    // Opaque cross-origin errors and EmulatorJS's own scripts are handled by the Play view.
    if (!e.error && /^Script error\.?$/.test(e.message || '')) return;
    if (!isOwnScript(e.filename)) {
      console.warn('[emulingo] third-party script error', e.message);
      return;
    }
    report(e.error || e.message, 'uncaught error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r && r.name === 'AbortError') return;
    // Listeners added later (the emulator's wake-lock guard) may still handle
    // it: Chromium runs window listeners in registration order, capture or not.
    setTimeout(() => { if (!e.defaultPrevented) report(r, 'unhandled rejection'); }, 0);
  });
  // A new deploy removed a lazily loaded chunk: reload once to pick up the new build.
  window.addEventListener('vite:preloadError', (e) => {
    const key = 'emulingo:preload-reload';
    let last = 0;
    try { last = Number(sessionStorage.getItem(key) || 0); } catch { /* storage blocked */ }
    if (Date.now() - last < 30000) return;
    try { sessionStorage.setItem(key, String(Date.now())); } catch { /* storage blocked */ }
    e.preventDefault();
    location.reload();
  });
}

// Storage problems stay on screen until dismissed or resolved; the data layer
// supplies ready-to-show copy ({ kind, message }).
function watchStorage() {
  let current = null;
  db.onStorageError((info) => {
    if (current) current.dismiss();
    const message = (info && info.message) || 'Your latest changes couldn’t be saved.';
    const kind = info && (info.kind === 'unavailable' || info.kind === 'blocked') ? 'warning' : 'error';
    current = toast(message, { kind, timeout: 0 });
  });
  if (typeof db.onStorageRecovered === 'function') {
    db.onStorageRecovered((info) => {
      if (current) { current.dismiss(); current = null; }
      toast((info && info.message) || 'Your changes are being saved again.', { kind: 'success' });
    });
  }
}

// ---- Speech: one place to stop it (DESIGN 5b) -------------------------------------

function initSpeech() {
  let tts = null;
  import('./core/tts.js')
    .then((mod) => { tts = mod; if (tts.init) tts.init(); })
    .catch((err) => console.warn('[emulingo] speech unavailable', err));
  // Leaving a view silences it; registered before the router so it runs before
  // the next view shows. Param-only changes (#/deck?q=…) and in-page anchors don't.
  let viewId = (parseHash(location.hash) || {}).id;
  window.addEventListener('hashchange', () => {
    const next = parseHash(location.hash);
    if (!next || next.id === viewId) return;
    viewId = next.id;
    try { if (tts) tts.stop(); } catch { /* ignore */ }
  });
  registerShortcut({
    key: 'Escape',
    label: 'Stop speaking',
    scope: 'global',
    handler: () => {
      if (!tts || !tts.speaking || !tts.speaking()) return false;
      tts.stop();
      return true;
    },
  });
}

// ---- Due-card badge on Review ---------------------------------------------------

async function initDueBadge() {
  let srs;
  try { srs = await import('./core/srs.js'); } catch (err) { console.warn('[emulingo] due count unavailable', err); return; }
  const refresh = () => {
    try { setNavBadge('review', srs.dueCount()); } catch { /* data not ready */ }
  };
  refresh();
  onViewChange(refresh);
  window.addEventListener('emulingo:cards-changed', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  // Cards fall due over time even when nothing else happens.
  setInterval(refresh, 60 * 1000);
}

// ---- Service worker (production only) ---------------------------------------------

// The update reload saves a running game first, like Eject: page unload
// alone can cut the battery-save and autosave writes short.
async function saveRunningGame() {
  try {
    const emu = await import('./core/emulator.js');
    if (!emu.isStarted()) return;
    await Promise.race([
      Promise.allSettled([emu.flushSaves(), emu.autoSave()]),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
  } catch { /* no game */ }
}

function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const start = async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register('./sw.js');
    } catch (err) {
      console.warn('[emulingo] service worker registration failed', err);
      return;
    }
    // (some embedded browsers and test harnesses stub register() out)
    if (!reg) return;
    let updateRequested = false;
    const promptUpdate = (worker) => {
      toast('An update is available.', {
        kind: 'info',
        timeout: 0,
        action: {
          label: 'Reload',
          onClick: async () => {
            updateRequested = true;
            try { await db.flush(); } catch { /* best effort */ }
            await saveRunningGame();
            worker.postMessage({ type: 'SKIP_WAITING' });
          },
        },
      });
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateRequested) location.reload();
    });
    if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(worker);
      });
    });
    // Look for a new build when the app comes back to the foreground (at most hourly).
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || Date.now() - lastCheck < 60 * 60 * 1000) return;
      lastCheck = Date.now();
      reg.update().catch(() => {});
    });
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

// ---- Boot ---------------------------------------------------------------------

async function boot() {
  installErrorHandlers();
  hydrateIcons();
  initTheme();
  initA11y();
  initComponents();
  // Settings live in localStorage, so the language chip works even if IndexedDB doesn't.
  initLangChip();

  watchStorage();
  try {
    await db.initDb();
  } catch (err) {
    showBootError(err);
    return;
  }

  initSpeech();
  const boot = document.getElementById('boot');
  if (boot) boot.remove();
  await initRouter(VIEWS, { defaultView: 'play' });
  initDueBadge();
  registerServiceWorker();
}

boot().catch(showBootError);
