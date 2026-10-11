// Dictionary-validated OCR misread correction (OCR-06, OCR-17).
//
// Pixel fonts produce systematic misreads ("rnundo" for "mundo", "Aquf" for
// "Aquí", missing umlauts from Tesseract). Every unknown word gets candidate
// variants (pixel-font confusions, transpositions, short-word deletions,
// accent restoration) that are checked against a Hunspell dictionary; a
// correction is only applied when exactly one valid candidate exists.
// Leaving an error is never worse than the raw read, but a wrong "fix"
// poisons translations, cards and the dictionary - so the scanner only asks
// for corrections on uncertain lines (score < 0.85) and Tesseract output.
//
// This module has two halves:
// - the pure core (createSpeller, correctLine), used inside
//   correct.worker.js and tested in Node with the real dictionaries;
// - the main-thread client (createCorrector), which downloads the
//   dictionaries with progress, caches them in IndexedDB and talks to the
//   worker, because building the German speller takes ~1.4 s and the
//   French one ~6 s.

import { gameWords } from './vocab.js';

// Hunspell dictionaries from npm (wooorm/dictionaries), pinned.
export const DICTS = {
  de: { pkg: 'dictionary-de', version: '3.0.0', bytes: 1118194 },
  en: { pkg: 'dictionary-en', version: '4.0.0', bytes: 551762 },
  fr: { pkg: 'dictionary-fr', version: '3.0.0', bytes: 1229133 },
  es: { pkg: 'dictionary-es', version: '4.0.0', bytes: 706202 },
  it: { pkg: 'dictionary-it', version: '2.0.0', bytes: 1295754 }
};

// App language code ("de", "pt-BR") -> dictionary key. Never a Tesseract
// code: "spa".slice(0, 2) used to give "sp" and no Spanish dictionary.
export function dictLang(lang) {
  return String(lang || '').toLowerCase().split(/[-_]/u)[0];
}

export function hasDictionary(lang) {
  return Object.prototype.hasOwnProperty.call(DICTS, dictLang(lang));
}

export function dictionaryUrl(lang, file) {
  const d = DICTS[dictLang(lang)];
  return d ? `https://cdn.jsdelivr.net/npm/${d.pkg}@${d.version}/index.${file}` : null;
}

// ---------------------------------------------------------------------------
// Pure core

// Hunspell spell() returns a boolean in some versions and {correct} in others.
function spellOk(speller, word) {
  try {
    const r = speller.spell(word);
    if (r === true) return true;
    if (r && typeof r === 'object') return !!r.correct;
  } catch {
    // malformed input for the affix engine: treat as unknown
  }
  return false;
}

function capitalize(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// Candidates count when their lowercase or Capitalised form is a word.
function checkValid(speller, lowerWord) {
  return spellOk(speller, lowerWord) || spellOk(speller, capitalize(lowerWord));
}

// Adds words (game vocabulary) so they are never "corrected".
export function addWords(speller, words) {
  for (const w of words || []) {
    try {
      speller.add(w);
    } catch {
      // nspell rejects some characters; skip the word
    }
  }
  return speller;
}

// Builds a speller from dictionary text plus the language's game words.
// nspell is passed in so this module never bundles it on the main thread.
export function createSpeller(nspell, aff, dic, lang, extraWords = []) {
  const speller = nspell(aff || '', dic || '');
  return addWords(speller, [...gameWords(dictLang(lang)), ...extraWords]);
}

// Accent-insensitive first letter ("über" must compare equal to "uber",
// otherwise the first-letter guard rejects corrections that ARE the accent).
function baseLetter(ch) {
  const d = String(ch || '').normalize('NFD').replace(/[̀-ͯ]/gu, '');
  return (d[0] || ch || '').toLowerCase();
}

// Characters OCR confuses on 8x8 pixel fonts. "f" -> "í" covers the
// Spanish accented i, which the latin recogniser reads as "f" ("Aquf").
const CONFUSIONS = {
  l: '1Ii|', i: '1lIj|', I: 'l1i', e: 'cEo', c: 'eo', o: '0Oae', 0: 'oO',
  a: 'os', s: 'S5z', S: 's5', 5: 'sS', b: 'hlo', h: 'blnok', n: 'hmiru',
  m: 'rn', r: 'nv', u: 'vni', v: 'uyw', w: 'vvu', y: 'vg', g: 'q9',
  q: 'g9', p: 'q', d: 'clqo', t: 'fl', f: 'tí', k: 'xh', x: 'k', z: '2s',
  Z: '2', 2: 'zZ', B: '8', 8: 'B', 1: 'li', 3: 'b', 6: 'b', 9: 'gq'
};

// Multi-character merges/splits typical of monospaced bitmap fonts.
const PAIR_CONFUSIONS = [
  ['rn', 'm'], ['m', 'rn'], ['vv', 'w'], ['w', 'vv'], ['cl', 'd'], ['d', 'cl'],
  ['ii', 'u'], ['u', 'ii'], ['li', 'h'], ['h', 'li'], ['nn', 'm'], ['uu', 'w']
];

const ACCENTS = {
  a: 'äàáâãå', e: 'éèêë', i: 'íìîï', o: 'öòóôõ',
  u: 'üùúû', c: 'ç', n: 'ñ', y: 'ýÿ'
};

// Single-edit variants -> { atStart } (a pair confusion at index 0, the
// only edit allowed to change the first letter: "rnundo" -> "mundo").
// Deletions are skipped for words of 6+ letters: on long valid words they
// mostly produce other valid words ("Haustiere" -> "Hausiere").
function editVariants(base) {
  const out = new Map();
  const n = base.length;
  if (n > 18) return out;
  const put = (v, atStart = false) => {
    if (v !== base && (!out.has(v) || atStart)) out.set(v, { atStart });
  };
  for (let i = 0; i < n; i++) {
    if (n < 6) put(base.slice(0, i) + base.slice(i + 1));
    if (i + 1 < n) put(base.slice(0, i) + base[i + 1] + base[i] + base.slice(i + 2));
    const alts = CONFUSIONS[base[i]];
    if (alts) for (const c of alts) put(base.slice(0, i) + c + base.slice(i + 1));
  }
  for (const [from, to] of PAIR_CONFUSIONS) {
    let idx = base.indexOf(from);
    while (idx !== -1) {
      put(base.slice(0, idx) + to + base.slice(idx + from.length), idx === 0);
      idx = base.indexOf(from, idx + 1);
    }
  }
  return out;
}

// Accented variants of `base` where exactly k accentable letters change
// (k = 1, 2, 3), e.g. "traume" -> k=1: "träume", "traumé", ...
function accentVariants(base, k) {
  const positions = [];
  for (let i = 0; i < base.length && positions.length < 4; i++) {
    if (ACCENTS[base[i]]) positions.push(i);
  }
  const results = [];
  const combo = (start, left, acc) => {
    for (let p = start; p < positions.length; p++) {
      for (const c of ACCENTS[base[positions[p]]]) {
        const next = acc + base.slice(acc.length, positions[p]) + c;
        if (left === 1) results.push(next + base.slice(positions[p] + 1));
        else combo(p + 1, left - 1, next);
      }
    }
  };
  combo(0, k, '');
  return results;
}

// found: [[candidate, { atStart }]]. A correction must start like the word
// it replaces (or be a first-letter pair confusion); several fits are only
// accepted when exactly one of them qualifies.
function pickCandidate(found, allowedFirst) {
  const byWord = new Map();
  for (const [c, meta] of found) {
    if (c.length < 3) continue;
    const prev = byWord.get(c);
    byWord.set(c, { atStart: !!(meta && meta.atStart) || !!(prev && prev.atStart) });
  }
  const ok = [...byWord].filter(([c, meta]) => meta.atStart || allowedFirst.includes(baseLetter(c[0])));
  if (byWord.size === 1) return ok.length ? ok[0][0] : null;
  return ok.length === 1 ? ok[0][0] : null;
}

function correctToken(speller, core) {
  const bases = new Set([core.toLowerCase()]);
  // OCR hallucinates 1-2 lowercase letters before a capital mid-word
  // ("hWHelt" -> "WHelt"); try the stripped form as a second base
  const stripped = core.replace(/^\p{Ll}{1,2}(?=\p{Lu})/u, '');
  if (stripped && stripped !== core) bases.add(stripped.toLowerCase());
  const capital = /^\p{Lu}/u.test(core) || /^\p{Lu}/u.test(stripped);
  const allowedFirst = [...new Set([core[0], (stripped || core)[0]].map(baseLetter))];
  const shape = (w) => (capital ? capitalize(w) : w);

  // pass 1: accent restoration (no structural edit), 1 then 2 then 3 accents
  for (const k of [1, 2, 3]) {
    const found = [];
    for (const b of bases) {
      for (const v of accentVariants(b, k)) {
        if (checkValid(speller, v)) found.push([v, null]);
      }
    }
    const best = pickCandidate(found, allowedFirst);
    if (best) return shape(best);
    if (found.length) return null; // accents fit but ambiguously - stop
  }

  // pass 2: single-edit variants (deletions, transpositions, confusions)
  const found = [];
  for (const b of bases) {
    for (const [v, meta] of editVariants(b)) {
      if (checkValid(speller, v)) found.push([v, meta]);
    }
  }
  const best = pickCandidate(found, allowedFirst);
  return best ? shape(best) : null;
}

const foldCase = (w) => w.toLocaleLowerCase();

// Whether a token is a word. German nouns and nominalised verbs are
// capitalised, and dictionary-de rejects many valid lowercase forms
// ("tragen", "wissen", "wild"): accept the Capitalised form, or a
// suggestion equal to the token apart from case.
function isKnown(speller, core, lang) {
  if (spellOk(speller, core)) return true;
  const lower = core.toLowerCase();
  if (/^\p{Lu}/u.test(core) && spellOk(speller, lower)) return true;
  if (lang !== 'de') return false;
  if (spellOk(speller, lower) || spellOk(speller, capitalize(lower))) return true;
  if (core.length > 14) return false; // suggest() gets slow on long words
  let suggestions = [];
  try {
    suggestions = speller.suggest(core) || [];
  } catch {
    suggestions = [];
  }
  return suggestions.some((s) => foldCase(s) === foldCase(core));
}

// One-letter words per language: any other lone letter next to a word is a
// split ("Figh t", "t o"). Hunspell accepts every letter, so it can't tell.
const ONE_LETTER_WORDS = {
  en: 'aI', de: '', fr: 'aàyô', es: 'aeouy', it: 'aeèio'
};

// Re-joins a lone letter with its neighbour when the joined word is valid
// and the letter is not a word on its own ("the speller says so", OCR-18).
function mergeSplits(speller, text, lang) {
  const singles = ONE_LETTER_WORDS[lang] ?? 'aI';
  const toks = text.split(' ');
  const lone = (t) => /^\p{L}$/u.test(t) && !singles.includes(t);
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = /^([^\p{L}]*)(\p{L}+)$/u.exec(toks[i]);
    const b = /^(\p{L}+)([^\p{L}]*)$/u.exec(toks[i + 1]);
    if (!a || !b || !(lone(a[2]) || lone(b[1]))) continue;
    const joined = a[2] + b[1];
    if (joined.length < 2 || !spellOk(speller, joined)) continue;
    toks.splice(i, 2, a[1] + joined + b[2]);
    i--;
  }
  return toks.join(' ');
}

// Corrects one line. Only words of 3+ letters are corrected; digits,
// hyphenated compounds, ALL-CAPS words (names, menus) and abbreviations
// are left alone. Two-letter words still count as evidence of the
// language: when most words are unknown the line is probably another
// language (or noise) and is returned unchanged - correcting English with
// the German dictionary turned "world of Pokémon! My name is Oak." into
// "word of Pokémon! My Dame is Oak." in the old app.
export function correctLine(speller, text, lang) {
  const raw = String(text || '');
  if (!speller || !raw.trim()) return raw;
  const code = dictLang(lang);
  const merged = mergeSplits(speller, raw.replace(/\s+/gu, ' ').trim(), code);
  const parts = merged.split(/(\s+)/u);
  let words = 0;
  let unknown = 0;
  const fixes = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (!tok || /^\s+$/u.test(tok)) continue;
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(tok);
    if (!m || !m[2]) continue;
    const [, lead, core, trail] = m;
    if (core.length < 2 || /\d/u.test(core)) continue;
    if (/[^\p{L}'’]/u.test(core)) continue;                // hyphenated compounds, symbols
    if (/^\p{Lu}+$/u.test(core)) continue;                  // ALL-CAPS: names, menus
    if (/^\p{Lu}/u.test(core) && trail.startsWith('.') && core.length <= 4) continue; // "Prof."
    words++;
    if (isKnown(speller, core, code)) continue;
    unknown++;
    if (core.length < 3 || /['’]/u.test(core)) continue;     // too little signal, elisions
    const fix = correctToken(speller, core);
    if (fix && fix !== core) fixes.push({ i, text: lead + fix + trail });
  }
  if (words >= 2 && unknown / words > 0.5) return raw;
  if (!unknown) return merged === raw.replace(/\s+/gu, ' ').trim() ? raw : merged;
  for (const f of fixes) parts[f.i] = f.text;
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Main-thread client

const DEFAULT_CONFIG = {
  fetchTimeout: 120000,  // whole download, per file (1.3 MB on a slow link)
  stallTimeout: 15000,   // no bytes for this long = stalled
  initTimeout: 90000,    // building the speller (French: ~8 s on a desktop)
  requestTimeout: 8000,  // one correction
  backoff: [15000, 60000, 300000]
};

// Fetches a text file, reporting progress (0..1). An abort deadline for the
// whole fetch and a stall timer per read guard against hung mobile links.
export async function fetchTextWithProgress(url, onFrac = () => {}, cfg = DEFAULT_CONFIG) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const abortTimer = setTimeout(() => ctrl && ctrl.abort(), cfg.fetchTimeout);
  let stallTimer = null;
  let finished = false;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = parseInt(res.headers.get('content-length') || '0', 10);
    if (!res.body || !res.body.getReader || !total) {
      const text = await res.text();
      finished = true;
      onFrac(1);
      return text;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let loaded = 0;
    let text = '';
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          stallTimer = setTimeout(() => reject(new Error('Download stalled')), cfg.stallTimeout);
        })
      ]);
      clearTimeout(stallTimer);
      if (chunk.done) break;
      loaded += chunk.value.length;
      text += decoder.decode(chunk.value, { stream: true });
      onFrac(Math.min(1, loaded / total));
    }
    finished = true;
    return text + decoder.decode();
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(stallTimer);
    // a stalled or failed download must not keep the connection open
    if (!finished && ctrl) ctrl.abort();
  }
}

function defaultWorker() {
  return new Worker(new URL('./correct.worker.js', import.meta.url), { type: 'module' });
}

async function defaultStorage() {
  const idb = await import('../idb.js');
  return { get: idb.idbGet, set: idb.idbSet };
}

// createCorrector({ onStatus, createWorker, fetchText, storage, config })
//   -> { correct(text, lang, score), warm(lang), supports(lang), isReady(lang),
//        addWords(lang, words), subscribe(fn), dispose() }
// onStatus/subscribe receive { phase: 'download'|'init'|'ready'|'error',
// lang, progress (0..1), message }.
// correct() resolves with the input unchanged when the language has no
// dictionary or the dictionary cannot be loaded; it never rejects.
export function createCorrector(opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  const makeWorker = opts.createWorker || defaultWorker;
  const fetchText = opts.fetchText || ((url, onFrac) => fetchTextWithProgress(url, onFrac, cfg));
  const now = opts.now || (() => Date.now());
  const listeners = new Set(opts.onStatus ? [opts.onStatus] : []);
  const langs = new Map();
  const extra = new Map();
  const pending = new Map();
  let storagePromise = null;
  let worker = null;
  let seq = 0;

  const emit = (s) => {
    for (const fn of listeners) {
      try { fn(s); } catch { /* a broken listener must not stop correction */ }
    }
  };

  const storage = () => {
    if (!storagePromise) {
      storagePromise = opts.storage ? Promise.resolve(opts.storage) : defaultStorage().catch(() => null);
    }
    return storagePromise;
  };

  function state(lang) {
    if (!langs.has(lang)) langs.set(lang, { ready: false, promise: null, failedAt: 0, fails: 0 });
    return langs.get(lang);
  }

  function failAll(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    for (const st of langs.values()) st.ready = false;
    if (worker) {
      try { worker.terminate(); } catch { /* already gone */ }
    }
    worker = null;
  }

  function getWorker() {
    if (worker) return worker;
    worker = makeWorker();
    worker.onmessage = (e) => {
      const msg = e.data || {};
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'Spell-checker error'));
    };
    worker.onerror = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      failAll(new Error((e && e.message) || 'Spell-checker stopped'));
    };
    return worker;
  }

  function call(msg, timeout, transfer) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        const err = new Error('Spell-checker timed out');
        err.timeout = true;
        reject(err);
      }, timeout);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try {
        getWorker().postMessage({ ...msg, id }, transfer || []);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function loadFiles(lang) {
    const key = 'spelldict:' + lang;
    const d = DICTS[lang];
    const store = await storage();
    let files = null;
    if (store) {
      try { files = await store.get(key); } catch { files = null; }
    }
    // v1 cached { dic, aff } without a version; the pinned versions are the same
    if (files && files.dic && files.aff && (!files.version || files.version === d.version)) return files;
    const message = 'Downloading the spell-checker dictionary (once)…';
    const report = (which, frac) => {
      // the .dic is ~98% of the bytes
      const progress = which === 'dic' ? frac * 0.98 : 0.98 + frac * 0.02;
      emit({ phase: 'download', lang, progress: Math.min(1, progress), message });
    };
    report('dic', 0);
    const dic = await fetchText(dictionaryUrl(lang, 'dic'), (f) => report('dic', f));
    const aff = await fetchText(dictionaryUrl(lang, 'aff'), (f) => report('aff', f));
    files = { aff, dic, version: d.version };
    if (store) {
      try { await store.set(key, files); } catch { /* quota: keep working without the cache */ }
    }
    return files;
  }

  function warm(rawLang) {
    const lang = dictLang(rawLang);
    if (!DICTS[lang]) return Promise.resolve(false);
    const st = state(lang);
    if (st.ready) return Promise.resolve(true);
    if (st.promise) return st.promise;
    const wait = cfg.backoff[Math.min(st.fails, cfg.backoff.length) - 1] || 0;
    if (st.fails && now() - st.failedAt < wait) return Promise.resolve(false);
    st.promise = (async () => {
      try {
        const files = await loadFiles(lang);
        emit({ phase: 'init', lang, progress: 1, message: 'Preparing the spell-checker…' });
        const words = extra.get(lang) || [];
        await call({ type: 'init', lang, aff: files.aff, dic: files.dic, words }, cfg.initTimeout);
        // the worker keeps one speller: building this one dropped the others
        for (const [other, ost] of langs) if (other !== lang) ost.ready = false;
        st.ready = true;
        st.fails = 0;
        // words added while the speller was being built
        const late = (extra.get(lang) || []).slice(words.length);
        if (late.length) call({ type: 'add', lang, words: late }, cfg.requestTimeout).catch(() => {});
        emit({ phase: 'ready', lang, progress: 1, message: 'Spell-checker ready' });
        return true;
      } catch (err) {
        // a build that never finishes would hold up every later message:
        // start over with a fresh worker next time
        if (err && err.timeout) failAll(err);
        st.fails++;
        st.failedAt = now();
        emit({ phase: 'error', lang, progress: 0, message: 'The spell-checker isn’t available right now', detail: String(err && err.message || err) });
        return false;
      } finally {
        st.promise = null;
      }
    })();
    return st.promise;
  }

  async function correct(text, rawLang) {
    const lang = dictLang(rawLang);
    const raw = String(text == null ? '' : text);
    if (!raw.trim() || !DICTS[lang]) return raw;
    if (!(await warm(lang))) return raw;
    try {
      const res = await call({ type: 'correct', lang, text: raw }, cfg.requestTimeout);
      // another language's speller replaced this one in the worker: build
      // it again on the next call
      if (res.ready === false) state(lang).ready = false;
      return typeof res.text === 'string' ? res.text : raw;
    } catch {
      return raw;
    }
  }

  function addWordsFor(rawLang, words) {
    const lang = dictLang(rawLang);
    const list = (words || []).map(String).filter(Boolean);
    extra.set(lang, [...(extra.get(lang) || []), ...list]);
    if (state(lang).ready) call({ type: 'add', lang, words: list }, cfg.requestTimeout).catch(() => {});
  }

  return {
    correct,
    warm,
    supports: hasDictionary,
    isReady: (lang) => !!(langs.get(dictLang(lang)) || {}).ready,
    addWords: addWordsFor,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      failAll(new Error('Spell-checker closed'));
      langs.clear();
    }
  };
}

let shared = null;

// The app-wide corrector (one worker).
export function getCorrector() {
  if (!shared) shared = createCorrector();
  return shared;
}

// Scanner dependency: (text, lang, score) => Promise<string>.
export function correctText(text, lang) {
  return getCorrector().correct(text, lang);
}

// Starts the dictionary download and speller build early (e.g. while the
// ROM boots). Resolves true when ready.
export function warmSpeller(lang, onStatus) {
  const c = getCorrector();
  const off = onStatus ? c.subscribe(onStatus) : null;
  return c.warm(lang).finally(() => off && off());
}
