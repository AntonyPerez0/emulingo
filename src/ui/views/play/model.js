// Pure helpers for the Play view (no DOM, unit-tested): word tokens for the
// look-up buttons, roving-tabindex moves, capture diffing for in-place
// updates, sentence tracking for auto-flashcards, the key hint and the
// status-chip wording.
import { segmentWords } from '../../../core/utils.js';
import { splitSentences, isCompleteSentence, normalizeForCompare } from '../../../core/ocr/dialog.js';

// ---- Words --------------------------------------------------------------------

/**
 * Split game text into runs for rendering: words become look-up buttons,
 * everything else (spaces, punctuation, line breaks) stays plain text.
 * → [{ text, word: boolean }]
 */
export function wordTokens(text, lang) {
  const out = [];
  for (const seg of segmentWords(String(text ?? ''), lang)) {
    const last = out[out.length - 1];
    if (!seg.word && last && !last.word) last.text += seg.text;
    else out.push({ text: seg.text, word: !!seg.word });
  }
  return out;
}

const NEXT = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Roving tabindex: the index a key moves to within `count` items, or -1 when
 * the key isn't a navigation key. Arrows stop at the ends (no wrap, like
 * reading); Left/Right swap in right-to-left text.
 */
export function rovingTarget(key, index, count, { rtl = false } = {}) {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  let step = NEXT[key];
  if (!step) return -1;
  if (rtl && (key === 'ArrowLeft' || key === 'ArrowRight')) step = -step;
  return Math.min(count - 1, Math.max(0, index + step));
}

// ---- Captures -------------------------------------------------------------------

/**
 * The renderable parts of a capture, dialog first:
 * [{ key, kind, text, translation, status }].
 */
export function captureParts(capture) {
  if (!capture) return [];
  const parts = [];
  if (capture.dialog && capture.dialog.text) parts.push({ key: 'dialog', kind: 'dialog', ...capture.dialog });
  for (const o of capture.others || []) {
    if (o && o.text) parts.push({ key: String(o.key), kind: o.kind || 'label', text: o.text, translation: o.translation || '', status: o.status || 'done' });
  }
  return parts;
}

/**
 * What changed between two renderings of a capture:
 *  - 'new'          another capture (or nothing shown yet)
 *  - 'text'         same capture, but some original text changed or parts came/went
 *                   (re-rendering it would move keyboard focus)
 *  - 'translation'  only translations or statuses changed (safe to patch in place)
 *  - 'none'         nothing visible changed
 * plus `changed`: the keys of parts whose translation or status changed.
 */
export function diffCapture(prev, next) {
  if (!prev || !next || prev.id !== next.id) return { kind: 'new', changed: [] };
  const a = captureParts(prev);
  const b = captureParts(next);
  const sameShape = a.length === b.length && a.every((p, i) => p.key === b[i].key && p.text === b[i].text);
  if (!sameShape) return { kind: 'text', changed: b.map((p) => p.key) };
  const changed = b.filter((p, i) => p.translation !== a[i].translation || p.status !== a[i].status).map((p) => p.key);
  if (prev.conf !== next.conf && !changed.length) return { kind: 'translation', changed: [] };
  return { kind: changed.length ? 'translation' : 'none', changed };
}

/** Low-confidence hint: only for a real score below 0.75. */
export function isLowConfidence(conf) {
  return typeof conf === 'number' && Number.isFinite(conf) && conf > 0 && conf < 0.75;
}

/** One-line summary of a capture for lists: dialog text, else the other regions. */
export function captureSummary(capture) {
  if (!capture) return { text: '', translation: '' };
  if (capture.dialog && capture.dialog.text) {
    return { text: capture.dialog.text, translation: capture.dialog.translation || '' };
  }
  const others = (capture.others || []).filter((o) => o && o.text);
  return {
    text: others.map((o) => o.text.replace(/\n+/g, ' · ')).join(' · '),
    translation: others.map((o) => (o.translation || '').replace(/\n+/g, ' · ')).filter(Boolean).join(' · ')
  };
}

/**
 * Whether two captures show the same text in the same language pair (the
 * scanner can emit a visible line again after a reset; history keeps one).
 */
export function sameCaptureText(a, b) {
  if (!a || !b || a.src !== b.src || a.tgt !== b.tgt) return false;
  const x = normalizeForCompare(captureSummary(a).text);
  return !!x && x === normalizeForCompare(captureSummary(b).text);
}

// ---- Sentences (auto-flashcards, dictionary lines, announcements) ---------------

const wordCount = (s) => String(s || '').trim().split(/\s+/u).filter(Boolean).length;
const letters = (s) => (String(s || '').match(/\p{L}/gu) || []).length;

/**
 * Tracks which sentences of each capture's dialog were already handed out.
 * take(captureId, text, lang, { final }) → sentences that are newly complete:
 * every sentence but the last, and the last once it ends in . ! ? … (or,
 * with final, when the box closed on it and it has at least two words).
 */
export function createSentenceTracker({ maxCaptures = 50 } = {}) {
  const seen = new Map(); // captureId -> Set(normalized sentence)

  function setFor(id) {
    let s = seen.get(id);
    if (!s) {
      s = new Set();
      seen.set(id, s);
      while (seen.size > maxCaptures) seen.delete(seen.keys().next().value);
    }
    return s;
  }

  function take(captureId, text, lang, { final = false } = {}) {
    const parts = splitSentences(text, lang);
    const done = setFor(captureId);
    const out = [];
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const complete = !last || isCompleteSentence(p) || (final && wordCount(p) >= 2);
      if (!complete) return;
      const key = normalizeForCompare(p);
      if (!key || done.has(key)) return;
      done.add(key);
      out.push(p.trim());
    });
    return out;
  }

  // A sentence whose translation failed is offered again by the next take()
  // of its line (after Retry, or when the line continues).
  function release(captureId, sentence) {
    seen.get(captureId)?.delete(normalizeForCompare(sentence));
  }

  return { take, release, forget: (id) => seen.delete(id), clear: () => seen.clear() };
}

/**
 * Whether a sentence makes a sensible flashcard: some letters, not a
 * copyright line or a string of numbers, not absurdly long.
 */
export function isCardWorthy(sentence) {
  const s = String(sentence || '').trim();
  if (!s || s.length > 300) return false;
  if (/[©®™]|\(c\)\s*\d{4}/iu.test(s)) return false;
  const l = letters(s);
  return l >= 2 && l >= s.replace(/\s+/gu, '').length * 0.5;
}

/**
 * Text to speak for a capture whose dialog grew from `before` to `after`:
 * only the new part when it continues what was spoken, else all of it.
 */
export function speechDelta(before, after) {
  const a = String(after || '').trim();
  const b = String(before || '').trim();
  if (!b) return a;
  if (a === b) return '';
  if (a.startsWith(b)) return a.slice(b.length).trim();
  return a;
}

// ---- Keyboard hint --------------------------------------------------------------

const KEY_CODES = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 27: 'Esc', 32: 'Space',
  33: 'Page Up', 34: 'Page Down', 35: 'End', 36: 'Home', 37: '←', 38: '↑', 39: '→', 40: '↓',
  45: 'Insert', 46: 'Delete', 186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`',
  219: '[', 220: '\\', 221: ']', 222: "'"
};

/**
 * Readable name for a key from EmulatorJS's control settings, which hold
 * either a name ('z', 'up arrow') or a legacy key code (90, 38).
 */
export function keyLabel(key) {
  const k = String(key ?? '').trim();
  if (!k) return '';
  if (/^\d+$/.test(k)) {
    const n = Number(k);
    if (KEY_CODES[n]) return KEY_CODES[n];
    if ((n >= 48 && n <= 57) || (n >= 65 && n <= 90)) return String.fromCharCode(n);
    if (n >= 96 && n <= 105) return `Numpad ${n - 96}`;
    if (n >= 112 && n <= 123) return `F${n - 111}`;
    return `Key ${n}`;
  }
  return k.length === 1 ? k.toUpperCase() : k.replace(/^./, (c) => c.toUpperCase());
}

// up, left, down right as key codes or names
const ARROW_SETS = new Set(['38 37 40 39', 'Up Left Down Right', '↑ ← ↓ →']);

/**
 * 'Arrow keys move · Z = A · X = B · Enter = Start · V = Select · Esc returns to the app'
 * from emulator.getKeyMap() entries [{ button, key }].
 */
export function keyHintText(map) {
  const parts = [];
  const list = Array.isArray(map) ? map : [];
  const pad = list.find((k) => k.button === 'D-pad');
  if (pad) {
    const keys = String(pad.key || '').split(/\s+/).filter(Boolean);
    const names = keys.length === 4 ? keys.map(keyLabel) : [];
    const arrows = pad.key === 'Arrow keys' || ARROW_SETS.has(String(pad.key)) || ARROW_SETS.has(names.join(' '));
    parts.push(arrows ? 'Arrow keys move' : `${names.length ? names.join(' ') : pad.key} move`);
  }
  for (const k of list) {
    if (k.button === 'D-pad' || !k.key) continue;
    parts.push(`${keyLabel(k.key)} = ${k.button}`);
  }
  parts.push('Esc returns to the app');
  return parts.join(' · ');
}

// ---- Status chip ------------------------------------------------------------------

const CHIP_LABELS = {
  off: 'Off',
  watching: 'Watching',
  reading: 'Reading…',
  translating: 'Translating…',
  paused: 'Paused',
  error: 'Error'
};

/**
 * Scanner status → chip label (+ the sentence shown under it). "No text on
 * screen" is ordinary watching, never an error.
 */
export function statusView(status) {
  const s = status || { state: 'off' };
  const state = s.state in CHIP_LABELS || s.state === 'setup' ? s.state : 'off';
  let label = CHIP_LABELS[state];
  let progress = null;
  if (state === 'setup') {
    progress = typeof s.progress === 'number' && Number.isFinite(s.progress) ? Math.min(1, Math.max(0, s.progress)) : null;
    label = progress == null ? 'Setting up…' : `Setting up ${Math.round(progress * 100)}%`;
  }
  // The chip already says watching/reading/translating; repeat only messages that add something.
  const showMessage = state === 'paused' || state === 'error' || state === 'setup';
  return { state, label, message: showMessage ? String(s.message || '') : '', detail: s.detail ? String(s.detail) : '', progress };
}

// ---- Formatting -------------------------------------------------------------------

/** '12:41' style time for toasts ("Saved at 12:41"). */
export function clockTime(ts, locale) {
  try {
    return new Date(ts).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}
