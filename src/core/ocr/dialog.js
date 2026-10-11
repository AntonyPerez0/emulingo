// Dialog continuity (pure): merges the pages of one conversation into a
// running transcript (OCR-10, PLAY-M3).
//
// Gen 1/2 boxes show two lines and scroll: on A the bottom line moves up
// and a new line types below, so consecutive reads are [L1 L2], [L2 L3],
// [L3 L4]. Gen 3 clears the box and types a new page. Treating every read
// as a new line would translate half sentences and store the shared line
// twice. The tracker appends only what is new and reports whether a read
// continues the current transcript or starts a new one.

import { joinLines } from './layout.js';
import { ABBREVIATION } from './lexicon.js';

const GONE_MS = 1000;
const CAP_LINES = 6;
const TERMINAL = /[.!?…。！？]["'“”‘’»›)\]]*$/u;

// Case-, accent- and punctuation-insensitive form for comparing reads.
export function normalizeForCompare(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Levenshtein distance, giving up once it exceeds `max`.
function editDistance(a, b, max) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const digitsOf = (s) => s.replace(/\D+/gu, '');

// Two normalised reads of the same text: the same pixels re-read after a
// scroll can differ by a letter ("POKéMON!" vs "POKéMONi"), up to `ratio`
// of the length. Numbers must match: "level 6" and "level 7" are news.
export function similarText(a, b, ratio = 0.15) {
  if (a === b) return true;
  const n = Math.max(a.length, b.length);
  if (!a || !b || n < 6 || digitsOf(a) !== digitsOf(b)) return false;
  const max = Math.max(1, Math.floor(n * ratio));
  if (Math.abs(a.length - b.length) > max) return false;
  return editDistance(a, b, max) <= max;
}

export function isCompleteSentence(text) {
  return TERMINAL.test(String(text || '').trim());
}

const FALLBACK_SPLIT = /[^.!?…。！？]+(?:[.!?…。！？]+["'“”‘’»›)\]]*|$)/gu;

// The scanner splits the transcript on every poll: keep one segmenter per
// language instead of building a new one each time.
const segmenters = new Map();
function segmenterFor(lang) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  const key = lang || '';
  if (!segmenters.has(key)) segmenters.set(key, new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }));
  return segmenters.get(key);
}

// Sentences of a text. Intl.Segmenter where available, a regex otherwise;
// both are followed by a pass that re-joins abbreviations ("PROF. OAK")
// and punctuation-only pieces.
export function splitSentences(text, lang) {
  const t = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!t) return [];
  let parts = null;
  try {
    const seg = segmenterFor(lang);
    if (seg) parts = Array.from(seg.segment(t), (s) => s.segment);
  } catch {
    parts = null;
  }
  if (!parts) parts = t.match(FALLBACK_SPLIT) || [t];
  const out = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    const prev = out[out.length - 1];
    if (prev && (ABBREVIATION.test(prev) || !/[\p{L}\p{N}]/u.test(s))) {
      out[out.length - 1] = /^[\p{L}\p{N}¡¿"“'‘(«]/u.test(s) ? `${prev} ${s}` : prev + s;
    } else {
      out.push(s);
    }
  }
  return out;
}

const norm = (lines) => normalizeForCompare(lines.join(' '));

// How many leading lines of `next` repeat the trailing lines of `page`.
function overlap(page, next) {
  for (let k = Math.min(page.length, next.length); k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k && ok; i++) {
      ok = similarText(normalizeForCompare(page[page.length - k + i]), normalizeForCompare(next[i]));
    }
    if (ok) return k;
  }
  return 0;
}

// Text after the longest common prefix, from the start of the word the
// two versions first differ in ("Welc" -> "Welcome to the" adds the word).
function addedText(before, after) {
  if (!before) return after;
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  if (p === after.length) return '';
  if (p > 0 && /\S/u.test(after[p - 1]) && /\S/u.test(after[p])) {
    const cut = after.lastIndexOf(' ', p);
    p = cut < 0 ? 0 : cut;
  }
  return after.slice(p).trim();
}

// createDialogTracker({ lang, capLines, goneMs }) -> { update, reset }
// update(region | null, now) -> DialogState:
//   { id, text, page, added, continued, sentences: { complete, partial } }
// id changes whenever a new transcript starts (continued === false).
export function createDialogTracker({ lang, capLines = CAP_LINES, goneMs = GONE_MS } = {}) {
  let segs = [];      // transcript lines as read; the page is always the last page.length
  let startChar = 0;  // chars cut from the front of joinLines(segs) after a roll-over
  let page = [];
  let goneSince = null;
  let reported = 0;
  let id = 0;

  const transcript = () => joinLines(segs).slice(startChar).trim();

  function clear() {
    segs = [];
    startChar = 0;
    page = [];
    reported = 0;
  }

  function result(before, continued) {
    const text = transcript();
    const all = splitSentences(text, lang);
    const last = all[all.length - 1];
    const done = last && !isCompleteSentence(last) ? all.slice(0, -1) : all;
    if (!continued) reported = 0;
    const complete = done.slice(reported);
    reported = done.length;
    return {
      id,
      text,
      page: joinLines(page),
      added: continued ? addedText(before, text) : text,
      continued,
      sentences: { complete, partial: last && !isCompleteSentence(last) ? last : '' }
    };
  }

  function start(lines) {
    clear();
    id++;
    segs = [...lines];
    page = [...lines];
    return result('', false);
  }

  // After an append the transcript may exceed the cap: a new transcript
  // then starts at the sentence that holds the new text, so captures stay
  // short and every sentence stays whole. One endless sentence is allowed
  // to grow to twice the cap before it is cut at a line.
  function rollOver(appended) {
    if (segs.length <= capLines) return false;
    const full = transcript();
    const fresh = joinLines(segs.slice(segs.length - appended));
    const at = Math.max(0, full.length - fresh.length);
    let from = 0;
    let pos = 0;
    for (const s of splitSentences(full, lang)) {
      const i = full.indexOf(s, pos);
      if (i < 0) break;
      if (i <= at) from = i;
      pos = i + s.length;
    }
    if (from === 0) {
      if (segs.length <= capLines * 2) return false;
      from = at;
    }
    const keep = full.slice(from).trim();
    let s0 = segs.length - 1;
    while (s0 > 0 && joinLines(segs.slice(s0)).length < keep.length) s0--;
    s0 = Math.max(0, Math.min(s0, segs.length - page.length));
    const tail = joinLines(segs.slice(s0));
    segs = segs.slice(s0);
    startChar = Math.max(0, tail.length - keep.length);
    reported = 0;
    id++;
    return true;
  }

  function append(newLines, nextPage, before) {
    segs.push(...newLines);
    page = [...nextPage];
    const rolled = rollOver(newLines.length);
    return result(before, !rolled);
  }

  function update(region, now) {
    const lines = region && Array.isArray(region.lines)
      ? region.lines.map((l) => String(l || '').trim()).filter(Boolean)
      : [];
    const before = transcript();
    if (!lines.length) {
      if (goneSince === null) goneSince = now;
      if (segs.length && now - goneSince > goneMs) clear();
      return result(before, segs.length > 0);
    }
    goneSince = null;
    if (!segs.length) return start(lines);

    const next = norm(lines);
    const cur = norm(page);
    // the same page again, or a stale/partial re-read of it
    if (similarText(next, cur) || (next && cur.startsWith(next))) return result(before, true);
    // the page grew (typing resumed after a pause)
    if (cur && next.startsWith(cur)) {
      segs = segs.slice(0, segs.length - page.length).concat(lines);
      page = [...lines];
      return result(before, true);
    }
    // scroll: the new page starts with the old page's last line(s)
    const k = overlap(page, lines);
    if (k > 0) {
      if (k >= lines.length) return result(before, true);
      return append(lines.slice(k), lines, before);
    }
    // scroll after a pause mid-line: "Welcome t" then "Welcome to the"
    const lastLine = normalizeForCompare(page[page.length - 1]);
    if (lastLine.length >= 3 && normalizeForCompare(lines[0]).startsWith(lastLine)) {
      segs[segs.length - 1] = lines[0];
      return append(lines.slice(1), lines, before);
    }
    // the box was cleared mid-sentence (Gen 3 pages): keep going
    if (before && !isCompleteSentence(before)) return append(lines, lines, before);
    return start(lines);
  }

  function reset() {
    clear();
    goneSince = null;
    id++;
  }

  return { update, reset };
}
