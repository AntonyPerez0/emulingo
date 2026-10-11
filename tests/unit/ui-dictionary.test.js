// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Let pending screen-reader announcements (filled after 100 ms) land before teardown.
afterAll(() => wait(150));

let db;
let srs;
let dict;
let mod;
let view;
let toastMod;
let translateMod;

const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });

// Google stub: "EN:<q>"; `fail` is a predicate on the query text.
function stubGoogle({ fail = () => false, offline = false } = {}) {
  const fn = vi.fn(async (url) => {
    if (offline) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const q = u.searchParams.get('q');
    if (u.hostname !== 'translate.googleapis.com' || fail(q)) return json(null, 500);
    return json([[[`${u.searchParams.get('tl').toUpperCase()}:${q}`, q]], null, 'de']);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = await import('../../src/core/db.js');
  await db.initDb();
  srs = await import('../../src/core/srs.js');
  dict = await import('../../src/core/dictionary.js');
  toastMod = await import('../../src/ui/toast.js');
  translateMod = await import('../../src/core/translate.js');
  mod = await import('../../src/ui/views/dictionary.js');
  view = mod.default;
});

let section;
const $ = (sel) => section.querySelector(sel);
const $$ = (sel) => [...section.querySelectorAll(sel)];
const rows = () => $$('.lv-row');
const rowFor = (text) => rows().find((r) => r.querySelector('.lv-term').textContent === text);
const toastText = () => [...document.querySelectorAll('.toast__message')].map((t) => t.textContent).join(' | ');

function mount() {
  document.body.innerHTML = `<main id="main"><section data-view="dictionary"></section></main>
    <section id="toast-region"></section><div id="sr-status" role="status"></div><div id="sr-alert" role="alert"></div>`;
  document.body.dataset.view = 'dictionary';
  section = document.querySelector('section[data-view="dictionary"]');
  view.mount(section);
  view.show();
}

beforeEach(() => {
  dict.clearAll();
  srs.clearAll();
  translateMod.clearTranslateCache();
  toastMod.dismissAllToasts();
  localStorage.clear();
});

afterEach(() => {
  view.hide();
  vi.unstubAllGlobals();
});

function seed() {
  dict.recordCapture([
    { text: 'Ein wildes TAUBSI erscheint!', kind: 'dialog', translation: 'A wild PIDGEY appears!' },
  ], 'de', 'en');
  // Words are seeded untranslated; give one a translation.
  const wild = dict.entries().find((e) => e.text === 'wildes');
  dict.setTranslation(wild.id, 'en', 'wild');
}

describe('empty dictionary', () => {
  it('shows an empty state, no bulk actions', () => {
    mount();
    expect($('.empty-state').textContent).toContain('Your dictionary is empty');
    expect($('[data-action="translate-all"]')).toBeNull();
    expect($('[data-lv-search]')).toBeNull();
  });
});

describe('populated dictionary', () => {
  beforeEach(() => {
    seed();
    mount();
  });

  it('stats, subtitle and rows with badges, languages and labelled actions', () => {
    const stats = $$('.lv-stats .stat').map((s) => `${s.querySelector('dt').textContent.trim()}=${s.querySelector('dd').textContent}`);
    expect(stats).toEqual(['Words=4', 'Sentences=1', 'Not translated yet=3']);
    expect($('[data-dict-subtitle]').textContent).toContain('translated into English');
    const line = rowFor('Ein wildes TAUBSI erscheint!');
    expect(line.querySelector('.badge').textContent).toBe('Sentence');
    expect(line.querySelector('.lv-translation').getAttribute('lang')).toBe('en');
    expect(line.querySelector('.lv-row__meta').textContent).toContain('Seen 1×');
    const labels = [...line.querySelectorAll('[data-action]')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Edit translation of “Ein wildes TAUBSI erscheint!”', 'Add “Ein wildes TAUBSI erscheint!” to deck', 'Delete “Ein wildes TAUBSI erscheint!”']);
    const pending = rowFor('TAUBSI');
    expect(pending.querySelector('.badge').textContent).toBe('Word');
    expect(pending.querySelector('.lv-translation--empty').textContent).toBe('Not translated yet');
    const tr = pending.querySelector('[data-action="translate"]');
    expect(tr.textContent.trim()).toBe('Translate');
    expect(tr.getAttribute('aria-label')).toBe('Translate “TAUBSI”');
  });

  it('filters words, sentences and untranslated entries', () => {
    const opt = (label) => $$('.segmented__option').find((b) => b.textContent.trim() === label);
    opt('Sentences').click();
    expect(rows().map((r) => r.querySelector('.lv-term').textContent)).toEqual(['Ein wildes TAUBSI erscheint!']);
    opt('Not translated').click();
    expect(rows()).toHaveLength(3);
    expect($('[data-lv-count]').textContent).toBe('3 of 5 entries');
    opt('Words').click();
    expect(rows()).toHaveLength(4);
  });

  it('sorts alphabetically', () => {
    const sort = $('[data-dict-sort]');
    sort.value = 'alpha';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
    const texts = rows().map((r) => r.querySelector('.lv-term').textContent);
    expect(texts).toEqual([...texts].sort((a, b) => a.localeCompare(b)));
  });

  it('Translate on a pending row translates it and moves focus to Edit', async () => {
    stubGoogle();
    const btn = rowFor('TAUBSI').querySelector('[data-action="translate"]');
    btn.focus();
    btn.click();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await wait(20);
    const row = rowFor('TAUBSI');
    expect(row.querySelector('.lv-translation').textContent).toBe('EN:TAUBSI');
    expect(document.activeElement).toBe(row.querySelector('[data-action="edit"]'));
    expect(dict.entries().find((e) => e.text === 'TAUBSI').count).toBe(1); // no count bump
    expect($$('.lv-stats dd')[2].textContent).toBe('2');
  });

  it('a failed row translation keeps the button and explains', async () => {
    stubGoogle({ offline: true });
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    const btn = rowFor('TAUBSI').querySelector('[data-action="translate"]');
    btn.click();
    await wait(30);
    expect(btn.isConnected).toBe(true);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(toastText()).toMatch(/offline|translate/i);
  });

  it('Translate new words: progress, then a summary that counts failures', async () => {
    stubGoogle({ fail: (q) => q === 'erscheint' });
    const btn = $('[data-action="translate-all"]');
    expect(btn.textContent).toContain('Translate new words');
    btn.click();
    const running = $('[data-action="translate-all"]');
    expect(running.getAttribute('aria-disabled')).toBe('true');
    expect(running.textContent).toMatch(/Translating \d of 3…/);
    expect($('[data-action="translate-stop"]')).not.toBeNull();
    running.click(); // ignored while running
    await wait(1200);
    expect(toastText()).toContain('Translated 2 of 3 entries. 1 entry couldn’t be translated');
    expect(dict.stats('en').pending).toBe(1);
    expect($('[data-action="translate-stop"]')).toBeNull();
    // The one that failed is still pending, so the button stays for another try.
    expect($('[data-action="translate-all"]').hasAttribute('aria-disabled')).toBe(false);
  });

  it('Stop ends the batch early', async () => {
    stubGoogle();
    $('[data-action="translate-all"]').click();
    $('[data-action="translate-stop"]').click();
    await wait(400);
    expect(toastText()).toMatch(/^Stopped\. Translated 1 of 3 entries\./);
  });

  it('entries deleted during a batch are skipped, not counted as failures', async () => {
    stubGoogle();
    $('[data-action="translate-all"]').click();
    // Delete another pending entry while the first request is in flight.
    const victim = dict.search({ filter: 'pending', tgt: 'en' }).items.find((e) => e.text === 'erscheint');
    dict.removeEntry(victim.id);
    await wait(800);
    expect(toastText()).toContain('Translated 2 entries.');
    expect(toastText()).not.toMatch(/couldn’t/);
  });

  it('changing the target language stops a running batch', async () => {
    const { store } = await import('../../src/core/store.js');
    stubGoogle();
    $('[data-action="translate-all"]').click();
    store.set('target', 'fr');
    await wait(500);
    expect(toastText()).toMatch(/^Stopped\. Translated 1 of 3 entries\./);
    // Rows show the new language: nothing from the English batch leaked in.
    expect(rows().every((r) => !r.querySelector('.lv-translation[lang="en"]'))).toBe(true);
    store.set('target', 'en');
  });

  it('deleting everything during a batch doesn’t leave a “Stopped” summary', async () => {
    stubGoogle();
    $('[data-action="translate-all"]').click();
    $('[data-menu-trigger]').click();
    section.querySelector('[role="menuitem"][data-action="clear"]').click();
    await wait(0);
    document.querySelector('dialog[open] .btn--danger').click();
    await wait(500);
    expect(toastText()).toContain('Deleted 5 entries.');
    expect(toastText()).not.toContain('Stopped');
    expect($('.empty-state')).not.toBeNull();
  });

  it('deep links set the search and the filter', () => {
    view.show({ q: 'TAUBSI', filter: 'line' });
    expect($('[data-lv-search]').value).toBe('TAUBSI');
    expect($$('.segmented__option').find((b) => b.dataset.value === 'line').getAttribute('aria-pressed')).toBe('true');
    expect(rows().map((r) => r.querySelector('.lv-term').textContent)).toEqual(['Ein wildes TAUBSI erscheint!']);
    view.show({ filter: 'nonsense' });
    expect($('[data-lv-search]').value).toBe('TAUBSI'); // unknown filters and missing params change nothing
  });

  it('Add to deck creates a card and marks the row', () => {
    const row = rowFor('Ein wildes TAUBSI erscheint!');
    row.querySelector('[data-action="add"]').click();
    expect(srs.findCard('Ein wildes TAUBSI erscheint!', 'de', 'en').translation).toBe('A wild PIDGEY appears!');
    const fresh = rowFor('Ein wildes TAUBSI erscheint!');
    expect(fresh.querySelector('[data-action="add"]')).toBeNull();
    expect(fresh.querySelector('.lv-row__meta').textContent).toContain('In deck');
    expect(document.activeElement).toBe(fresh.querySelector('[data-action="edit"]'));
    expect(toastText()).toContain('Added “Ein wildes TAUBSI erscheint!” to your deck.');
  });

  it('Add to deck on a pending word translates it first', async () => {
    stubGoogle();
    rowFor('TAUBSI').querySelector('[data-action="add"]').click();
    await wait(20);
    expect(srs.findCard('TAUBSI', 'de', 'en').translation).toBe('EN:TAUBSI');
  });

  it('delete with undo', () => {
    const row = rowFor('wildes');
    const next = rows()[rows().indexOf(row) + 1];
    row.querySelector('[data-action="delete"]').click();
    expect(rowFor('wildes')).toBeUndefined();
    expect(document.activeElement).toBe(rowFor(next.querySelector('.lv-term').textContent).querySelector('button'));
    document.querySelector('.toast__action').click();
    const back = dict.entries().find((e) => e.text === 'wildes');
    expect(back.translation).toBe('wild');
    expect(document.activeElement.closest('li').dataset.key).toBe(back.id);
  });

  it('inline edit saves a translation for the current target', async () => {
    const row = rowFor('wildes');
    row.querySelector('[data-action="edit"]').click();
    const input = rowFor('wildes').querySelector('input');
    input.value = 'wild (adj.)';
    input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await wait(0);
    expect(dict.entries().find((e) => e.text === 'wildes').translations).toEqual({ en: 'wild (adj.)' });
  });

  it('follows the target language', async () => {
    const { store } = await import('../../src/core/store.js');
    store.set('target', 'fr');
    expect($$('.lv-stats dd')[2].textContent).toBe('5');
    expect($('[data-dict-subtitle]').textContent).toContain('French');
    store.set('target', 'en');
  });
});

describe('helpers', () => {
  it('entriesCsv is formula safe; entriesTsv skips untranslated entries', () => {
    const list = [
      { text: '=1+1', kind: 'word', translations: { en: 'two' }, src: 'de', count: 2, firstSeen: 0, lastSeen: 0 },
      { text: 'Hallo', kind: 'line', translations: {}, src: 'de', count: 1, firstSeen: 0, lastSeen: 0 },
    ];
    const csv = mod.entriesCsv(list, 'en');
    expect(csv.startsWith('﻿"Text","Type"')).toBe(true);
    expect(csv).toContain('"\'=1+1","word","two"');
    expect(mod.entriesTsv(list, 'en')).toBe('=1+1\ttwo\n');
  });

  it('batchSummary is honest about failures', () => {
    expect(mod.batchSummary({ done: 3, failed: 0, total: 3 })).toEqual({ message: 'Translated 3 entries.', kind: 'success' });
    expect(mod.batchSummary({ done: 0, failed: 2, total: 2 }).kind).toBe('error');
    const offline = mod.batchSummary({ done: 1, failed: 1, total: 5, error: { message: 'You’re offline.' } });
    expect(offline).toEqual({ message: 'You’re offline. Translated 1 of 5 entries.', kind: 'warning' });
  });

  it('searchOptions maps the filter', () => {
    expect(mod.searchOptions('pending')).toEqual({ kind: 'all', filter: 'pending' });
    expect(mod.searchOptions('line')).toEqual({ kind: 'line', filter: 'all' });
  });
});
