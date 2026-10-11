// Theme: 'system' follows prefers-color-scheme; 'dark'/'light' force a palette.
// The resolved theme lands on <html data-theme>, which tokens.css keys off, and
// the theme-color metas are kept in sync with the page background.
import { store } from '../core/store.js';

const THEME_COLORS = { dark: '#0b0f17', light: '#f6f7fb' };
const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;
let initialised = false;

function preference() {
  let pref = 'system';
  try { pref = store.get('theme') || 'system'; } catch { /* store unavailable: follow the system */ }
  return pref === 'dark' || pref === 'light' ? pref : 'system';
}

/** 'dark' | 'light' for a preference ('system' resolves through the media query). */
export function resolveTheme(pref = preference()) {
  if (pref === 'dark' || pref === 'light') return pref;
  return media && media.matches ? 'light' : 'dark';
}

function syncMetaColors(pref, resolved) {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (!meta.dataset.media) meta.dataset.media = meta.getAttribute('media') || '';
    if (pref === 'system') {
      // Hand control back to the media-scoped metas.
      const m = meta.dataset.media;
      if (m) meta.setAttribute('media', m);
      meta.setAttribute('content', /light/.test(m) ? THEME_COLORS.light : THEME_COLORS.dark);
    } else {
      meta.removeAttribute('media');
      meta.setAttribute('content', THEME_COLORS[resolved]);
    }
  }
}

/** Apply a preference now (defaults to the stored one). Returns the resolved theme. */
export function applyTheme(pref = preference()) {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
  syncMetaColors(pref, resolved);
  return resolved;
}

/** Apply the stored theme and keep it in sync with Settings and the OS. */
export function initTheme() {
  const resolved = applyTheme();
  if (initialised) return resolved;
  initialised = true;
  try {
    store.subscribe((key) => { if (key === 'theme') applyTheme(); });
  } catch { /* no store: system theme only */ }
  if (media) {
    const onChange = () => { if (preference() === 'system') applyTheme('system'); };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    else if (typeof media.addListener === 'function') media.addListener(onChange);
  }
  return resolved;
}
