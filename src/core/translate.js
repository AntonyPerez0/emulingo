// Translation engine chain, best quality first (all keyless):
// 1. Google translate_a/single (translate.googleapis.com)
// 2. Google dict-chrome-ex (clients5.google.com) - separate rate-limit pool,
//    often still working when endpoint 1 is 429-blocked for anonymous traffic
// 3. MyMemory free API
// Results are cached in localStorage under a 'v2|' key namespace so
// previously cached low-quality MyMemory-only translations are invalidated.

import { load, save } from './localStorage.js';

let cache = load('translations', {});
export function getTranslateCache() { return cache; }

const inflight = new Map();

function isJapaneseLike(s) {
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(s);
}

// app language codes are ISO-639-1; Google's endpoint needs these remapped
function googleLang(code) {
  if (code === 'auto') return 'auto';
  if (code === 'zh') return 'zh-CN';
  if (code === 'he') return 'iw';
  return code;
}

// split on word boundaries into chunks of <= 420 chars (MyMemory caps the
// query at 500 bytes and long queries degrade quality everywhere)
function chunkText(text) {
  const chunks = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if ((cur + ' ' + w).length > 420) { chunks.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

// fetch with a hard timeout so a hung engine doesn't stall the whole chain
async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// shared output cleanup: MyMemory (and rarely Google) sometimes returns
// ALL-CAPS or garbage markers; normalize those, then decode HTML entities
function cleanOutput(t) {
  if (/^[A-Z0-9\s\p{P}]+$/u.test(t) && t.length > 3 && !isJapaneseLike(t)) {
    t = t.toLowerCase().replace(/(^|\.\s)(\p{L})/gu, (m) => m.toUpperCase());
  }
  return decodeEntities(t);
}

// Engine 1: Google public endpoint. Response is a JSON array whose [0] holds
// translated text segments; every engine failure resolves to null instead of
// throwing so the chain can fall through to MyMemory.
async function googleTranslate(chunk, src, tgt) {
  const sl = googleLang(src);
  const tl = googleLang(tgt);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(chunk)}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    // shape: [[["piece1", ...], ["piece2", ...]], ...] — join all pieces
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    let out = '';
    for (const seg of data[0]) {
      if (Array.isArray(seg) && typeof seg[0] === 'string') out += seg[0];
    }
    return cleanOutput(out.trim()) || null;
  } catch {
    return null;
  }
}

// Engine 2: Google dict-chrome-ex (clients5.google.com). Same translator as
// engine 1 but served from the Chrome dictionary backend with its own
// rate-limit pool. Response is a flat array of translated string segments.
async function googleDictTranslate(chunk, src, tgt) {
  const sl = googleLang(src);
  const tl = googleLang(tgt);
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&q=${encodeURIComponent(chunk)}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    // shape: ["piece1", "piece2", ...] (occasionally nested segment arrays)
    if (!Array.isArray(data)) return null;
    let out = '';
    for (const seg of data) {
      if (typeof seg === 'string') out += seg;
      else if (Array.isArray(seg) && typeof seg[0] === 'string') out += seg[0];
    }
    return cleanOutput(out.trim()) || null;
  } catch {
    return null;
  }
}

// Engine 3: MyMemory free API (previous implementation). Returns null on
// any failure; it has no auto-detect, so 'auto' falls back to the target.
async function myMemoryTranslate(chunk, src, tgt) {
  const pair = src === 'auto' ? tgt : src + '|' + tgt;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${pair}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.responseData || !data.responseData.translatedText) return null;
    return cleanOutput(data.responseData.translatedText) || null;
  } catch {
    return null;
  }
}

export async function translate(text, src, tgt) {
  if (!text || !text.trim()) return '';
  const key = 'v2|' + src + '>' + tgt + '|' + text;
  if (cache[key]) return cache[key];
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const results = [];
      // run the whole engine chain per chunk; a chunk only fails when
      // every engine failed for it
      for (const chunk of chunkText(text)) {
        const out = (await googleTranslate(chunk, src, tgt))
          ?? (await googleDictTranslate(chunk, src, tgt))
          ?? (await myMemoryTranslate(chunk, src, tgt));
        if (!out) throw new Error('All translation engines failed');
        results.push(out);
      }
      const out = results.join(' ');
      cache[key] = out;
      const keys = Object.keys(cache);
      if (keys.length > 600) {
        for (const k of keys.slice(0, 100)) delete cache[k];
      }
      save('translations', cache);
      return out;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

export function clearTranslateCache() {
  cache = {};
  save('translations', cache);
}

export function cacheSize() { return Object.keys(cache).length; }
