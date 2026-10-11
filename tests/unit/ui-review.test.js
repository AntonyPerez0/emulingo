// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Let pending screen-reader announcements (filled after 100 ms) land before teardown.
afterAll(() => wait(150));
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 11, 15, 0).getTime(); // Sunday 11 October 2026, 15:00

let db;
let srs;
let view;
let mod;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = await import('../../src/core/db.js');
  await db.initDb();
  srs = await import('../../src/core/srs.js');
  mod = await import('../../src/ui/views/review.js');
  view = mod.default;
});

let section;

function mount() {
  document.body.innerHTML = `<main id="main"><section data-view="review"></section></main>
    <div id="sr-status" role="status"></div><div id="sr-alert" role="alert"></div>`;
  document.body.dataset.view = 'review';
  section = document.querySelector('section[data-view="review"]');
  mod._resetForTests();
  view.mount(section);
  view.show();
}

function add(text, translation, extra = {}) {
  const { card } = srs.addCard({ text, translation, src: 'de', tgt: 'en' });
  if (Object.keys(extra).length) {
    // Shape a card as if it had been reviewed before (records are frozen: copy).
    srs.importCards([{ ...card, ...extra }], { mode: 'merge' });
  }
  return srs.getCard(card.id);
}

const $ = (sel) => section.querySelector(sel);
const visible = (sel) => { const n = $(sel); return !!n && !n.closest('[hidden]'); };
const key = (k, target = document.body, type = 'keydown') => target.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
const press = (k, target) => { key(k, target); key(k, target, 'keyup'); };
const status = async () => { await wait(120); return document.getElementById('sr-status').textContent; };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  srs.clearAll();
  srs.importActivity([], { mode: 'replace' });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('start screen', () => {
  it('empty deck: explains auto-add and links to Play', () => {
    mount();
    expect($('[data-r="start"]').textContent).toContain('Your deck is empty');
    expect($('[data-r="start"] a[href="#/play"]').textContent).toContain('Go to Play');
    expect(visible('[data-r="session"]')).toBe(false);
  });

  it('shows how many cards are due with a breakdown', () => {
    add('Hallo', 'Hello');
    add('Tschüss', 'Bye');
    mount();
    expect($('.review-start__title').textContent).toBe('2 cards to review');
    expect($('.review-start__detail').textContent).toContain('2 new');
    expect($('[data-action="start"]')).not.toBeNull();
  });

  it('all caught up: next review time and Study ahead', () => {
    const c = add('Hallo', 'Hello', { seen: 1, reps: 1, interval: 3 * DAY, due: NOW + 3 * 3600_000, lastResult: 2 });
    expect(c.seen).toBe(1);
    mount();
    const start = $('[data-r="start"]');
    expect(start.textContent).toContain('All caught up');
    expect(start.textContent).toContain('Your next review is in 3 hours.');
    expect($('[data-action="ahead"]').textContent).toContain('Study ahead');
  });
});

describe('waking up', () => {
  it('the caught-up screen refreshes itself when a card falls due', async () => {
    add('Hallo', 'Hello', { seen: 1, reps: 0, interval: 600_000, due: NOW + 1000, lastResult: 0 });
    mount();
    expect($('[data-r="start"]').textContent).toContain('All caught up');
    $('[data-r="start"] a[href="#/play"]').focus();
    vi.setSystemTime(NOW + 2000);
    await wait(1700);
    expect($('.review-start__title').textContent).toBe('1 card to review');
    expect(document.activeElement).toBe($('[data-action="start"]')); // focus stays in the redrawn screen
    expect(await status()).toBe('1 card ready to review.');
    view.hide();
  });
});

describe('session flow', () => {
  beforeEach(() => {
    add('Hallo', 'Hello');
    add('Tschüss', 'Bye');
    add('Danke', 'Thanks');
    mount();
  });

  it('start → focus on Show answer, progress and announcement', async () => {
    $('[data-action="start"]').click();
    expect(visible('[data-r="session"]')).toBe(true);
    expect(document.activeElement).toBe($('[data-r="reveal"]'));
    expect($('[data-r="pos"]').textContent).toBe('Card 1 of 3');
    const bar = $('[role="progressbar"]');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    const front = $('[data-r="front"]');
    expect(front.getAttribute('lang')).toBe('de');
    expect(front.textContent).toBe('Hallo');
    expect(await status()).toBe('Card 1 of 3: Hallo');
  });

  it('Space reveals, focuses Good, shows intervals; 3 grades Good and moves on', async () => {
    $('[data-action="start"]').click();
    press(' ');
    expect(visible('[data-r="answer"]')).toBe(true);
    expect(visible('[data-r="reveal"]')).toBe(false);
    expect(document.activeElement).toBe($('[data-q="2"]'));
    expect($('[data-r="back"]').getAttribute('lang')).toBe('en');
    expect($('[data-r="iv0"]').textContent).toBe('10 min');
    expect($('[data-r="iv2"]').textContent).toBe('1 day');
    expect($('[data-r="iv3"]').textContent).toBe('4 days');
    expect(await status()).toBe('Answer: Hello');

    press('3');
    const graded = srs.findCard('Hallo', 'de', 'en');
    expect(graded.reps).toBe(1);
    expect(graded.due).toBeGreaterThan(NOW);
    expect($('[data-r="pos"]').textContent).toBe('Card 2 of 3');
    expect($('[data-r="front"]').textContent).toBe('Tschüss');
    expect(document.activeElement).toBe($('[data-r="reveal"]'));
    expect(visible('[data-r="answer"]')).toBe(false);
    expect(await status()).toBe('Card 2 of 3: Tschüss');
  });

  it('grade keys do nothing before the answer is shown', () => {
    $('[data-action="start"]').click();
    press('3');
    expect($('[data-r="pos"]').textContent).toBe('Card 1 of 3');
    expect(srs.findCard('Hallo', 'de', 'en').seen).toBe(0);
  });

  it('Again re-queues the UPDATED card later in the session', () => {
    $('[data-action="start"]').click();
    press(' ');
    press('1'); // Hallo → Again
    expect($('[data-r="pos"]').textContent).toBe('Card 2 of 4');
    const after = srs.findCard('Hallo', 'de', 'en');
    expect(after.lastResult).toBe(0);
    expect(after.lapses).toBe(0); // a new card failing is not a lapse
    press(' '); press('3'); // Tschüss
    press(' '); press('3'); // Danke
    expect($('[data-r="front"]').textContent).toBe('Hallo');
    expect($('[data-r="pos"]').textContent).toBe('Card 4 of 4');
    press(' ');
    expect($('[data-r="iv2"]').textContent).toBe('1 day'); // previews come from the post-Again card
    press('3');
    expect(srs.findCard('Hallo', 'de', 'en').reps).toBe(1);
    // Finished
    expect(visible('[data-r="done"]')).toBe(true);
    expect($('.review-done__summary').textContent).toContain('You reviewed 3 cards');
    const counts = [...section.querySelectorAll('.review-done__count dd')].map((n) => n.textContent);
    expect(counts).toEqual(['1', '0', '3', '0']);
    expect(document.activeElement).toBe($('[data-r="done-title"]'));
  });

  it('clicking a grade button works like the key', () => {
    $('[data-action="start"]').click();
    $('[data-action="reveal"]').click();
    $('[data-q="3"]').click();
    expect(srs.findCard('Hallo', 'de', 'en').lastResult).toBe(3);
    expect(document.activeElement).toBe($('[data-r="reveal"]'));
  });

  it('a held Enter can’t grade the card it just revealed', () => {
    $('[data-action="start"]').click();
    key('Enter', $('[data-r="reveal"]')); // held down…
    $('[data-r="reveal"]').click(); // …native activation
    expect(document.activeElement).toBe($('[data-q="2"]'));
    $('[data-q="2"]').click(); // auto-repeat activation while still held
    expect($('[data-r="pos"]').textContent).toBe('Card 1 of 3');
    key('Enter', document.activeElement, 'keyup');
    $('[data-q="2"]').click();
    expect($('[data-r="pos"]').textContent).toBe('Card 2 of 3');
  });

  it('a Space that revealed the answer can’t press Good when it is released', () => {
    $('[data-action="start"]').click();
    const h1 = section.querySelector('h1');
    h1.focus();
    key(' ', h1); // shortcut: reveal on keydown, focus moves to Good
    expect(document.activeElement).toBe($('[data-q="2"]'));
    const release = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(true); // no activation of Good on release
    // A fresh Space press on Good is a normal button press again.
    key(' ', document.activeElement);
    const second = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  it('S speaks the front in its own language', () => {
    const spoken = [];
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(text) { this.text = text; } });
    vi.stubGlobal('speechSynthesis', { speak: (u) => spoken.push(u), cancel() {}, getVoices: () => [], speaking: false, pending: false, addEventListener() {} });
    $('[data-action="start"]').click(); // renders the card with speech available
    expect(visible('[data-r="listen"]')).toBe(true);
    press('s');
    const u = spoken.find((x) => x.text === 'Hallo');
    expect(u).toBeTruthy();
    expect(u.lang).toMatch(/^de/);
    vi.unstubAllGlobals();
  });

  it('the session survives leaving and coming back', () => {
    $('[data-action="start"]').click();
    press(' '); press('3');
    press(' ');
    view.hide();
    view.show();
    expect(visible('[data-r="session"]')).toBe(true);
    expect($('[data-r="pos"]').textContent).toBe('Card 2 of 3');
    expect(visible('[data-r="answer"]')).toBe(true);
    press('3');
    expect($('[data-r="pos"]').textContent).toBe('Card 3 of 3');
  });

  it('a card deleted elsewhere drops out of the session', () => {
    $('[data-action="start"]').click();
    view.hide();
    srs.removeCard(srs.findCard('Hallo', 'de', 'en').id);
    view.show();
    expect($('[data-r="front"]').textContent).toBe('Tschüss');
    expect($('[data-r="pos"]').textContent).toBe('Card 1 of 2');
  });

  it('End session shows the summary after some answers', () => {
    $('[data-action="start"]').click();
    press(' '); press('3');
    $('[data-action="end"]').click();
    expect(visible('[data-r="done"]')).toBe(true);
    expect($('.review-done__summary').textContent).toContain('1 card');
    expect($('[data-r="done"]').textContent).toContain('Review 2 more');
  });
});

describe('editing the translation', () => {
  beforeEach(async () => {
    add('Hallo', 'Helo');
    mount();
    $('[data-action="start"]').click();
    press(' ');
    await wait(120); // let earlier announcements flush
  });

  it('Edit → type → Enter saves and returns focus to Edit', async () => {
    $('[data-action="edit"]').click();
    const input = $('#review-edit-input');
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Helo');
    expect(input.getAttribute('lang')).toBe('en');
    // Digits typed in the field are text, not grade shortcuts.
    press('1', input);
    expect(visible('[data-r="session"]')).toBe(true);
    expect(srs.findCard('Hallo', 'de', 'en').seen).toBe(0);
    input.value = 'Hello';
    $('[data-r="edit"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(srs.findCard('Hallo', 'de', 'en').translation).toBe('Hello');
    expect($('[data-r="back"]').textContent).toBe('Hello');
    expect(visible('[data-r="edit"]')).toBe(false);
    expect(document.activeElement).toBe($('[data-r="edit-btn"]'));
    expect(await status()).toBe('Translation saved.');
  });

  it('Escape cancels', () => {
    $('[data-action="edit"]').click();
    const input = $('#review-edit-input');
    input.value = 'nope';
    key('Escape', input);
    expect(visible('[data-r="edit"]')).toBe(false);
    expect(srs.findCard('Hallo', 'de', 'en').translation).toBe('Helo');
    expect(document.activeElement).toBe($('[data-r="edit-btn"]'));
  });
});

describe('translating a card', () => {
  it('the Translate button is busy only for the card being translated', async () => {
    let resolveFetch;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { resolveFetch = r; })));
    add('Hallo', '');
    add('Tschüss', '');
    mount();
    $('[data-action="start"]').click();
    press(' ');
    const btn = $('[data-r="translate"]');
    expect(visible('[data-r="translate"]')).toBe(true);
    btn.focus();
    btn.click();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.textContent).toContain('Translating…');
    // Move on before the answer arrives: the next card's button is idle.
    $('[data-q="2"]').click();
    press(' ');
    expect($('[data-r="front"]').textContent).toBe('Tschüss');
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(btn.textContent).toContain('Translate');
    expect(btn.textContent).not.toContain('Translating');
    // The late answer still lands on the first card, without touching this one.
    const focused = document.activeElement;
    resolveFetch({ ok: true, status: 200, json: async () => [[['Hello', 'Hallo']], null, 'de'] });
    await wait(20);
    expect(srs.findCard('Hallo', 'de', 'en').translation).toBe('Hello');
    expect($('[data-r="back"]').textContent).toBe('No translation yet');
    expect(document.activeElement).toBe(focused);
    vi.unstubAllGlobals();
  });
});

describe('new cards turned off', () => {
  it('explains why new cards never come due', async () => {
    const { store } = await import('../../src/core/store.js');
    store.set('newPerDay', 0);
    add('Hallo', 'Hello');
    add('Tschüss', 'Bye');
    mount();
    const start = $('[data-r="start"]').textContent;
    expect(start).toContain('All caught up');
    expect(start).toContain('2 new cards are waiting, but “New cards per day” is set to 0 in Settings.');
    expect(start).not.toContain('Play to collect more');
    store.set('newPerDay', 20);
  });
});

describe('study ahead', () => {
  it('practises cards that aren’t due without moving their schedule', () => {
    const due = NOW + 5 * DAY;
    add('Hallo', 'Hello', { seen: 2, reps: 2, interval: 6 * DAY, due, lastResult: 2 });
    mount();
    $('[data-action="ahead"]').click();
    expect(visible('[data-r="mode"]')).toBe(true);
    press(' ');
    expect($('[data-r="iv2"]').textContent).toBe('No change');
    expect($('[data-r="iv0"]').textContent).toBe('10 min');
    press('3');
    const c = srs.findCard('Hallo', 'de', 'en');
    expect(c.due).toBe(due);
    expect(c.seen).toBe(3);
    expect($('.review-done__summary').textContent).toContain('Your schedule didn’t change.');
    expect($('[data-action="again"]').textContent).toContain('Review again');
  });
});

describe('study ahead with Again', () => {
  it('says honestly that a missed card was rescheduled', () => {
    const due = NOW + 5 * DAY;
    add('Hallo', 'Hello', { seen: 2, reps: 2, interval: 6 * DAY, due, lastResult: 2 });
    add('Danke', 'Thanks', { seen: 2, reps: 2, interval: 6 * DAY, due: due + DAY, lastResult: 2 });
    mount();
    $('[data-action="ahead"]').click();
    expect($('[data-r="mode"]').textContent).toContain('only Again changes your schedule');
    press(' '); press('1'); // Hallo: Again moves it to 10 minutes from now
    press(' '); press('3'); // Danke: Good keeps its schedule
    press(' '); press('3'); // Hallo again, now (almost) due in 10 min: still not due, no change
    expect(srs.findCard('Danke', 'de', 'en').due).toBe(due + DAY);
    expect(srs.findCard('Hallo', 'de', 'en').due).toBe(NOW + 10 * 60_000);
    expect($('.review-done__summary').textContent).toBe('You practiced 2 cards in under a minute. 1 card was rescheduled.');
  });
});

describe('helpers', () => {
  it('requeue inserts a few places later, or at the end', () => {
    expect(mod.requeue(['b', 'c', 'd', 'e'], 'a', 3)).toEqual(['b', 'c', 'd', 'a', 'e']);
    expect(mod.requeue(['b'], 'a', 3)).toEqual(['b', 'a']);
    expect(mod.requeue([], 'a', 3)).toEqual(['a']);
  });

  it('frontSize and estimateText', () => {
    expect(mod.frontSize('Hallo')).toBe('xl');
    expect(mod.frontSize('Ein wildes TAUBSI erscheint!')).toBe('lg');
    expect(mod.frontSize('x'.repeat(80))).toBe('md');
    expect(mod.estimateText(3)).toBe('under a minute');
    expect(mod.estimateText(30)).toBe('about 4 min');
  });

  it('registers view-scoped shortcuts with labels for the help dialog', async () => {
    const a11y = await import('../../src/ui/a11y.js');
    const mine = a11y.listShortcuts().filter((s) => s.scope === 'review');
    const labels = new Set(mine.map((s) => s.label));
    for (const l of ['Show answer', 'Answer Again', 'Answer Hard', 'Answer Good', 'Answer Easy', 'Listen to the card']) expect(labels.has(l)).toBe(true);
  });

  it('hides key hints when single-key shortcuts are off', async () => {
    const { store } = await import('../../src/core/store.js');
    add('Hallo', 'Hello');
    mount();
    store.set('shortcuts', false);
    expect($('[data-review]').hasAttribute('data-no-shortcuts')).toBe(true);
    expect($('[data-action="start"]').hasAttribute('aria-keyshortcuts')).toBe(false);
    $('[data-action="start"]').click();
    press(' ');
    expect(visible('[data-r="answer"]')).toBe(false);
    store.set('shortcuts', true);
  });
});
