// Dictionary of words and lines seen in games, with translations.

import { load, save } from './localStorage.js';
import { translate } from './translate.js';

const KEY = 'dict';
const MAX = 4000;

export function entries() { return load(KEY, []); }

function persist(list) { save(KEY, list); }

function entryKey(text, lang) {
  return (lang || '') + '|' + (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeTerm(term) {
  return (term || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
}

// kind: 'line' | 'word'
export function addEntry(kind, text, translation, lang, tgt) {
  const clean = kind === 'word' ? normalizeTerm(text) : (text || '').trim();
  if (!clean) return null;
  const key = entryKey(clean, lang);
  const list = entries();
  let e = list.find((x) => x.key === key);
  if (!e) {
    e = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      key, kind, text: clean,
      translation: translation || '',
      lang, tgt,
      count: 0, firstSeen: Date.now(), lastSeen: Date.now(),
      pending: !translation
    };
    list.unshift(e);
  } else {
    if (translation && (!e.translation || translation.length > e.translation.length)) {
      e.translation = translation;
      e.pending = false;
    }
    e.lastSeen = Date.now();
    e.count++;
  }
  if (!e.count) e.count = 1;
  persist(list.slice(0, MAX));
  return e;
}

export const addLine = (text, translation, lang, tgt) => addEntry('line', text, translation, lang, tgt);
export const addWord = (term, lang, tgt, translation) => addEntry('word', term, translation || '', lang, tgt);

// Translate on demand (uses cache); records/updates the dictionary entry.
export async function lookup(term, lang, tgt) {
  const clean = normalizeTerm(term);
  if (!clean) return null;
  const key = entryKey(clean, lang);
  const existing = entries().find((x) => x.key === key);
  if (existing && existing.translation && !existing.pending) return existing;
  const tr = await translate(clean, lang, tgt);
  return addWord(clean, lang, tgt, tr);
}

// Seed pending word entries from a translated line (content words only).
export function seedWordsFromLine(text, lang, tgt, minLen = 3) {
  const words = (text || '').split(/\s+/)
    .map(normalizeTerm)
    .filter((w) => w.length >= (minLen || 3) && /^[\p{L}][\p{L}\p{N}'-]*$/u.test(w));
  const seen = new Set();
  for (const w of words) {
    const k = entryKey(w, lang);
    if (seen.has(k)) continue;
    seen.add(k);
    const list = entries();
    if (!list.some((x) => x.key === k)) {
      addEntry('word', w, '', lang, tgt);
    } else {
      const e = list.find((x) => x.key === k);
      e.count++;
      e.lastSeen = Date.now();
      persist(list);
    }
  }
}

export function removeEntry(id) {
  persist(entries().filter((e) => e.id !== id));
}

export function setTranslation(id, translation) {
  const list = entries().map((e) => e.id === id ? { ...e, translation, pending: false } : e);
  persist(list);
}

export function search(q, kind = 'all') {
  const needle = (q || '').toLowerCase().trim();
  return entries().filter((e) => {
    if (kind !== 'all' && e.kind !== kind) return false;
    if (!needle) return true;
    return e.text.toLowerCase().includes(needle) || (e.translation || '').toLowerCase().includes(needle);
  });
}

export function stats() {
  const list = entries();
  return {
    total: list.length,
    words: list.filter((e) => e.kind === 'word').length,
    lines: list.filter((e) => e.kind === 'line').length,
    translated: list.filter((e) => e.translation).length
  };
}

export function clearAll() {
  persist([]);
}
