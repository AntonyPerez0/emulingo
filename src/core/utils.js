// Small pure helpers shared by the data layer and the views.

// Comparison form of a text: case-folded, full-width folded (NFKC), punctuation
// and symbols dropped, whitespace collapsed. Used for dedupe, never for display.
// ♂ and ♀ stay: NIDORAN♂ and NIDORAN♀ are different Pokémon.
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?:(?![♂♀])[\p{P}\p{S}])+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

const pad2 = (n) => String(n).padStart(2, '0');

// Local study-day key 'YYYY-MM-DD'. The day rolls over at 4 am, so a late
// night session still counts for the evening it started in. Uses local
// calendar fields (not UTC, not ms arithmetic) to stay right across DST.
export function dayKey(date = new Date(), rolloverHour = 4) {
  const d = new Date(date);
  if (d.getHours() < rolloverHour) d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// Noon on the calendar day of a key: safe to step by whole days across DST.
export function dateFromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null;
}

const UNITS = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60]
];

let rtf = null;
// "just now", "5 minutes ago", "yesterday", "in 3 hours" (future times work too).
export function relativeTime(ts, now = Date.now()) {
  const secs = Math.round((Number(ts) - now) / 1000);
  if (!Number.isFinite(secs)) return '';
  if (Math.abs(secs) < 45) return secs > 0 ? 'in a moment' : 'just now';
  rtf ||= new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size || unit === 'minute') {
      return rtf.format(Math.round(secs / size), unit);
    }
  }
  return '';
}

// Trailing debounce with an optional maxWait, plus flush() and cancel().
export function debounce(fn, ms, { maxWait = 0 } = {}) {
  let timer = null;
  let first = 0;
  let lastArgs = null;
  const run = () => {
    clearTimeout(timer);
    timer = null;
    first = 0;
    const args = lastArgs;
    lastArgs = null;
    return fn(...(args || []));
  };
  const debounced = (...args) => {
    lastArgs = args;
    const now = Date.now();
    if (!first) first = now;
    clearTimeout(timer);
    const wait = maxWait ? Math.max(0, Math.min(ms, first + maxWait - now)) : ms;
    timer = setTimeout(run, wait);
  };
  debounced.flush = () => (timer ? run() : undefined);
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    first = 0;
    lastArgs = null;
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (Object.prototype.toString.call(input) === '[object ArrayBuffer]') return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new TextEncoder().encode(String(input ?? ''));
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// SHA-1 of bytes or a string. crypto.subtle only exists in secure contexts,
// so plain-http LAN dev servers fall back to a small JS implementation.
export async function sha1Hex(input) {
  const bytes = toBytes(input);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      return hex(new Uint8Array(await subtle.digest('SHA-1', bytes)));
    } catch { /* fall through to the JS version */ }
  }
  return sha1Js(bytes);
}

function sha1Js(bytes) {
  const len = bytes.length;
  const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  words[words.length - 1] = len * 8; // byte lengths up to 512 MB fit in 32 bits
  words[words.length - 2] = Math.floor(len / 0x20000000);
  let [a, b, c, d, e] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 80; t++) {
      w[t] = t < 16 ? words[i + t] : rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    }
    let [A, B, C, D, E] = [a, b, c, d, e];
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (B & C) | (~B & D) : t < 40 ? B ^ C ^ D : t < 60 ? (B & C) | (B & D) | (C & D) : B ^ C ^ D;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (rotl(A, 5) + f + E + k + w[t]) >>> 0;
      E = D; D = C; C = rotl(B, 30) >>> 0; B = A; A = tmp;
    }
    a = (a + A) >>> 0; b = (b + B) >>> 0; c = (c + C) >>> 0; d = (d + D) >>> 0; e = (e + E) >>> 0;
  }
  return [a, b, c, d, e].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// 32-bit FNV-1a of a string, as base36. Cheap stable ids for derived keys.
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Short unique id for stored records; always matches /^[\w.:-]+$/.
export function newId(prefix = 'x') {
  const rand = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('')
    : Math.random().toString(36).slice(2, 8);
  return prefix + Date.now().toString(36) + rand;
}

export const ID_RE = /^[\w.:-]{1,80}$/;

export function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 || e.code === 1014);
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const segmenters = new Map();
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;

// Word segments of a line for tap-to-look-up and dictionary seeding.
// Intl.Segmenter splits scripts without spaces (Japanese, Chinese, Thai);
// the regex fallback keeps apostrophes and hyphens inside Latin words.
export function segmentWords(text, lang) {
  const str = String(text ?? '');
  const out = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    let seg = segmenters.get(lang);
    if (!seg) {
      try { seg = new Intl.Segmenter(lang || undefined, { granularity: 'word' }); }
      catch { seg = new Intl.Segmenter(undefined, { granularity: 'word' }); }
      segmenters.set(lang, seg);
    }
    for (const s of seg.segment(str)) {
      out.push({ text: s.segment, index: s.index, word: !!s.isWordLike && /[\p{L}\p{N}]/u.test(s.segment) });
    }
    return out;
  }
  let last = 0;
  for (const m of str.matchAll(WORD_RE)) {
    if (m.index > last) out.push({ text: str.slice(last, m.index), index: last, word: false });
    out.push({ text: m[0], index: m.index, word: true });
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push({ text: str.slice(last), index: last, word: false });
  return out;
}

// Save a Blob as a file. The anchor is attached and the URL revoked later:
// revoking in the same tick cancels the download in Safari.
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
