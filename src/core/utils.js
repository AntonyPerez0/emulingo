import { getTranslateCache } from './translate.js';

export const PIXEL_DOG = `
     / \\__
    (    @\\___
    /         O
   /   (_____/
  /_____/   U`;

export function normalize(s) {
  return (s || '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function words(s) {
  return normalize(s).split(' ').filter(Boolean);
}

export function sentenceKey(s) {
  return normalize(s).slice(0, 120);
}

export function lineEquals(a, b) {
  return normalize(a) === normalize(b) && normalize(a).length > 0;
}

export function detectDirection(lang) {
  return ['ar', 'he', 'fa', 'ur'].includes((lang || '').slice(0, 2)) ? 'rtl' : 'ltr';
}

export function translationKey(src, tgt, text) {
  return src + '>' + tgt + '|' + normalize(text).slice(0, 140);
}

export function addToCache(key, payload) {
  const cache = getTranslateCache();
  if (cache[key]) return;
  cache[key] = payload;
  // cap cache size
  const keys = Object.keys(cache);
  if (keys.length > 600) {
    for (const k of keys.slice(0, 150)) delete cache[k];
  }
  localStorage.setItem('emulingo:translations', JSON.stringify(cache));
}

export function getCached(key) {
  return getTranslateCache()[key] || null;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
