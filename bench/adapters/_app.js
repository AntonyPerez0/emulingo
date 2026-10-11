// Helpers copied VERBATIM from src/ui/playview.js at commit 002b2c7 (they are
// module-private there, so the bench cannot import them). The legacy
// adapters must reproduce the app's post-processing exactly.

import { applyGameLexicon } from '../legacy/correct.js';

// --- verbatim from playview.js -------------------------------------------
function cleanOcrText(raw) {
  const clean = applyGameLexicon(String(raw || ''))
    .replace(/[-_=~•·─═║╔╗╚╝╠╣╦╩╬▶»▼◄▲]{2,}/gu, ' ')
    // stray OCR artifacts hug the line edges: the bouncing dialog arrow
    // reads as ":" or "/", box borders as quote marks
    .replace(/^[\s"'`/\\|•·:]+/u, '')
    .replace(/[\s"'`/\\|]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  const letters = (clean.match(/\p{L}/gu) || []).length;
  const nonSpace = clean.replace(/\s/g, '').length;
  if (!clean || letters < 3 || letters < nonSpace * 0.35) return null;
  return clean;
}

function ocrLangFor(code) {
  const map = { en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', ru: 'rus', pl: 'pol', ja: 'jpn', ko: 'kor', zh: 'chi_sim', sv: 'swe', da: 'dan', no: 'nor', fi: 'fin', cs: 'ces', el: 'ell', tr: 'tur', hu: 'hun', ro: 'ron', uk: 'ukr' };
  return map[code] || 'eng';
}

// resolve with `fallback` if `promise` takes longer than ms (playview.js)
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
}
// --- end verbatim ----------------------------------------------------------

export { cleanOcrText, ocrLangFor, withTimeout };

// playview.js captureAndTranslate drops the whole read when the best
// region confidence is below 40 ("uncertain read")
export function appConfidenceGate(results) {
  if (!results.length) return results;
  const conf = Math.max(...results.map((r) => r.conf));
  return conf < 40 ? [] : results;
}

// small canvas with a few glyph-like strokes, used to warm engines up
export function warmupCanvas(w = 160, h = 144) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  x.fillStyle = '#000000';
  x.font = `${Math.round(h / 8)}px monospace`;
  x.fillText('OK', Math.round(w / 4), Math.round(h / 2));
  return c;
}
