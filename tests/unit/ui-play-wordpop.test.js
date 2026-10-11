// @vitest-environment jsdom
// Word look-up popover (src/ui/views/play/wordpop.js).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
afterAll(() => wait(150));

const fake = vi.hoisted(() => ({ lookups: [], cards: [], spoken: [] }));

vi.mock('../../src/core/dictionary.js', () => ({
  // resolves when the test says so: fake.lookups[i].resolve(...)
  lookupWord: (term, src, tgt) => new Promise((resolve, reject) => { fake.lookups.push({ term, src, tgt, resolve, reject }); })
}));
vi.mock('../../src/core/srs.js', () => ({
  addCard: (card) => {
    const dup = fake.cards.some((c) => c.text === card.text);
    if (!dup) fake.cards.push(card);
    return { status: dup ? 'duplicate' : 'added', card };
  }
}));
vi.mock('../../src/core/tts.js', () => ({
  supported: () => true,
  speak: (text, lang) => { fake.spoken.push([text, lang]); return true; }
}));

const { createWordPopover } = await import('../../src/ui/views/play/wordpop.js');

describe('word popover', () => {
  let pop;
  let word;
  let changes;
  let cardsChanged;

  beforeEach(() => {
    if (pop) pop.close({ returnFocus: false });
    fake.lookups.length = 0;
    fake.cards.length = 0;
    fake.spoken.length = 0;
    document.body.innerHTML = `<div id="sr-status"></div><div id="sr-alert"></div>
      <p lang="de"><button class="word" id="w1">Hallo</button> <button class="word" id="w2">Welt</button></p>
      <button id="after">After</button><div id="host"></div>`;
    word = document.getElementById('w1');
    changes = [];
    cardsChanged = 0;
    pop = createWordPopover({ host: document.getElementById('host'), onChange: (o) => changes.push(o), onCardsChanged: () => { cardsChanged++; } });
  });

  const box = () => pop.element;

  it('opens as a labelled dialog next to the word, with focus on the word heading', () => {
    word.focus();
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    expect(box().hidden).toBe(false);
    expect(box().getAttribute('role')).toBe('dialog');
    const head = box().querySelector('h3');
    expect(box().getAttribute('aria-labelledby')).toBe(head.id);
    expect(head.getAttribute('lang')).toBe('de');
    expect(document.activeElement).toBe(head);
    expect(word.getAttribute('aria-expanded')).toBe('true');
    expect(word.getAttribute('aria-controls')).toBe(box().id);
    expect(box().textContent).toContain('Looking up');
    expect(changes).toEqual([true]);
  });

  it('shows the translation in the target language and announces it', async () => {
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    fake.lookups[0].resolve({ translation: 'Hello' });
    await wait(0);
    const tr = box().querySelector('.wordpop__trans');
    expect(tr.textContent).toBe('Hello');
    expect(tr.getAttribute('lang')).toBe('en');
    // focus survived the re-render
    expect(box().contains(document.activeElement)).toBe(true);
    await wait(150);
    expect(document.getElementById('sr-status').textContent).toContain('Hallo: Hello');
  });

  it('ignores a slower, older look-up', async () => {
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    const w2 = document.getElementById('w2');
    pop.open(w2, { term: 'Welt', src: 'de', tgt: 'en' });
    expect(word.getAttribute('aria-expanded')).toBe('false');
    fake.lookups[1].resolve({ translation: 'World' });
    await wait(0);
    fake.lookups[0].resolve({ translation: 'Hello' });
    await wait(0);
    expect(box().querySelector('h3').textContent).toBe('Welt');
    expect(box().querySelector('.wordpop__trans').textContent).toBe('World');
  });

  it('offers Try again when the look-up fails', async () => {
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    fake.lookups[0].reject(new Error('offline'));
    await wait(0);
    expect(box().textContent).toContain('Couldn’t look up this word');
    expect(box().querySelector('[data-action="wp-add"]').getAttribute('aria-disabled')).toBe('true');
    box().querySelector('[data-action="wp-retry"]').click();
    expect(fake.lookups).toHaveLength(2);
    fake.lookups[1].resolve({ translation: 'Hello' });
    await wait(0);
    expect(box().querySelector('.wordpop__trans').textContent).toBe('Hello');
  });

  it('closes with Escape and returns focus to the word', () => {
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(box().hidden).toBe(true);
    expect(document.activeElement).toBe(word);
    expect(word.getAttribute('aria-expanded')).toBe('false');
    expect(changes).toEqual([true, false]);
  });

  it('tabbing off either end goes back to the word', async () => {
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    fake.lookups[0].resolve({ translation: 'Hello' });
    await wait(0);
    const add = box().querySelector('[data-action="wp-add"]');
    add.focus();
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(box().hidden).toBe(true);
    expect(document.activeElement).toBe(word);
    // Shift+Tab from the heading (where focus starts)
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(box().hidden).toBe(true);
    expect(document.activeElement).toBe(word);
  });

  it('moving within the popover keeps it open', async () => {
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    const close = box().querySelector('[data-action="wp-close"]');
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    close.focus();
    expect(box().hidden).toBe(false);
  });

  it('adds the word to the deck once and speaks it in the game language', async () => {
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    fake.lookups[0].resolve({ translation: 'Hello' });
    await wait(0);
    box().querySelector('[data-action="wp-listen"]').click();
    expect(fake.spoken).toEqual([['Hallo', 'de']]);
    const add = box().querySelector('[data-action="wp-add"]');
    add.click();
    expect(fake.cards).toEqual([{ text: 'Hallo', translation: 'Hello', src: 'de', tgt: 'en', origin: 'manual' }]);
    expect(cardsChanged).toBe(1);
    expect(add.textContent).toContain('Added to deck');
    expect(add.getAttribute('aria-disabled')).toBe('true');
  });

  it('closes, without moving focus, when the pointer goes down elsewhere', () => {
    pop.open(word, { term: 'Hallo', src: 'de', tgt: 'en' });
    const after = document.getElementById('after');
    after.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(box().hidden).toBe(true);
  });

  it('escapes the looked-up text', async () => {
    pop.open(word, { term: '<img src=x>', src: 'de', tgt: 'en' });
    fake.lookups[0].resolve({ translation: '<b>x</b>' });
    await wait(0);
    expect(box().querySelector('img, b')).toBe(null);
  });
});
