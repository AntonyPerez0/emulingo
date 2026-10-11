// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Let pending screen-reader announcements (filled after 100 ms) land before teardown.
afterAll(() => wait(150));
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 11, 15, 0).getTime(); // Sunday 11 October 2026

let db;
let srs;
let mod;
let view;
let toastMod;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = await import('../../src/core/db.js');
  await db.initDb();
  srs = await import('../../src/core/srs.js');
  toastMod = await import('../../src/ui/toast.js');
  mod = await import('../../src/ui/views/deck.js');
  view = mod.default;
});

let section;
const $ = (sel) => section.querySelector(sel);
const $$ = (sel) => [...section.querySelectorAll(sel)];
const rows = () => $$('.lv-row');

function mount() {
  document.body.innerHTML = `<main id="main"><section data-view="deck"></section></main>
    <section id="toast-region"></section><div id="sr-status" role="status"></div><div id="sr-alert" role="alert"></div>`;
  document.body.dataset.view = 'deck';
  section = document.querySelector('section[data-view="deck"]');
  view.mount(section);
  view.show();
}

function add(text, translation, extra = {}) {
  const { card } = srs.addCard({ text, translation, src: 'de', tgt: 'en' });
  if (Object.keys(extra).length) srs.importCards([{ ...card, ...extra }], { mode: 'merge' });
  return srs.getCard(card.id);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  srs.clearAll();
  srs.importActivity([], { mode: 'replace' });
  toastMod.dismissAllToasts();
});

afterEach(() => {
  view.hide();
  vi.useRealTimers();
});

describe('empty deck', () => {
  it('shows an empty state with a way forward and no toolbar or stats', () => {
    mount();
    expect($('.empty-state').textContent).toContain('No cards yet');
    expect($('a[href="#/play"]')).not.toBeNull();
    expect($('[data-lv-search]')).toBeNull();
    expect($('.lv-stats')).toBeNull();
  });
});

describe('populated deck', () => {
  beforeEach(() => {
    add('Hallo', 'Hello');
    add('Tschüss', 'Bye', { seen: 3, reps: 3, interval: 30 * DAY, due: NOW + 9 * DAY, lastResult: 2 });
    add('Danke', 'Thanks', { seen: 1, reps: 1, interval: DAY, due: NOW - 3600_000, lastResult: 2 });
    add('=SUMME(A1)', '', {});
    srs.importActivity([{ id: '2026-10-09', count: 4 }, { id: '2026-10-11', count: 2 }], { mode: 'replace' });
    mount();
  });

  it('shows stats, the review shortcut and an accessible 7-day chart', () => {
    const stats = $$('.lv-stats .stat').map((s) => `${s.querySelector('dt').textContent.trim()}=${s.querySelector('dd').textContent}`);
    expect(stats).toEqual(['To review=3', 'Cards=4', 'Mature=1', 'Day streak=1']);
    expect($('[data-deck-actions] a[href="#/review"]').textContent).toContain('Review 3 cards');
    const chart = $('.week-chart');
    expect(chart.getAttribute('aria-hidden')).toBe('true');
    expect($$('.week-chart__day').map((d) => d.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Today']);
    const table = $('table');
    expect(table.querySelector('caption').textContent).toContain('last 7 days');
    const cells = [...table.querySelectorAll('tbody tr')].map((tr) => `${tr.querySelector('th').textContent}|${tr.querySelector('td').textContent}`);
    expect(cells).toHaveLength(7);
    expect(cells[4]).toBe('Friday, October 9|4');
    expect(cells[6]).toBe('Today, Sunday, October 11|2');
    expect($('.deck-week__summary').textContent).toBe('6 reviews this week · most on Fri');
  });

  it('rows carry languages, plain-language chips and labelled actions', () => {
    const row = rows().find((r) => r.querySelector('.lv-term').textContent === 'Tschüss');
    expect(row.querySelector('.lv-term').getAttribute('lang')).toBe('de');
    expect(row.querySelector('.lv-translation').getAttribute('lang')).toBe('en');
    const meta = row.querySelector('.lv-row__meta').textContent;
    expect(meta).toContain('Mature');
    expect(meta).toContain('Next review in 9 days');
    expect(meta).not.toMatch(/ease|interval/i);
    const labels = [...row.querySelectorAll('[data-action]')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Edit translation of “Tschüss”', 'Delete “Tschüss”']);
    const danke = rows().find((r) => r.querySelector('.lv-term').textContent === 'Danke');
    expect(danke.querySelector('.lv-row__meta').textContent).toContain('Due now');
    const empty = rows().find((r) => r.querySelector('.lv-term').textContent === '=SUMME(A1)');
    expect(empty.querySelector('.lv-translation--empty').textContent).toBe('No translation yet');
  });

  it('filters by stage', () => {
    const opt = (label) => $$('.segmented__option').find((b) => b.textContent.trim() === label);
    opt('Mature').click();
    expect(rows().map((r) => r.querySelector('.lv-term').textContent)).toEqual(['Tschüss']);
    expect($('[data-lv-count]').textContent).toBe('1 of 4 cards');
    opt('New').click();
    expect(rows()).toHaveLength(2);
    opt('To review').click();
    expect(rows()[0].querySelector('.lv-term').textContent).toBe('Danke'); // waiting longest first
    expect(rows()).toHaveLength(3);
  });

  it('searches front and back, ignoring accents and case', async () => {
    const input = $('[data-lv-search]');
    input.value = 'tschuss';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    expect(rows().map((r) => r.querySelector('.lv-term').textContent)).toEqual(['Tschüss']);
    input.value = 'THANKS';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    expect(rows().map((r) => r.querySelector('.lv-term').textContent)).toEqual(['Danke']);
  });

  it('delete is optimistic, focuses the next row and can be undone', async () => {
    const before = rows().map((r) => r.dataset.key);
    const target = rows()[1];
    const del = target.querySelector('[data-action="delete"]');
    del.focus();
    del.click();
    expect(srs.totalCards()).toBe(3);
    expect(rows().map((r) => r.dataset.key)).toEqual(before.filter((k) => k !== target.dataset.key));
    expect(document.activeElement).toBe(rows()[1].querySelector('button'));
    expect($$('.lv-stats dd')[1].textContent).toBe('3');
    const undo = document.querySelector('.toast__action');
    expect(undo.textContent).toBe('Undo');
    expect(document.querySelector('.toast__message').textContent).toContain('Deleted “');
    undo.click();
    await wait(0);
    expect(srs.totalCards()).toBe(4);
    expect(document.activeElement.closest('li').dataset.key).toBe(target.dataset.key);
  });

  it('Ctrl+Z undoes the last delete while its toast is showing', () => {
    const target = rows()[1];
    target.querySelector('[data-action="delete"]').click();
    expect(srs.totalCards()).toBe(3);
    // Typing in the search keeps the field's own undo.
    const search = $('[data-lv-search]');
    const inField = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    search.dispatchEvent(inField);
    expect(inField.defaultPrevented).toBe(false);
    expect(srs.totalCards()).toBe(3);
    const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(srs.totalCards()).toBe(4);
    expect(document.activeElement.closest('li').dataset.key).toBe(target.dataset.key);
    expect(document.querySelector('.toast__action')?.closest('[data-leaving]') || !document.querySelector('.toast__action')).toBeTruthy();
    // Nothing left to undo: the key passes through.
    const again = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
    expect(srs.totalCards()).toBe(4);
  });

  it('Undo after leaving the Deck restores the card without moving focus', async () => {
    rows()[0].querySelector('[data-action="delete"]').click();
    expect(srs.totalCards()).toBe(3);
    view.hide();
    section.hidden = true; // the router hides the section
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    document.querySelector('.toast__action').click();
    await wait(0);
    expect(srs.totalCards()).toBe(4);
    expect(section.contains(document.activeElement)).toBe(false);
    section.hidden = false;
  });

  it('deep links set the filter and the search', () => {
    view.show({ filter: 'mature' });
    expect($$('.segmented__option').find((b) => b.dataset.value === 'mature').getAttribute('aria-pressed')).toBe('true');
    expect(rows().map((r) => r.querySelector('.lv-term').textContent)).toEqual(['Tschüss']);
    view.show({ q: 'dank', filter: 'all' });
    expect($('[data-lv-search]').value).toBe('dank');
    expect(rows().map((r) => r.querySelector('.lv-term').textContent)).toEqual(['Danke']);
    expect($('[data-lv-action="clear"]').hidden).toBe(false);
  });

  it('deleting the last card shows the empty state and focuses the heading', () => {
    for (const c of srs.cards().slice(1)) srs.removeCard(c.id);
    view.show();
    rows()[0].querySelector('[data-action="delete"]').click();
    expect($('.empty-state').textContent).toContain('No cards yet');
    expect(document.activeElement).toBe($('h1'));
  });

  it('edits a translation inline', async () => {
    const row = rows().find((r) => r.querySelector('.lv-term').textContent === '=SUMME(A1)');
    const key = row.dataset.key;
    row.querySelector('[data-action="edit"]').click();
    const input = section.querySelector(`li[data-key="${key}"] input`);
    expect(document.activeElement).toBe(input);
    input.value = 'SUM(A1)';
    input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await wait(0);
    expect(srs.getCard(key).translation).toBe('SUM(A1)');
    const fresh = section.querySelector(`li[data-key="${key}"]`);
    expect(fresh.querySelector('.lv-translation').textContent).toBe('SUM(A1)');
    expect(document.activeElement).toBe(fresh.querySelector('[data-action="edit"]'));
  });

  it('exports CSV with formula injection neutralised', async () => {
    const blobs = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (b) => { blobs.push(b); return 'blob:x'; }, revokeObjectURL() {} }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}); // jsdom can't download
    $('[data-menu-trigger]').click();
    section.querySelector('[role="menuitem"][data-action="export-csv"]').click();
    expect(blobs).toHaveLength(1);
    const text = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsText(blobs[0]); });
    expect(text).toContain('"\'=SUMME(A1)"');
    expect(click).toHaveBeenCalled();
    expect(document.querySelector('.toast__message').textContent).toBe('Exported 4 cards.');
    vi.unstubAllGlobals();
  });
});

describe('paging', () => {
  it('shows 100 rows, then more', () => {
    for (let i = 0; i < 130; i++) add(`Wort ${i}`, `word ${i}`);
    mount();
    expect(rows()).toHaveLength(100);
    expect($('[data-lv-count]').textContent).toBe('130 cards');
    $('[data-lv-action="more"]').click();
    expect(rows()).toHaveLength(130);
  });
});

describe('helpers', () => {
  it('stageOf, dueLabel and filterCards', () => {
    const fresh = { id: 'a', text: 'a', translation: '', seen: 0, interval: 0, due: NOW };
    const learning = { id: 'b', text: 'b', translation: '', seen: 2, interval: 3 * DAY, due: NOW + DAY };
    const mature = { id: 'c', text: 'c', translation: '', seen: 9, interval: 40 * DAY, due: NOW - 1 };
    expect([fresh, learning, mature].map(mod.stageOf)).toEqual(['new', 'learning', 'mature']);
    expect(mod.dueLabel(fresh, NOW)).toBeNull();
    expect(mod.dueLabel(learning, NOW)).toBe('Next review tomorrow');
    expect(mod.dueLabel(mature, NOW)).toBe('Due now');
    expect(mod.filterCards([fresh, learning, mature], { filter: 'learning' }).map((c) => c.id)).toEqual(['b']);
    expect(mod.exportFileName('csv', new Date(2026, 0, 5))).toBe('emulingo-deck-2026-01-05.csv');
  });
});
