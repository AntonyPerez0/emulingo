// Personal dictionary of the words and lines seen in games.
// Entries keep one translation per target language, so switching the
// translation language never mixes languages. kind ('word' | 'line') is part
// of the identity, so the one-word menu line "KAMPF" and the word "Kampf" can
// coexist. Lookups and translations never inflate the "seen" count.

import { collection, onChange } from './db.js';
import { store } from './store.js';
import { isLang, usesSpaces } from './language.js';
import { translate, isEngineErrorText } from './translate.js';
import { cards as allCards, cleanText } from './srs.js';
import { normalize, newId, segmentWords, ID_RE } from './utils.js';

const MAX_ENTRIES = 5000;
const EVICT_TO = 4750;
const WORD_MAX = 80;
const LINE_MAX = 1000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Trim punctuation around a word ("Pokémon!" -> "Pokémon").
export function normalizeTerm(term) {
  return String(term ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/\s+/g, ' ').trim();
}

export const entryKey = (kind, src, text) => `${kind}|${src}|${normalize(text)}`;

function cleanTranslations(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [tgt, t] of Object.entries(raw)) {
      const text = cleanText(t, LINE_MAX);
      if (isLang(tgt) && text && !isEngineErrorText(text)) out[tgt] = text;
    }
  }
  return out;
}

// Validate an entry (v1 or v2 shape) -> clean v2 entry, or null.
export function sanitizeEntry(raw, { fallbackTgt } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  const src = isLang(raw.src) ? raw.src : isLang(raw.lang) ? raw.lang : null; // v1: lang
  const kind = raw.kind === 'word' || raw.kind === 'line' ? raw.kind : null;
  if (!src || !kind) return null;
  const text = kind === 'word' ? normalizeTerm(cleanText(raw.text, WORD_MAX)) : cleanText(raw.text, LINE_MAX);
  if (!text || !normalize(text)) return null;
  let translations = cleanTranslations(raw.translations);
  if (!raw.translations && typeof raw.translation === 'string') { // v1: one translation + tgt
    const fallback = fallbackTgt ?? store.get('target');
    const tgt = isLang(raw.tgt) ? raw.tgt : isLang(fallback) ? fallback : 'en';
    translations = cleanTranslations({ [tgt]: raw.translation });
  }
  const now = Date.now();
  const firstSeen = finite(raw.firstSeen) ? raw.firstSeen : now;
  return {
    id: raw.id,
    kind,
    text,
    src,
    translations,
    count: finite(Number(raw.count)) ? Math.min(1e6, Math.max(0, Math.round(Number(raw.count)))) : 1,
    firstSeen,
    lastSeen: finite(raw.lastSeen) ? raw.lastSeen : firstSeen,
    lookedUp: raw.lookedUp === true
  };
}

const dictCol = collection('dict', { sanitize: (r) => sanitizeEntry(r) });

// ---- index ----

let index = null;

function mergeInto(a, b) {
  return {
    ...a,
    translations: { ...b.translations, ...a.translations },
    count: Math.max(a.count, b.count),
    firstSeen: Math.min(a.firstSeen, b.firstSeen),
    lastSeen: Math.max(a.lastSeen, b.lastSeen),
    lookedUp: a.lookedUp || b.lookedUp
  };
}

function getIndex() {
  if (index) return index;
  index = new Map();
  for (const e of dictCol.all()) {
    const key = entryKey(e.kind, e.src, e.text);
    const other = index.get(key);
    if (other) { // two records for one key (old data): fold them together
      dictCol.put(mergeInto(dictCol.get(other), e));
      dictCol.delete(e.id);
    } else {
      index.set(key, e.id);
    }
  }
  return index;
}

onChange(({ collections, remote }) => {
  if (remote && collections.includes('dict')) index = null;
});

function find(kind, src, text) {
  const id = getIndex().get(entryKey(kind, src, text));
  const e = id ? dictCol.get(id) : null;
  if (id && !e) index = null;
  return e;
}

function put(e) {
  const out = dictCol.put(e);
  getIndex().set(entryKey(out.kind, out.src, out.text), out.id);
  return out;
}

// What views get: the entry plus its translation in one target language.
function view(e, tgt) {
  if (!e) return null;
  const translation = e.translations[tgt] || '';
  return { ...e, tgt, translation, pending: !translation };
}

const currentTarget = () => store.get('target');

// ---- reading ----

export function entries({ tgt = currentTarget() } = {}) {
  return dictCol.all().sort((a, b) => b.lastSeen - a.lastSeen).map((e) => view(e, tgt));
}

export function getEntry(id, tgt = currentTarget()) {
  return view(dictCol.get(id), tgt);
}

const folded = new WeakMap();
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function haystack(e) {
  let h = folded.get(e);
  if (h === undefined) {
    h = fold(e.text + '\n' + Object.values(e.translations).join('\n'));
    folded.set(e, h);
  }
  return h;
}

const SORTS = {
  recent: (a, b) => b.lastSeen - a.lastSeen,
  count: (a, b) => b.count - a.count || b.lastSeen - a.lastSeen,
  alpha: (a, b) => a.text.localeCompare(b.text)
};

// Paged search (accent- and case-insensitive, over the text and every translation).
// filter: 'all' | 'pending' | 'translated' (for tgt); sort: 'recent' | 'count' | 'alpha'.
export function search({ q = '', kind = 'all', offset = 0, limit = 100, tgt = currentTarget(), filter = 'all', sort = 'recent' } = {}) {
  const needle = fold(String(q ?? '').trim());
  const list = dictCol.all().filter((e) => {
    if (kind !== 'all' && e.kind !== kind) return false;
    if (filter === 'pending' && e.translations[tgt]) return false;
    if (filter === 'translated' && !e.translations[tgt]) return false;
    return !needle || haystack(e).includes(needle);
  });
  list.sort(SORTS[sort] || SORTS.recent);
  const start = Math.max(0, Math.floor(Number(offset)) || 0);
  // limit: Infinity (or anything non-numeric) means "the rest"; `| 0` would turn Infinity into 0
  const n = Number(limit);
  const end = Number.isFinite(n) ? start + Math.max(0, Math.floor(n)) : list.length;
  return { items: list.slice(start, end).map((e) => view(e, tgt)), total: list.length };
}

export function stats(tgt = currentTarget()) {
  let words = 0;
  let translated = 0;
  const all = dictCol.all();
  for (const e of all) {
    if (e.kind === 'word') words++;
    if (e.translations[tgt]) translated++;
  }
  return { total: all.length, words, lines: all.length - words, translated, pending: all.length - translated };
}

// ---- writing ----

function newEntry(kind, text, src, { tgt, translation, now = Date.now(), lookedUp = false } = {}) {
  return {
    id: newId('d'), kind, text, src,
    translations: translation && isLang(tgt) ? { [tgt]: translation } : {},
    count: 1, firstSeen: now, lastSeen: now, lookedUp
  };
}

// Content words of a line, punctuation trimmed, deduped by comparison form.
export function extractWords(text, src, minLen = store.get('minWordLen') || 3) {
  const min = usesSpaces(src) ? minLen : 1; // CJK and Thai words are short
  const seen = new Set();
  const out = [];
  for (const seg of segmentWords(text, src)) {
    if (!seg.word) continue;
    const w = normalizeTerm(seg.text).slice(0, WORD_MAX);
    const letters = (w.match(/\p{L}/gu) || []).length;
    if ([...w].length < min || letters < Math.min(2, min) || /^\p{L}?\d+$/u.test(w)) continue;
    const k = normalize(w);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

// Record one capture: dialog regions become 'line' entries (with their
// translation when given), and words from every region are seeded as
// 'word' entries. Each entry's count goes up at most once per call.
// regions: [{ text, kind: 'dialog'|'menu'|'label'|'line', translation? }]
export function recordCapture(regions, src, tgt, { minLen } = {}) {
  const result = { lines: 0, words: 0 };
  if (!isLang(src) || !Array.isArray(regions)) return result;
  const now = Date.now();
  const batch = new Map(); // key -> entry
  const upsert = (kind, text, translation) => {
    const key = entryKey(kind, src, text);
    if (!normalize(text)) return;
    let e = batch.get(key);
    if (!e) {
      const existing = find(kind, src, text);
      if (existing) {
        e = { ...existing, translations: { ...existing.translations }, count: existing.count + 1, lastSeen: now };
      } else {
        e = newEntry(kind, text, src, { now });
        result[kind === 'line' ? 'lines' : 'words']++;
      }
      batch.set(key, e);
    }
    const tr = cleanText(translation, LINE_MAX);
    if (tr && isLang(tgt) && !e.translations[tgt] && !isEngineErrorText(tr)) e.translations[tgt] = tr;
  };
  for (const r of regions) {
    const text = cleanText(r?.text, LINE_MAX);
    if (!text) continue;
    if (r.kind === 'dialog' || r.kind === 'line') upsert('line', text, r.translation);
    for (const w of extractWords(text, src, minLen)) upsert('word', w, null);
  }
  if (batch.size) {
    for (const e of dictCol.putMany([...batch.values()])) getIndex().set(entryKey(e.kind, e.src, e.text), e.id);
    evictIfNeeded();
  }
  return result;
}

// Translation of a word (from the entry when known, else fetched and saved).
// Never bumps the seen count. Rejects with the translate error when offline.
export async function lookupWord(term, src, tgt) {
  const clean = normalizeTerm(cleanText(term, WORD_MAX));
  if (!clean || !isLang(src) || !isLang(tgt)) throw new TypeError('Nothing to look up');
  let entry = find('word', src, clean);
  let translation = entry?.translations[tgt];
  if (!translation) translation = await translate(clean, src, tgt);
  entry = find('word', src, clean); // may have changed while we waited
  entry = entry
    ? put({ ...entry, translations: { ...entry.translations, [tgt]: entry.translations[tgt] || translation }, lookedUp: true })
    : put(newEntry('word', clean, src, { tgt, translation, lookedUp: true }));
  evictIfNeeded();
  return { entry: view(entry, tgt), translation: entry.translations[tgt] };
}

// Translate an entry's stored text (pending rows, "Translate all", or
// "Translate again" with { refresh: true } to bypass the cache).
export async function translateEntry(id, tgt = currentTarget(), { refresh = false } = {}) {
  const e = dictCol.get(id);
  if (!e) throw new Error('This entry no longer exists.');
  const translation = await translate(e.text, e.src, tgt, { refresh });
  const out = setTranslation(id, tgt, translation);
  if (!out) throw new Error('This entry no longer exists.'); // deleted while translating
  return out;
}

// Set (or with '' remove) the translation for one target language.
export function setTranslation(id, tgt, text) {
  const e = dictCol.get(id);
  if (!e || !isLang(tgt)) return null;
  const t = cleanText(text, LINE_MAX);
  const translations = { ...e.translations };
  if (t && !isEngineErrorText(t)) translations[tgt] = t;
  else delete translations[tgt];
  return view(put({ ...e, translations }), tgt);
}

// Returns the removed entry (for undo) or null.
export function removeEntry(id) {
  const e = dictCol.delete(id);
  if (e) index?.delete(entryKey(e.kind, e.src, e.text));
  return e;
}

export function restoreEntry(removed) {
  const e = sanitizeEntry(removed);
  if (!e) return null;
  const existing = find(e.kind, e.src, e.text);
  if (existing) return view(put(mergeInto(existing, e)), currentTarget());
  if (dictCol.has(e.id)) e.id = newId('d');
  return view(put(e), currentTarget());
}

export function clearAll() {
  dictCol.clear();
  index = new Map();
}

// Restore from a backup (entries already sanitized). 'merge' folds entries
// with the same identity together (translations united, larger counts kept).
export function importEntries(list, { mode = 'merge' } = {}) {
  if (mode === 'replace') {
    dictCol.replaceAll(list);
    index = null;
    getIndex(); // folds duplicates inside the backup itself
    evictIfNeeded();
    return list.length;
  }
  const writes = new Map();
  for (const e of list) {
    const key = entryKey(e.kind, e.src, e.text);
    const existing = writes.get(key) || find(e.kind, e.src, e.text);
    if (existing) writes.set(key, mergeInto(existing, e));
    else writes.set(key, dictCol.has(e.id) ? { ...e, id: newId('d') } : e);
  }
  for (const e of dictCol.putMany([...writes.values()])) getIndex().set(entryKey(e.kind, e.src, e.text), e.id);
  evictIfNeeded();
  return writes.size;
}

// Keep the dictionary bounded. Throw away one-off untranslated sightings
// first (often OCR noise), then the least recently seen. Words the user
// looked up or that are on a flashcard go last.
function evictIfNeeded() {
  if (dictCol.size() <= MAX_ENTRIES) return 0;
  const onCards = new Set(allCards().map((c) => normalize(c.text) + '|' + c.src));
  const tier = (e) => {
    if (e.lookedUp || onCards.has(normalize(e.text) + '|' + e.src)) return 2;
    return !Object.keys(e.translations).length && e.count <= 1 ? 0 : 1;
  };
  const ranked = dictCol.all().map((e) => [tier(e), e]).sort((a, b) => a[0] - b[0] || a[1].lastSeen - b[1].lastSeen);
  const n = dictCol.size() - EVICT_TO;
  for (let i = 0; i < n; i++) removeEntry(ranked[i][1].id);
  return n;
}

export { evictIfNeeded as _evictIfNeeded, MAX_ENTRIES };
