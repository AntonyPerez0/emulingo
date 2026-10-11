// Flashcards with SM-2 style scheduling (Again / Hard / Good / Easy), the
// review activity log, streak and week stats, and CSV/TSV export.
// Days are local study days that roll over at 4 am; intervals of a day or
// more land on that day boundary, so a card reviewed in the evening is due
// the next morning rather than at the same clock time.

import { collection, onChange } from './db.js';
import { store } from './store.js';
import { isLang } from './language.js';
import { normalize, clamp, dayKey, dateFromKey, newId, ID_RE } from './utils.js';
import { isEngineErrorText } from './translate.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const AGAIN_MS = 10 * MINUTE;
const MAX_DAYS = 365;
const MATURE_DAYS = 21;
const ROLLOVER_HOUR = 4;
const TEXT_MAX = 1000;
const START_EASE = 2.5;

export const GRADES = Object.freeze({ AGAIN: 0, HARD: 1, GOOD: 2, EASY: 3 });

// ---- record schemas ----

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const intIn = (v, min, max, dflt) => (finite(Number(v)) ? clamp(Math.round(Number(v)), min, max) : dflt);

export function cleanText(v, max = TEXT_MAX) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

// Validate a card (v1 or v2 shape) -> clean v2 card, or null.
export function sanitizeCard(raw, { fallbackTgt } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  const text = cleanText(raw.text);
  const src = isLang(raw.src) ? raw.src : isLang(raw.lang) ? raw.lang : null; // v1: lang
  if (!text || !src) return null;
  const fallback = fallbackTgt ?? store.get('target');
  const tgt = isLang(raw.tgt) ? raw.tgt : isLang(fallback) ? fallback : 'en';
  let translation = cleanText(raw.translation);
  if (isEngineErrorText(translation)) translation = ''; // cached MyMemory warnings
  const now = Date.now();
  const added = finite(raw.added) && raw.added > 0 ? raw.added : now;
  const seen = intIn(raw.seen, 0, 1e6, 0);
  let lastResult = [0, 1, 2, 3].includes(raw.lastResult) ? raw.lastResult : null;
  if (!raw.src && raw.lang && lastResult === 1) lastResult = 2; // v1 grades: 0 again, 1 good, 3 easy
  return {
    id: raw.id,
    text,
    translation,
    src,
    tgt,
    origin: raw.origin === 'auto' ? 'auto' : 'manual',
    added,
    due: finite(raw.due) ? raw.due : added,
    interval: finite(raw.interval) ? clamp(raw.interval, 0, MAX_DAYS * DAY) : 0,
    ease: finite(raw.ease) ? clamp(Math.round(raw.ease * 100) / 100, 1.3, 5) : START_EASE,
    reps: intIn(raw.reps, 0, 1e5, 0),
    lapses: intIn(raw.lapses, 0, 1e5, 0),
    seen,
    lastResult,
    lastReview: finite(raw.lastReview) ? raw.lastReview : null,
    firstReview: finite(raw.firstReview) ? raw.firstReview : null
  };
}

export function sanitizeActivity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.id)) return null;
  const count = intIn(raw.count, 0, 1e6, 0);
  return count > 0 ? { id: raw.id, count } : null;
}

const cardsCol = collection('cards', { sanitize: (r) => sanitizeCard(r) });
const activityCol = collection('activity', { sanitize: sanitizeActivity });

// ---- dedupe index (normalized text + language pair) ----

export const cardKey = (text, src, tgt) => `${normalize(text)}|${src}|${tgt}`;
let index = null;

function getIndex() {
  if (!index) {
    index = new Map();
    for (const c of cardsCol.all()) index.set(cardKey(c.text, c.src, c.tgt), c.id);
  }
  return index;
}

onChange(({ collections, remote }) => {
  if (remote && collections.includes('cards')) index = null;
});

function findByKey(key) {
  const id = getIndex().get(key);
  const card = id ? cardsCol.get(id) : null;
  if (id && !card) index = null; // stale after a reload; rebuild next time
  return card;
}

// ---- cards ----

export function cards() {
  return cardsCol.all().sort((a, b) => b.added - a.added);
}

export function getCard(id) {
  return cardsCol.get(id);
}

export function totalCards() {
  return cardsCol.size();
}

// -> { status: 'added'|'duplicate'|'error', card }. A duplicate with an empty
// back gets the new translation (it was added before translation finished).
export function addCard({ text, translation = '', src, tgt, origin = 'manual' } = {}) {
  const t = cleanText(text);
  if (!t || !normalize(t) || !isLang(src) || !isLang(tgt)) return { status: 'error', card: null };
  let tr = cleanText(translation);
  if (isEngineErrorText(tr)) tr = '';
  const key = cardKey(t, src, tgt);
  const existing = findByKey(key);
  if (existing) {
    const card = !existing.translation && tr ? cardsCol.put({ ...existing, translation: tr }) : existing;
    return { status: 'duplicate', card };
  }
  const now = Date.now();
  const card = cardsCol.put({
    id: newId('c'), text: t, translation: tr, src, tgt, origin: origin === 'auto' ? 'auto' : 'manual',
    added: now, due: now, interval: 0, ease: START_EASE, reps: 0, lapses: 0, seen: 0,
    lastResult: null, lastReview: null, firstReview: null
  });
  getIndex().set(key, card.id);
  return { status: 'added', card };
}

export function findCard(text, src, tgt) {
  return findByKey(cardKey(text, src, tgt));
}

// Returns the removed card (for undo) or null.
export function removeCard(id) {
  const card = cardsCol.delete(id);
  if (card) index?.delete(cardKey(card.text, card.src, card.tgt));
  return card;
}

export function restoreCard(removed) {
  const card = sanitizeCard(removed);
  if (!card || cardsCol.has(card.id)) return null;
  const key = cardKey(card.text, card.src, card.tgt);
  if (findByKey(key)) return null;
  const out = cardsCol.put(card);
  getIndex().set(key, out.id);
  return out;
}

// Edit the front or back (fixing an OCR misread or a bad translation).
export function updateCard(id, patch = {}) {
  const card = cardsCol.get(id);
  if (!card) return null;
  const next = { ...card };
  if ('text' in patch) next.text = cleanText(patch.text);
  if ('translation' in patch) next.translation = cleanText(patch.translation);
  if (!next.text || !normalize(next.text)) return null;
  const oldKey = cardKey(card.text, card.src, card.tgt);
  const newKey = cardKey(next.text, next.src, next.tgt);
  if (newKey !== oldKey) {
    const other = findByKey(newKey);
    if (other && other.id !== id) return null; // would duplicate another card
    index?.delete(oldKey);
    getIndex().set(newKey, id);
  }
  return cardsCol.put(next);
}

export function clearAll() {
  cardsCol.clear();
  index = new Map();
}

// Restore from a backup (records already sanitized). 'replace' swaps the deck;
// 'merge' adds new cards and, for a card on both sides, keeps the copy with
// more reviews. Returns how many cards were written.
export function importCards(list, { mode = 'merge' } = {}) {
  if (mode === 'replace') {
    const seen = new Set();
    const unique = list.filter((c) => {
      const k = cardKey(c.text, c.src, c.tgt);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    cardsCol.replaceAll(unique);
    index = null;
    return unique.length;
  }
  const writes = new Map(); // key -> card to write
  const idx = getIndex();
  for (const c of list) {
    const key = cardKey(c.text, c.src, c.tgt);
    const existing = writes.get(key) || (idx.has(key) ? cardsCol.get(idx.get(key)) : null);
    if (existing) {
      const theirsBetter = c.seen > existing.seen ||
        (c.seen === existing.seen && (c.lastReview || 0) > (existing.lastReview || 0));
      if (theirsBetter) writes.set(key, { ...c, id: existing.id });
      continue;
    }
    writes.set(key, cardsCol.has(c.id) ? { ...c, id: newId('c') } : c);
  }
  for (const card of cardsCol.putMany([...writes.values()])) idx.set(cardKey(card.text, card.src, card.tgt), card.id);
  return writes.size;
}

// Activity per day: 'merge' keeps the larger count (importing twice is harmless).
export function importActivity(list, { mode = 'merge' } = {}) {
  if (mode === 'replace') {
    activityCol.replaceAll(list);
    return list.length;
  }
  const writes = list.filter((a) => a.count > (activityCol.get(a.id)?.count || 0));
  activityCol.putMany(writes);
  return writes.length;
}

// ---- scheduling ----

// Start of the local study day `days` after the one containing `now`, at 4 am.
function dueAfterDays(now, days) {
  const d = new Date(now);
  if (d.getHours() < ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, ROLLOVER_HOUR, 0, 0, 0).getTime();
}

function nextDays(card, q, random) {
  let days;
  if (card.reps === 0) {
    days = q === GRADES.EASY ? 4 : 1; // new or relearning
  } else {
    const prev = Math.max(1, card.interval / DAY);
    const hard = Math.max(prev + 1, prev * 1.2);
    const good = Math.max(hard + 1, prev * card.ease);
    const easy = Math.max(good + 1, good * 1.3);
    days = q === GRADES.HARD ? hard : q === GRADES.GOOD ? good : easy;
  }
  if (days >= 3) days *= 0.95 + random() * 0.1; // ±5 % so cards added together spread out
  return clamp(Math.round(days), 1, MAX_DAYS);
}

// Pure: the scheduling fields after answering q. Used by grade() and previews.
export function schedule(card, q, { now = Date.now(), random = Math.random } = {}) {
  let { ease, reps, lapses } = card;
  let interval;
  let due;
  if (q === GRADES.AGAIN) {
    if (reps > 0) { // forgetting a learned card is a lapse; a brand-new card failing is not
      lapses += 1;
      ease = Math.max(1.3, ease - 0.2);
    }
    reps = 0;
    interval = AGAIN_MS;
    due = now + AGAIN_MS;
  } else {
    const days = nextDays(card, q, random);
    if (q === GRADES.HARD) ease = Math.max(1.3, ease - 0.15);
    if (q === GRADES.EASY) ease = Math.min(5, ease + 0.15);
    reps += 1; // Good keeps the ease unchanged (SM-2)
    interval = days * DAY;
    due = dueAfterDays(now, days);
  }
  return {
    ease: Math.round(ease * 100) / 100,
    reps,
    lapses,
    interval,
    due,
    lastResult: q,
    lastReview: now,
    seen: (card.seen || 0) + 1,
    firstReview: card.firstReview ?? now
  };
}

// Answer a card and log the review. Returns the UPDATED card (the Review view
// re-queues this copy on Again). With { ahead: true } (study ahead), a card
// that isn't due yet keeps its schedule unless the answer is Again.
export function grade(cardId, q, { now = Date.now(), ahead = false, random = Math.random } = {}) {
  const card = cardsCol.get(cardId);
  if (!card || ![0, 1, 2, 3].includes(q)) return null;
  const patch = ahead && q !== GRADES.AGAIN && card.due > now
    ? { seen: card.seen + 1, lastReview: now, lastResult: q, firstReview: card.firstReview ?? now }
    : schedule(card, q, { now, random });
  const updated = cardsCol.put({ ...card, ...patch });
  logReview(now);
  return updated;
}

// Nominal interval (ms, no fuzz) each answer would give, for button labels.
export function previewIntervals(card) {
  const out = {};
  for (const q of [0, 1, 2, 3]) {
    out[q] = q === GRADES.AGAIN ? AGAIN_MS : nextDays(card, q, () => 0.5) * DAY;
  }
  return out;
}

const isNew = (c) => !c.seen;

function introducedOn(key, list) {
  return list.filter((c) => c.firstReview && dayKey(new Date(c.firstReview), ROLLOVER_HOUR) === key).length;
}

// Cards to study now: due reviews (oldest due first), then new cards up to
// the daily limit minus the new cards already started today.
export function dueCards({ limitNew = store.get('newPerDay'), now = Date.now() } = {}) {
  const all = cardsCol.all();
  const reviews = all.filter((c) => !isNew(c) && c.due <= now).sort((a, b) => a.due - b.due);
  const limit = finite(limitNew) || limitNew === Infinity ? limitNew : 20;
  const room = Math.max(0, limit - introducedOn(dayKey(new Date(now), ROLLOVER_HOUR), all));
  const fresh = room > 0 ? all.filter(isNew).sort((a, b) => a.added - b.added).slice(0, room) : [];
  return [...reviews, ...fresh];
}

export function dueCount(opts) {
  return dueCards(opts).length;
}

// { reviews, fresh, total } for the stats strip.
export function dueBreakdown(opts) {
  const list = dueCards(opts);
  const fresh = list.filter(isNew).length;
  return { reviews: list.length - fresh, fresh, total: list.length };
}

// When the next card becomes due (for "Next review in 3 hours"), or null.
export function nextDueAt({ now = Date.now(), limitNew = store.get('newPerDay') } = {}) {
  let next = null;
  for (const c of cardsCol.all()) {
    if (!isNew(c) && c.due > now && (next === null || c.due < next)) next = c.due;
  }
  if (cardsCol.all().some(isNew) && limitNew > 0) {
    const tomorrow = dueAfterDays(now, 1);
    if (next === null || tomorrow < next) next = tomorrow;
  }
  return next;
}

export function matureCount() {
  return cardsCol.all().filter((c) => c.interval >= MATURE_DAYS * DAY).length;
}

// ---- activity: graded reviews per study day ----

export function todayKey(now = Date.now()) {
  return dayKey(new Date(now), ROLLOVER_HOUR);
}

export function logReview(now = Date.now(), n = 1) {
  const key = todayKey(now);
  const prev = activityCol.get(key);
  activityCol.put({ id: key, count: (prev?.count || 0) + n });
}

export function reviewsOn(key) {
  return activityCol.get(key)?.count || 0;
}

// Consecutive study days with reviews, ending today (or yesterday while today is still empty).
export function streak(now = Date.now()) {
  const d = dateFromKey(todayKey(now));
  if (!reviewsOn(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (reviewsOn(dayKey(d)) > 0 && n < 10000) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

const fmtShort = new Intl.DateTimeFormat('en', { weekday: 'short' });
const fmtLong = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' });

// The last 7 study days, oldest first: [{ key, label: 'Mon', long: 'Monday, October 5', count, today }].
export function weekStats(now = Date.now()) {
  const today = dateFromKey(todayKey(now));
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12);
    const key = dayKey(d);
    out.push({ key, label: fmtShort.format(d), long: fmtLong.format(d), count: reviewsOn(key), today: i === 0 });
  }
  return out;
}

export function activity() {
  return activityCol.all().sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---- export ----

const isoDay = (ts) => (finite(ts) ? dayKey(new Date(ts), 0) : '');

// Spreadsheet apps run cells starting with = + - @ (also after a tab or CR)
// as formulas, even quoted: prefix them with an apostrophe.
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function exportCsv() {
  const header = ['Front', 'Back', 'Game language', 'Translation language', 'Added', 'Next review',
    'Interval (days)', 'Ease', 'Reviews', 'Lapses'];
  const rows = cards().reverse().map((c) => [
    c.text, c.translation, c.src, c.tgt, isoDay(c.added), isNew(c) ? 'new' : isoDay(c.due),
    Math.round(c.interval / DAY), c.ease.toFixed(2), c.seen, c.lapses
  ]);
  // BOM so Excel opens UTF-8 (umlauts, kana) correctly
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Anki-friendly: one "front<TAB>back" line per card (Import File › Tab).
export function exportTsv() {
  const field = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return cards().reverse().map((c) => field(c.text) + '\t' + field(c.translation)).join('\n') + '\n';
}
