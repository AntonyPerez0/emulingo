import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let dict;
let db;
let srs;

const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });

// Google stub: "<tl>:<q>"
function stubGoogle({ fail = false } = {}) {
  const fn = vi.fn(async (url) => {
    const u = new URL(url);
    if (fail || u.hostname !== 'translate.googleapis.com') return json(null, 500);
    const q = u.searchParams.get('q');
    return json([[[`${u.searchParams.get('tl')}:${q}`, q]], null, 'de']);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const words = (list) => list.map((e) => e.text).sort();

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = await import('../../src/core/db.js');
  srs = await import('../../src/core/srs.js');
  dict = await import('../../src/core/dictionary.js');
});

afterEach(() => {
  db.cancelPending({ freeze: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recordCapture', () => {
  it('stores dialog lines with their translation and seeds words from every region', () => {
    const res = dict.recordCapture([
      { kind: 'dialog', text: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!' },
      { kind: 'menu', text: 'KAMPF BEUTEL' },
      { kind: 'label', text: 'TAUBSI L5' }
    ], 'de', 'en');
    expect(res).toEqual({ lines: 1, words: 6 });
    const line = dict.search({ kind: 'line', tgt: 'en' }).items[0];
    expect(line).toMatchObject({ text: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!', count: 1, src: 'de', pending: false });
    expect(words(dict.search({ kind: 'word' }).items)).toEqual(['BEUTEL', 'Ein', 'KAMPF', 'TAUBSI', 'erscheint', 'wildes']);
  });

  it('counts each entry at most once per capture', () => {
    dict.recordCapture([{ kind: 'dialog', text: 'TAUBSI! TAUBSI!' }, { kind: 'label', text: 'TAUBSI' }], 'de', 'en');
    dict.recordCapture([{ kind: 'label', text: 'Taubsi' }], 'de', 'en');
    const w = dict.search({ kind: 'word', q: 'taubsi' }).items;
    expect(w).toHaveLength(1);
    expect(w[0].count).toBe(2);
  });

  it('keeps the menu word and the one-word line apart (kind is part of the key)', () => {
    dict.recordCapture([{ kind: 'dialog', text: 'KAMPF' }], 'de', 'en');
    expect(dict.stats()).toMatchObject({ total: 2, words: 1, lines: 1 });
  });

  it('respects the minimum word length but not for languages without spaces', () => {
    dict.recordCapture([{ kind: 'label', text: 'Da ist ein Ei' }], 'de', 'en', { minLen: 3 });
    expect(words(dict.entries())).toEqual(['ein', 'ist']);
    dict.recordCapture([{ kind: 'label', text: 'ニャースはかわいい' }], 'ja', 'en');
    expect(dict.search({ q: 'ニャース' }).total).toBeGreaterThan(0);
  });

  it('ignores junk input', () => {
    expect(dict.recordCapture(null, 'de', 'en')).toEqual({ lines: 0, words: 0 });
    expect(dict.recordCapture([{ text: 'x' }], 'xx', 'en')).toEqual({ lines: 0, words: 0 });
    expect(dict.recordCapture([null, { text: 42 }, { kind: 'dialog', text: '!!!' }], 'de', 'en')).toEqual({ lines: 0, words: 0 });
  });
});

describe('lookups and translations', () => {
  it('lookupWord uses the stored translation without a request or a count bump', async () => {
    const fetch = stubGoogle();
    dict.recordCapture([{ kind: 'label', text: 'wildes' }], 'de', 'en');
    const first = await dict.lookupWord('wildes!', 'de', 'en');
    expect(first.translation).toBe('en:wildes');
    expect(first.entry).toMatchObject({ count: 1, lookedUp: true, tgt: 'en' });
    await dict.lookupWord('Wildes', 'de', 'en');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dict.search({ q: 'wildes' }).items[0].count).toBe(1);
  });

  it('keeps one translation per target language (switching target never mixes languages)', async () => {
    stubGoogle();
    await dict.lookupWord('wildes', 'de', 'en');
    const fr = await dict.lookupWord('wildes', 'de', 'fr');
    expect(fr.translation).toBe('fr:wildes');
    expect(dict.getEntry(fr.entry.id, 'en').translation).toBe('en:wildes');
    expect(dict.stats('fr')).toMatchObject({ total: 1, translated: 1 });
  });

  it('creates nothing when the translation fails', async () => {
    stubGoogle({ fail: true });
    await expect(dict.lookupWord('wildes', 'de', 'en')).rejects.toMatchObject({ name: 'TranslateError' });
    expect(dict.stats().total).toBe(0);
    await expect(dict.lookupWord('...', 'de', 'en')).rejects.toThrow();
  });

  it('translateEntry translates the stored text without touching counts', async () => {
    stubGoogle();
    dict.recordCapture([{ kind: 'dialog', text: 'Ein wildes TAUBSI erscheint!' }], 'de', 'en');
    const line = dict.search({ kind: 'line' }).items[0];
    expect(line.pending).toBe(true);
    const done = await dict.translateEntry(line.id, 'en');
    expect(done).toMatchObject({ translation: 'en:Ein wildes TAUBSI erscheint!', count: 1, lastSeen: line.lastSeen, kind: 'line' });
    expect(dict.stats().total).toBe(5); // the line + 4 words; no 'word' entry for the sentence
    await expect(dict.translateEntry('missing', 'en')).rejects.toThrow();
  });

  it('translateEntry rejects when the entry is deleted while it translates', async () => {
    let release;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { release = resolve; })));
    dict.recordCapture([{ kind: 'dialog', text: 'Hallo Welt!' }], 'de', 'en');
    const line = dict.search({ kind: 'line' }).items[0];
    const p = dict.translateEntry(line.id, 'en');
    dict.removeEntry(line.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(json([[['Hello world!', 'Hallo Welt!']], null, 'de']));
    await expect(p).rejects.toThrow('no longer exists');
    expect(dict.getEntry(line.id)).toBe(null);
  });

  it('setTranslation edits or clears one language', () => {
    dict.recordCapture([{ kind: 'label', text: 'Trank' }], 'de', 'en');
    const e = dict.entries()[0];
    expect(dict.setTranslation(e.id, 'en', 'Potion').translation).toBe('Potion');
    expect(dict.setTranslation(e.id, 'en', '').pending).toBe(true);
    expect(dict.setTranslation(e.id, '<x>', 'y')).toBe(null);
  });
});

describe('search and stats', () => {
  beforeEach(() => {
    const regions = [];
    for (let i = 0; i < 250; i++) regions.push({ kind: 'label', text: 'wort' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)) });
    dict.recordCapture(regions, 'de', 'en');
    dict.recordCapture([{ kind: 'dialog', text: 'Über den Wolken', translation: 'Above the clouds' }], 'de', 'en');
  });

  it('pages results', () => {
    const page = dict.search({ kind: 'word', offset: 100, limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.total).toBe(253); // 250 + Über, den, Wolken
    expect(dict.search({ kind: 'word', offset: 250, limit: 100 }).items).toHaveLength(3);
    // "everything" must not turn into nothing (Infinity | 0 === 0)
    expect(dict.search({ kind: 'word', limit: Infinity }).items).toHaveLength(253);
    expect(dict.search({ kind: 'word', offset: '250', limit: 'all' }).items).toHaveLength(3);
    expect(dict.search({ kind: 'word', offset: -5, limit: 2 }).items).toHaveLength(2);
  });

  it('matches without accents or case, in translations too', () => {
    expect(dict.search({ q: 'uber', kind: 'line' }).total).toBe(1);
    expect(dict.search({ q: 'CLOUDS' }).total).toBe(1);
    expect(dict.search({ filter: 'translated' }).total).toBe(1);
    expect(dict.search({ filter: 'pending', kind: 'line' }).total).toBe(0);
    expect(dict.search({ sort: 'alpha', kind: 'line' }).items[0].text).toBe('Über den Wolken');
  });

  it('summarises', () => {
    expect(dict.stats('en')).toEqual({ total: 254, words: 253, lines: 1, translated: 1, pending: 253 });
  });
});

describe('remove, restore, clear', () => {
  it('undoes a delete', () => {
    dict.recordCapture([{ kind: 'label', text: 'Pokédex' }], 'de', 'en');
    const e = dict.entries()[0];
    const removed = dict.removeEntry(e.id);
    expect(dict.stats().total).toBe(0);
    expect(dict.restoreEntry(removed).text).toBe('Pokédex');
    expect(dict.stats().total).toBe(1);
    expect(dict.removeEntry('nope')).toBe(null);
    dict.clearAll();
    expect(dict.stats().total).toBe(0);
  });

  it('a restore merges into an entry that came back meanwhile', () => {
    dict.recordCapture([{ kind: 'label', text: 'Pokédex' }], 'de', 'en');
    const removed = dict.removeEntry(dict.entries()[0].id);
    dict.recordCapture([{ kind: 'label', text: 'Pokédex' }], 'de', 'en');
    dict.restoreEntry(removed);
    expect(dict.stats().total).toBe(1);
  });
});

describe('eviction', () => {
  it('drops one-off untranslated entries first and never words on cards or looked up', () => {
    const col = db.collection('dict');
    const old = 1_000_000;
    const list = [];
    for (let i = 0; i < dict.MAX_ENTRIES - 3; i++) {
      list.push({ id: 'n' + i, kind: 'word', text: 'noise' + i, src: 'de', translations: {}, count: 1, firstSeen: old + i, lastSeen: old + 1000 + i, lookedUp: false });
    }
    list.push({ id: 'kampf', kind: 'word', text: 'KAMPF', src: 'de', translations: { en: 'FIGHT' }, count: 50, firstSeen: old, lastSeen: old, lookedUp: false });
    list.push({ id: 'looked', kind: 'word', text: 'Beutel', src: 'de', translations: {}, count: 1, firstSeen: old, lastSeen: 1, lookedUp: true });
    list.push({ id: 'carded', kind: 'word', text: 'Trank', src: 'de', translations: {}, count: 1, firstSeen: old, lastSeen: 1, lookedUp: false });
    col.putMany(list);
    srs.addCard({ text: 'Trank', translation: 'Potion', src: 'de', tgt: 'en' });
    dict.recordCapture([{ kind: 'label', text: 'Neuwort' }], 'de', 'en');
    expect(col.size()).toBe(4750);
    for (const id of ['kampf', 'looked', 'carded']) expect(col.has(id)).toBe(true);
    expect(col.has('n0')).toBe(false); // oldest noise went first
    expect(dict.search({ q: 'neuwort' }).total).toBe(1);
  });
});

describe('sanitizeEntry', () => {
  it('upgrades v1 entries to per-target translations', () => {
    const v1 = { id: '1759650000001-x1y2', key: 'de|wildes', kind: 'word', text: 'wildes', translation: 'wild', lang: 'de', tgt: 'en', count: 3, firstSeen: 1, lastSeen: 2, pending: false };
    expect(dict.sanitizeEntry(v1)).toEqual({ id: v1.id, kind: 'word', text: 'wildes', src: 'de', translations: { en: 'wild' }, count: 3, firstSeen: 1, lastSeen: 2, lookedUp: false });
    const noTgt = { ...v1, tgt: undefined };
    expect(dict.sanitizeEntry(noTgt, { fallbackTgt: 'es' }).translations).toEqual({ es: 'wild' });
    const pending = { ...v1, translation: '' };
    expect(dict.sanitizeEntry(pending).translations).toEqual({});
  });

  it('scrubs cached engine errors and rejects hostile records', () => {
    const poisoned = { id: 'd1', kind: 'line', text: 'Hallo', lang: 'de', tgt: 'en', translation: 'Mymemory warning: you used all available free translations for today.' };
    expect(dict.sanitizeEntry(poisoned).translations).toEqual({});
    expect(dict.sanitizeEntry({ id: '"><img src=x>', kind: 'word', text: 'a', src: 'de' })).toBe(null);
    expect(dict.sanitizeEntry({ id: 'd2', kind: 'evil', text: 'a', src: 'de' })).toBe(null);
    const odd = dict.sanitizeEntry({ id: 'd3', kind: 'word', text: 'Hallo', src: 'de', count: '"><img>', translations: { en: 5, '<x>': 'y', fr: 'Salut' } });
    expect(odd).toMatchObject({ count: 1, translations: { fr: 'Salut' } });
  });
});

describe('importEntries', () => {
  it('merges by identity', () => {
    dict.recordCapture([{ kind: 'label', text: 'Trank' }], 'de', 'en');
    const n = dict.importEntries([
      { id: 'x1', kind: 'word', text: 'trank', src: 'de', translations: { en: 'Potion' }, count: 9, firstSeen: 1, lastSeen: 2, lookedUp: false },
      { id: 'x2', kind: 'word', text: 'Beere', src: 'de', translations: {}, count: 1, firstSeen: 1, lastSeen: 2, lookedUp: false }
    ]);
    expect(n).toBe(2);
    const trank = dict.search({ q: 'trank' }).items[0];
    expect(trank).toMatchObject({ text: 'Trank', translation: 'Potion', count: 9 });
    expect(dict.stats().total).toBe(2);
  });
});
