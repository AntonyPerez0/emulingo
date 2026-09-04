// Translation via MyMemory free API + localStorage cache + in-flight dedupe.

import { load, save } from './localStorage.js';

let cache = load('translations', {});
export function getTranslateCache() { return cache; }

const inflight = new Map();

function isJapaneseLike(s) {
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(s);
}

export async function translate(text, src, tgt) {
  const key = src + '>' + tgt + '|' + text;
  if (cache[key]) return cache[key];
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const q = encodeURIComponent(text);
      const pair = src === 'auto' ? tgt : src + '|' + tgt;
      // MyMemory limits q to 500 bytes; split long text
      const chunks = [];
      let cur = '';
      for (const w of text.split(' ')) {
        if ((cur + ' ' + w).length > 420) { chunks.push(cur.trim()); cur = w; }
        else cur += ' ' + w;
      }
      if (cur.trim()) chunks.push(cur.trim());

      const results = [];
      for (const chunk of chunks) {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${pair}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data.responseData && data.responseData.translatedText) {
          let t = data.responseData.translatedText;
          // MyMemory sometimes returns ALL-CAPS or garbage markers
          if (/^[A-Z0-9\s\p{P}]+$/u.test(t) && t.length > 3 && !isJapaneseLike(t)) {
            t = t.toLowerCase().replace(/(^|\.\s)(\p{L})/gu, (m) => m.toUpperCase());
          }
          t = t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          results.push(t);
        } else {
          throw new Error('No translation');
        }
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
