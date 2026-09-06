// Language-aware OCR misread correction, backed by Hunspell dictionaries.
//
// Tesseract on Game Boy pixel fonts produces systematic misreads ("Eine Welt"
// -> "Eine hWHelt", "Traume" -> missing umlauts). Rather than hand-crafted
// rewrites (too error-prone), every unknown word gets candidate variants
// generated (deletions, transpositions, pixel-font confusion substitutions,
// accent restoration) and each candidate is checked against a real Hunspell
// dictionary via nspell. A correction is only applied when a single unambiguous
// valid candidate exists - leaving an error as-is is never worse than the
// status quo, but a wrong "fix" poisons the translation, flashcards and
// dictionary, so ambiguity means no correction.
//
// Dictionaries (dic+aff) are fetched once from jsDelivr, cached in IndexedDB,
// and only the major game languages are covered; others silently skip.

import { idbGet, idbSet } from './idb.js';

const NSPELL_URL = 'https://cdn.jsdelivr.net/npm/nspell@2/+esm';

const DICTS = {
  de: ['dictionary-de@3.0.0', 1118194],
  en: ['dictionary-en@4.0.0', 551762],
  fr: ['dictionary-fr@3.0.0', 1229133],
  es: ['dictionary-es@4.0.0', 706202],
  it: ['dictionary-it@2.0.0', 1295754]
};

// Test hook: node cannot import https URLs, tests inject a local loader.
let nspellLoader = () => import(/* @vite-ignore */ NSPELL_URL);
export function _setNspellLoader(fn) { nspellLoader = fn; }

const spellers = new Map();
const lastFail = new Map();

// hard deadline per file - a stalled mobile connection must never hang the
// OCR loop; 30s is generous even on slow links
const cfg = { fetchTimeout: 30000, stallTimeout: 15000, retryBackoff: 15000 };
export function _setTestConfig(overrides) { Object.assign(cfg, overrides); }

// Fetch a text file while reporting fractional download progress (0..1).
// Falls back to a single all-at-once callback when the response gives no
// body stream or no content length. Two watchdogs guard the loop: an abort
// deadline for the whole fetch and a per-read stall timer, because some
// platforms may not reject a hung stream on abort.
async function fetchTextWithProgress(url, onFrac) {
  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), cfg.fetchTimeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = parseInt(res.headers.get('content-length') || '0', 10);
    if (!res.body || !res.body.getReader || !total) {
      const text = await res.text();
      onFrac(1);
      return text;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let loaded = 0, text = '';
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dictionary download stalled')), cfg.stallTimeout))
      ]);
      const { done, value } = chunk;
      if (done) break;
      loaded += value.length;
      text += decoder.decode(value, { stream: true });
      onFrac(Math.min(1, loaded / total));
    }
    text += decoder.decode();
    return text;
  } finally {
    clearTimeout(abortTimer);
  }
}

async function getSpeller(code, onStatus) {
  if (!DICTS[code]) return null;
  if (spellers.has(code)) return spellers.get(code);
  // a recent failure (stall, offline, CDN down) -> skip silently for a while
  if (Date.now() - (lastFail.get(code) || 0) < cfg.retryBackoff) return null;
  const p = (async () => {
    try {
      let blobs = null;
      try { blobs = await idbGet('spelldict:' + code); } catch {}
      if (!blobs || !blobs.dic) {
        const [pkg] = DICTS[code];
        const base = `https://cdn.jsdelivr.net/npm/${pkg}/`;
        const msg = 'downloading spellcheck dictionary (once, ~1 MB)';
        // dic is ~98% of the bytes, aff the rest
        const report = (which, frac) => {
          if (!onStatus) return;
          const overall = which === 'dic' ? frac * 0.98 : 0.98 + frac * 0.02;
          onStatus({ status: msg, progress: Math.min(1, overall) });
        };
        const dic = await fetchTextWithProgress(base + 'index.dic', (f) => report('dic', f));
        const aff = await fetchTextWithProgress(base + 'index.aff', (f) => report('aff', f));
        blobs = { dic, aff };
        try { await idbSet('spelldict:' + code, blobs); } catch {}
      }
      const mod = await nspellLoader();
      const nspell = mod.default || mod;
      return nspell(blobs.aff || '', blobs.dic);
    } catch {
      // offline / CDN down -> correction disabled for now, retry after backoff
      lastFail.set(code, Date.now());
      spellers.delete(code);
      return null;
    }
  })();
  spellers.set(code, p);
  return p;
}

// Hunspell spell() returns a boolean in some versions and {correct} in others
function spellOk(speller, word) {
  try {
    const r = speller.spell(word);
    if (r === true) return true;
    if (r && typeof r === 'object') return !!r.correct;
  } catch {}
  return false;
}

function capitalize(w) { return w.charAt(0).toUpperCase() + w.slice(1); }

function checkValid(speller, lowerWord) {
  return spellOk(speller, lowerWord) || spellOk(speller, capitalize(lowerWord));
}

// accent-insensitive first letter ("über" must compare equal to "uber",
// otherwise the first-letter guard rejects corrections that ARE the accent)
function baseLetter(ch) {
  const d = (ch || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return (d[0] || ch || '').toLowerCase();
}

// Characters Tesseract commonly confuses on 8x8 pixel fonts
const CONFUSIONS = {
  l: '1Ii|li', i: '1lIji|', I: 'l1i', e: 'cEo', c: 'eo', o: '0Oae', 0: 'oO',
  a: 'os', s: 'S5z', S: 's5', 5: 'sS', b: 'hlo', h: 'blnok', n: 'hmiru',
  m: 'rn', r: 'nv', u: 'vni', v: 'uyw', w: 'vvu', y: 'vg', g: 'q9',
  q: 'g9', p: 'q', d: 'clqo', t: 'fl', f: 't', k: 'xh', x: 'k', z: '2s',
  Z: '2', 2: 'zZ', B: '8', 8: 'B', 1: 'li', 3: 'b', 6: 'b', 9: 'gq'
};

// Multi-character merges/splits typical of monospaced bitmap fonts
const PAIR_CONFUSIONS = [
  ['rn', 'm'], ['m', 'rn'], ['vv', 'w'], ['w', 'vv'], ['cl', 'd'], ['d', 'cl'],
  ['ii', 'u'], ['u', 'ii'], ['li', 'h'], ['h', 'li'], ['nn', 'm'], ['uu', 'w']
];

const ACCENTS = {
  a: 'äàáâãå', e: 'éèêë', i: 'íìîï', o: 'öòóôõ',
  u: 'üùúû', c: 'ç', n: 'ñ', y: 'ýÿ'
};

function editVariants(base) {
  const out = new Set();
  const n = base.length;
  if (n > 18) return out;
  for (let i = 0; i < n; i++) {
    out.add(base.slice(0, i) + base.slice(i + 1)); // deletion
    if (i + 1 < n) out.add(base.slice(0, i) + base[i + 1] + base[i] + base.slice(i + 2)); // transposition
    const alts = CONFUSIONS[base[i]];
    if (alts) for (const c of alts) out.add(base.slice(0, i) + c + base.slice(i + 1)); // confusion substitution
  }
  for (const [from, to] of PAIR_CONFUSIONS) {
    let idx = base.indexOf(from);
    while (idx !== -1) {
      out.add(base.slice(0, idx) + to + base.slice(idx + from.length));
      idx = base.indexOf(from, idx + 1);
    }
  }
  out.delete(base);
  return out;
}

// Accented variants of `base` where exactly k accentable letters are
// replaced (k = 1, 2, 3), e.g. "traume" -> k=1: "träume", "traumé", ...
// Iterative deepening keeps the common single-accent case cheap (<= 24
// dictionary lookups).
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

function pickCandidate(found, allowedFirst) {
  const uniq = [...new Set(found)].filter((c) => c.length >= 3);
  if (!uniq.length) return null;
  if (uniq.length === 1) {
    // a correction must at least start like the word it replaces
    return allowedFirst.includes(baseLetter(uniq[0][0])) ? uniq[0] : null;
  }
  // several dictionary words fit - require exactly one to start like the
  // misread, otherwise it is too ambiguous to trust
  const sameFirst = uniq.filter((c) => allowedFirst.includes(baseLetter(c[0])));
  return sameFirst.length === 1 ? sameFirst[0] : null;
}

function correctToken(speller, core) {
  const bases = new Set([core.toLowerCase()]);
  // OCR often hallucinates 1-2 lowercase letters before a capital mid-word
  // ("hWHelt" -> "WHelt"); try the stripped form as a second base
  const stripped = core.replace(/^[\p{Ll}]{1,2}(?=[\p{Lu}])/u, '');
  if (stripped && stripped !== core) bases.add(stripped.toLowerCase());
  // candidate capitalization follows the original (or its stripped form)
  const capital = /^\p{Lu}/u.test(core) || /^\p{Lu}/u.test(stripped);
  // corrections must start with one of these letters (original / stripped)
  const allowedFirst = [...new Set([core[0], (stripped || core)[0]].map(baseLetter))];

  // pass 1: accent restoration (no structural edit), 1 then 2 then 3 accents
  let found = [];
  for (const k of [1, 2, 3]) {
    found = [];
    for (const b of bases) {
      for (const v of accentVariants(b, k)) {
        if (checkValid(speller, v)) found.push(v);
      }
    }
    const best = pickCandidate(found, allowedFirst);
    if (best) return capital ? capitalize(best) : best;
    if (found.length) return null; // accents existed but ambiguous - stop
  }

  // pass 2: single-edit variants (deletions, transpositions, confusions)
  found = [];
  for (const b of bases) {
    for (const v of editVariants(b)) {
      if (checkValid(speller, v)) found.push(v);
    }
  }
  const best = pickCandidate(found, allowedFirst);
  return best ? (capital ? capitalize(best) : best) : null;
}

// Correct a line of OCR'd text. lang is a Tesseract code like "deu" or the
// app's "de"; only languages with a dictionary get corrected. onStatus
// receives progress notes while the dictionary downloads (first run only).
export async function correctOcrText(text, lang, onStatus) {
  const raw = String(text || '');
  const code = (lang || '').slice(0, 2);
  const speller = await getSpeller(code, onStatus);
  if (!speller || !raw) return raw;

  const parts = raw.split(/(\s+)/);
  let words = 0, changed = 0;
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (!tok || /^\s+$/u.test(tok)) continue;
    const m = tok.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
    if (!m || !m[2]) continue;
    const [, lead, core, trail] = m;
    if (core.length < 3) continue;                 // short fragments: too little signal
    if (/\d/u.test(core)) continue;                // numbers / damage values
    if (/^\p{Lu}+[\p{Lu}\d]*$/u.test(core)) continue; // ALL-CAPS: names, shouts
    if (/^\p{Lu}/u.test(core) && trail.includes('.')) continue; // "Prof." "Dr." abbreviations
    words++;
    // a lowercase token is only "known" if its exact lowercase form is valid:
    // accepting the Capitalized form here would let unrelated nouns ("Schoner"
    // = schooner) block correcting "schoner" -> "schöner"
    const capital = /^\p{Lu}/u.test(core);
    if (spellOk(speller, core) || (capital && spellOk(speller, core.toLowerCase()))) continue;
    const fix = correctToken(speller, core);
    if (fix && fix !== core) { parts[i] = lead + fix + trail; changed++; }
  }
  // if every word of a multi-word line got rewritten, the dictionary is
  // probably the wrong language - keep the original
  if (words >= 2 && changed === words) return raw;
  return parts.join('');
}

// Game-font tokens the OCR engines systematically mangle. The GB font
// renders "é" as a custom tile that both Tesseract and PaddleOCR misread
// ("POKéMON" -> "POKBMON"/"POKEMON"/"POKeMON"). These are safe pattern
// repairs, not dictionary guesses.
const GAME_LEXICON = [
  [/\bPOK[BEO0ÉÈēĒè]?(?=(MON|GEAR|DEX|COM|BALL|DOLL|CENTER)\b)/gu, 'POKé']
];

export function applyGameLexicon(text) {
  let out = String(text || '');
  for (const [re, to] of GAME_LEXICON) out = out.replace(re, to);
  return out;
}

export async function warmSpeller(lang, onStatus) {
  const code = (lang || '').slice(0, 2);
  return getSpeller(code, onStatus);
}

export function hasDictionary(lang) {
  return !!DICTS[(lang || '').slice(0, 2)];
}
