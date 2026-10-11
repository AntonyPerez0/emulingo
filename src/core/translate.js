// Translation through keyless public endpoints, best quality first:
// 1. Google translate_a/single (translate.googleapis.com, CORS-enabled)
// 2. Google dict-chrome-ex (clients5.google.com): a separate rate-limit pool
// 3. MyMemory: reports failures as HTTP 200 with the error as the
//    "translation", so its replies are checked before they are accepted.
// Successful results go into an LRU cache (Map order = recency) capped by
// size and saved to localStorage after a short delay. Failures throw and are
// never cached.

import { load, save, remove } from './localStorage.js';
import { googleCode, fromAnyCode, isLang, usesSpaces } from './language.js';
import { isQuotaError } from './utils.js';

const CACHE_KEY = 'translations';
const CACHE_VERSION = 3; // v1/v2 entries may hold cached MyMemory error text
const MAX_CACHE_CHARS = 300_000;
const SAVE_DELAY = 1500;
const TIMEOUT_MS = 8000;
const GOOGLE_MAX_CHARS = 900;
const MYMEMORY_MAX_BYTES = 480; // MyMemory rejects queries over 500 bytes
const COOLDOWN_MS = 60_000;

export class TranslateError extends Error {
  constructor(message, { code = 'failed', cause } = {}) {
    super(message);
    this.name = 'TranslateError';
    this.code = code; // 'offline' | 'rate-limited' | 'failed'
    if (cause) this.cause = cause;
  }
}

// ---- text helpers (exported for tests) ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// One pass, so '&amp;lt;' becomes '&lt;' and is not decoded twice.
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const ENGINE_ERROR_RE = /^\s*(MYMEMORY WARNING|QUERY LENGTH LIMIT|PLEASE SELECT TWO DISTINCT|INVALID (SOURCE|TARGET) LANGUAGE|INVALID LANGUAGE PAIR|'?AUTO'? IS AN INVALID|NO QUERY SPECIFIED|IS AN INVALID TARGET LANGUAGE|YOU USED ALL AVAILABLE FREE TRANSLATIONS)/i;

// True for engine error messages that were (or could be) stored as translations.
export function isEngineErrorText(s) {
  return typeof s === 'string' && ENGINE_ERROR_RE.test(s);
}

const hasLower = (s) => /\p{Ll}/u.test(s);
const hasUpper = (s) => /\p{Lu}/u.test(s);
const isAllCaps = (s) => hasUpper(s) && !hasLower(s);

// MyMemory sometimes shouts. Fold to sentence case, unless the game text was
// all caps too (Gen 1–3 menus), in which case caps match what's on screen.
export function fixCase(out, source, tgt) {
  if (!isAllCaps(out) || isAllCaps(source) || out.length < 4) return out;
  const folded = out.toLowerCase().replace(/(^|[.!?:]\s+)(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase());
  return tgt === 'en' ? folded.replace(/\bi\b/g, 'I') : folded;
}

const utf8Bytes = (s) => new TextEncoder().encode(s).length;

// Largest prefix (whole code points) of str that fits max units.
function cutToFit(str, max, measure) {
  let out = '';
  for (const ch of str) {
    if (measure(out + ch) > max) break;
    out += ch;
  }
  return Math.max(out.length, str.codePointAt(0) > 0xffff ? 2 : 1);
}

// Split text into chunks of at most `max` units (chars by default), at
// sentence ends first, then spaces, then hard cuts. Never yields an empty chunk.
export function chunkText(text, max = GOOGLE_MAX_CHARS, measure = (s) => s.length) {
  const out = [];
  const push = (s) => { const t = s.trim(); if (t) out.push(t); };
  const sentences = String(text ?? '').match(/[^.!?。！？]+[.!?。！？]*\s*|[.!?。！？]+\s*/gu) || [];
  let cur = '';
  for (const sentence of sentences) {
    if (measure(cur + sentence) <= max) { cur += sentence; continue; }
    push(cur);
    cur = '';
    if (measure(sentence) <= max) { cur = sentence; continue; }
    for (const word of sentence.match(/\s*\S+\s*/g) || []) {
      if (measure(cur + word) <= max) { cur += word; continue; }
      push(cur);
      let rest = word.trim();
      while (measure(rest) > max) {
        const cut = cutToFit(rest, max, measure);
        push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      cur = rest + ' ';
    }
  }
  push(cur);
  return out;
}

// ---- response parsers (pure; exported for tests) ----

// gtx: [[["piece", "orig", …], …], null, "detected", …, confidence, …]
export function parseGtx(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  let text = '';
  for (const seg of data[0]) if (Array.isArray(seg) && typeof seg[0] === 'string') text += seg[0];
  text = text.trim();
  const detected = typeof data[2] === 'string' ? data[2] : null;
  const confidence = typeof data[6] === 'number' ? data[6] : null;
  return { text, detected, confidence };
}

// dict-chrome-ex: ["piece", …] or [["piece", "detected"], …]
export function parseDictChrome(data) {
  if (!Array.isArray(data)) return null;
  let text = '';
  for (const seg of data) {
    if (typeof seg === 'string') text += seg;
    else if (Array.isArray(seg) && typeof seg[0] === 'string') text += seg[0];
  }
  text = decodeEntities(text).trim();
  return text || null;
}

// MyMemory: accepted only with responseStatus 200, quota left and no error text.
export function parseMyMemory(data) {
  if (!data || typeof data !== 'object') return null;
  if (Number(data.responseStatus) !== 200) return null;
  if (data.quotaFinished === true || data.quotaFinished === 'true') return null;
  const t = data.responseData?.translatedText;
  if (typeof t !== 'string') return null;
  const text = decodeEntities(t).trim();
  if (!text || isEngineErrorText(text)) return null;
  return text;
}

// ---- engines ----

const cooldownUntil = new Map(); // engine -> timestamp

class HttpError extends Error {
  constructor(status) {
    super('HTTP ' + status);
    this.status = status;
  }
}

async function getJson(engine, url) {
  if ((cooldownUntil.get(engine) || 0) > Date.now()) throw new HttpError(429);
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl?.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) cooldownUntil.set(engine, Date.now() + COOLDOWN_MS);
      throw new HttpError(res.status);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;
const mmCode = (code) => (code === 'zh' ? 'zh-CN' : code);

async function viaGoogle(chunk, src, tgt) {
  const sl = src === 'auto' ? 'auto' : googleCode(src);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${enc(sl)}&tl=${enc(googleCode(tgt))}&dt=t&q=${enc(chunk)}`;
  return parseGtx(await getJson('google', url))?.text || null;
}

async function viaDictChrome(chunk, src, tgt) {
  const sl = src === 'auto' ? 'auto' : googleCode(src);
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${enc(sl)}&tl=${enc(googleCode(tgt))}&q=${enc(chunk)}`;
  return parseDictChrome(await getJson('dict', url));
}

async function viaMyMemory(chunk, src, tgt) {
  if (src === 'auto') return null; // no auto-detect
  const pieces = chunkText(chunk, MYMEMORY_MAX_BYTES, utf8Bytes);
  const outs = [];
  for (const piece of pieces) {
    const url = `https://api.mymemory.translated.net/get?q=${enc(piece)}&langpair=${enc(mmCode(src))}|${enc(mmCode(tgt))}`;
    const t = parseMyMemory(await getJson('mymemory', url));
    if (!t) return null;
    outs.push(fixCase(t, piece, tgt));
  }
  return outs.join(usesSpaces(tgt) ? ' ' : '');
}

const ENGINES = [viaGoogle, viaDictChrome, viaMyMemory];

async function translateChunk(chunk, src, tgt) {
  let rateLimited = false;
  let lastErr = null;
  for (const engine of ENGINES) {
    try {
      const out = await engine(chunk, src, tgt);
      if (out && !isEngineErrorText(out)) return out;
    } catch (e) {
      lastErr = e;
      if (e?.status === 429 || e?.status === 403) rateLimited = true;
    }
  }
  if (globalThis.navigator && navigator.onLine === false) {
    throw new TranslateError('You’re offline. Translation needs an internet connection.', { code: 'offline', cause: lastErr });
  }
  if (rateLimited) {
    throw new TranslateError('The translation service is busy. Try again in a minute.', { code: 'rate-limited', cause: lastErr });
  }
  throw new TranslateError('Couldn’t translate this text. Check your connection and try again.', { cause: lastErr });
}

// ---- cache ----

const cache = new Map(); // key -> translation, oldest first
let cacheChars = 0;
let saveTimer = null;
let recencyDirty = false; // hits reordered the cache since the last save

const entrySize = (k, v) => k.length + v.length + 8;

function loadCache() {
  const raw = load(CACHE_KEY, null);
  if (raw && raw.v === CACHE_VERSION && Array.isArray(raw.entries)) {
    for (const e of raw.entries) {
      if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && e[1] && !isEngineErrorText(e[1])) {
        cache.set(e[0], e[1]);
        cacheChars += entrySize(e[0], e[1]);
      }
    }
    evict();
  } else if (raw != null) {
    remove(CACHE_KEY); // older namespaces: start clean
  }
}

function evict(limit = MAX_CACHE_CHARS) {
  for (const [k, v] of cache) {
    if (cacheChars <= limit) break;
    cache.delete(k);
    cacheChars -= entrySize(k, v);
  }
}

function writeCache() {
  clearTimeout(saveTimer);
  saveTimer = null;
  recencyDirty = false;
  const data = () => ({ v: CACHE_VERSION, entries: [...cache] });
  let res = save(CACHE_KEY, data());
  if (res !== true && isQuotaError(res)) {
    // the cache is optional: shrink it rather than fail other writes
    evict(Math.floor(cacheChars / 2));
    res = save(CACHE_KEY, data());
    if (res !== true) remove(CACHE_KEY);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeCache, SAVE_DELAY);
}

// A hit only refreshes recency in memory: rewriting the whole cache to
// localStorage (synchronous) for every repeated line would stutter the game.
// The new order is saved with the next write or when the page is hidden.
function cacheGet(key) {
  const v = cache.get(key);
  if (v === undefined) return undefined;
  cache.delete(key);
  cache.set(key, v);
  recencyDirty = true;
  return v;
}

function cachePut(key, value) {
  if (cache.has(key)) cacheChars -= entrySize(key, cache.get(key));
  cache.delete(key);
  cache.set(key, value);
  cacheChars += entrySize(key, value);
  evict();
  scheduleSave();
}

loadCache();
if (typeof window !== 'undefined' && window.addEventListener) {
  const saveNow = () => { if (saveTimer || recencyDirty) writeCache(); };
  window.addEventListener('pagehide', saveNow);
  // mobile browsers may discard a hidden tab without a pagehide
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
}

// ---- public API ----

const inflight = new Map();

// Translate text from src ('auto' allowed) into tgt. Resolves with the
// translation; rejects with a TranslateError ({ code: 'offline'|'rate-limited'|'failed' }).
// { refresh: true } skips the cached result (a "Translate again" action).
export function translate(text, src, tgt, { refresh = false } = {}) {
  const input = String(text ?? '').trim();
  if (!input) return Promise.resolve('');
  if (!isLang(tgt)) return Promise.reject(new TranslateError('Choose a language to translate into.', { code: 'failed' }));
  if (src !== 'auto' && !isLang(src)) return Promise.reject(new TranslateError('Choose the game’s language first.', { code: 'failed' }));
  if (src === tgt) return Promise.resolve(input);
  const key = `${src}>${tgt}|${input}`;
  const hit = refresh ? undefined : cacheGet(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const parts = [];
      for (const chunk of chunkText(input)) parts.push(await translateChunk(chunk, src, tgt));
      const out = parts.join(usesSpaces(tgt) ? ' ' : '').trim();
      if (!out) throw new TranslateError('Couldn’t translate this text.');
      cachePut(key, out);
      return out;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

const detected = new Map();

// Language of a piece of game text (one of our codes) via Google's sl=auto,
// or null when unknown, unsure or offline. Never throws.
export async function detectLanguage(text) {
  const input = String(text ?? '').trim().slice(0, 300);
  if (input.replace(/[^\p{L}]/gu, '').length < 4) return null;
  if (detected.has(input)) return detected.get(input);
  let code = null;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${enc(input)}`;
    const r = parseGtx(await getJson('google', url));
    if (r?.detected && (r.confidence == null || r.confidence >= 0.5)) code = fromAnyCode(r.detected);
  } catch {
    return null; // not cached: may work next time
  }
  if (detected.size > 200) detected.delete(detected.keys().next().value);
  detected.set(input, code);
  return code;
}

export function clearTranslateCache() {
  cache.clear();
  cacheChars = 0;
  clearTimeout(saveTimer);
  saveTimer = null;
  recencyDirty = false;
  remove(CACHE_KEY);
}

export function cacheSize() {
  return cache.size;
}

// Entries and approximate size in characters (for Settings › Data).
export function cacheStats() {
  return { entries: cache.size, chars: cacheChars };
}
