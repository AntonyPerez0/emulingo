// @vitest-environment jsdom
// The OCR session (src/ui/views/play/session.js): what every capture is put
// to work for — history without duplicates, sentences for the dictionary
// and the deck, auto-speak — with the scanner, engine and network faked.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
afterAll(() => wait(150));

const fake = vi.hoisted(() => ({ scanner: null, spoken: [], translations: new Map(), translateCalls: [] }));

vi.mock('../../src/core/translate.js', () => ({
  translate: async (text, src, tgt) => {
    fake.translateCalls.push(text);
    if (fake.translations.has(text)) return fake.translations.get(text);
    return `[${tgt}] ${text}`;
  },
  detectLanguage: async () => null,
  isEngineErrorText: () => false
}));
vi.mock('../../src/core/tts.js', () => ({
  speak: (text, lang) => { fake.spoken.push([text, lang]); return true; },
  stop: () => {},
  supported: () => true
}));
vi.mock('../../src/core/emulator.js', () => ({ getCanvas: () => null, getVideoDims: () => null }));
vi.mock('../../src/core/ocr/capture.js', () => ({ createFrameSource: () => ({ grab: () => null }) }));
vi.mock('../../src/core/ocr/containers.js', () => ({ createContainerTracker: () => ({ update: () => [], setZone() {}, reset() {} }) }));
vi.mock('../../src/core/ocr/engine.js', () => ({
  createOcrEngine: () => ({ setPreference() {}, dispose() {}, prepare: async () => {}, supports: () => 'neural' })
}));
vi.mock('../../src/core/ocr/correct.js', () => ({
  correctText: async (t) => t, hasDictionary: () => false, warmSpeller: async () => {}
}));
vi.mock('../../src/core/scanner.js', () => ({
  createScanner: () => {
    const listeners = { status: new Set(), capture: new Set(), update: new Set() };
    const s = {
      resets: 0,
      on: (evt, fn) => { listeners[evt].add(fn); return () => listeners[evt].delete(fn); },
      emit: (evt, payload) => { for (const fn of listeners[evt]) fn(payload); },
      start() {}, stop() { s.stopped = true; }, pause() {}, resume() {},
      reset() { s.resets++; },
      scanNow: async () => null, setZone() {}, dismissHint() {}, noteEngineStatus() {},
      retryRegion: async () => true,
      getState: () => ({ status: { state: 'watching' } })
    };
    fake.scanner = s;
    return s;
  }
}));

let store;
let history;
let srs;
let dictionary;
let createOcrSession;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = await import('../../src/core/db.js');
  await db.initDb();
  ({ store } = await import('../../src/core/store.js'));
  history = await import('../../src/core/history.js');
  srs = await import('../../src/core/srs.js');
  dictionary = await import('../../src/core/dictionary.js');
  ({ createOcrSession } = await import('../../src/ui/views/play/session.js'));
});

let seq = 0;
function capture(text, over = {}) {
  return {
    id: over.id || `cap-${++seq}`,
    time: Date.now(),
    src: 'de',
    tgt: 'en',
    dialog: text == null ? null : { text, translation: '', status: 'pending' },
    others: [],
    conf: 0.95,
    ...over
  };
}

describe('OCR session', () => {
  let session;
  let added;

  beforeEach(() => {
    document.body.innerHTML = '<div id="sr-status"></div><div id="sr-alert"></div>';
    history.clear();
    srs.clearAll();
    dictionary.clearAll();
    fake.spoken.length = 0;
    fake.translateCalls.length = 0;
    fake.translations.clear();
    store.set('source', 'de');
    store.set('target', 'en');
    store.set('autoAdd', 'sentences');
    store.set('autoTts', false);
    store.set('announceLines', true);
    store.set('ocrPaused', false);
    added = [];
    session = createOcrSession({ onCardsAdded: (n) => added.push(n) });
    session.start();
  });

  it('keeps one history entry per line: added on capture, updated in place', () => {
    const c = capture('Hallo!');
    fake.scanner.emit('capture', c);
    fake.scanner.emit('update', { ...c, dialog: { text: 'Hallo!', translation: 'Hello!', status: 'done' } });
    const list = history.list();
    expect(list).toHaveLength(1);
    expect(list[0].dialog.translation).toBe('Hello!');
    session.dispose();
  });

  it('folds a line the scanner shows again (after a reset) into the entry already on top', () => {
    fake.scanner.emit('capture', capture('Willkommen in der Welt der Pokémon!'));
    const again = capture('Willkommen in der Welt der Pokémon!');
    fake.scanner.emit('capture', again);
    fake.scanner.emit('update', { ...again, dialog: { text: again.dialog.text, translation: 'Welcome!', status: 'done' } });
    const list = history.list();
    expect(list).toHaveLength(1);
    expect(list[0].dialog.translation).toBe('Welcome!');
    // in another language pair it is a line of its own
    fake.scanner.emit('capture', capture('Willkommen in der Welt der Pokémon!', { tgt: 'fr' }));
    expect(history.list()).toHaveLength(2);
    session.dispose();
  });

  it('turns each completed sentence into a dictionary line and a flashcard, once', async () => {
    const c = capture('Hallo! Ich bin Professor Eich. Wie heißt');
    fake.scanner.emit('capture', c);
    await wait(10);
    expect(srs.cards().map((x) => x.text).sort()).toEqual(['Hallo!', 'Ich bin Professor Eich.']);
    expect(added.at(-1)).toBe(2);
    // the box grows: only the new sentence is handled
    fake.scanner.emit('update', { ...c, dialog: { text: 'Hallo! Ich bin Professor Eich. Wie heißt du?', translation: '', status: 'pending' } });
    await wait(10);
    expect(srs.cards()).toHaveLength(3);
    expect(fake.translateCalls.filter((t) => t === 'Hallo!')).toHaveLength(1);
    const lines = dictionary.search({ kind: 'line', tgt: 'en' }).items.map((e) => e.text);
    expect(lines).toContain('Wie heißt du?');
    session.dispose();
  });

  it('counts an unpunctuated last sentence once the next line arrives', async () => {
    fake.scanner.emit('capture', capture('Du hast einen neuen Freund'));
    await wait(10);
    expect(srs.cards()).toHaveLength(0);
    fake.scanner.emit('capture', capture('Weiter geht es!'));
    await wait(10);
    expect(srs.cards().map((x) => x.text).sort()).toEqual(['Du hast einen neuen Freund', 'Weiter geht es!']);
    session.dispose();
  });

  it('adds no card for a sentence that translates to itself, or for copyright lines', async () => {
    fake.translations.set('PIKACHU!', 'Pikachu!');
    fake.scanner.emit('capture', capture('PIKACHU! ©1995 GAME FREAK inc.'));
    await wait(10);
    expect(srs.cards()).toHaveLength(0);
    session.dispose();
  });

  it('adds no cards when auto-add is off', async () => {
    store.set('autoAdd', 'off');
    fake.scanner.emit('capture', capture('Hallo! Wie geht es dir?'));
    await wait(10);
    expect(srs.cards()).toHaveLength(0);
    session.dispose();
  });

  it('speaks only what is new, in the game language, and never the same line twice', () => {
    store.set('autoTts', true);
    const c = capture('Hallo!');
    fake.scanner.emit('capture', c);
    fake.scanner.emit('update', { ...c, dialog: { text: 'Hallo! Wie geht es?', translation: '', status: 'pending' } });
    fake.scanner.emit('update', { ...c, dialog: { text: 'Hallo! Wie geht es?', translation: 'Hi! How are you?', status: 'done' } });
    fake.scanner.emit('capture', capture('Hallo!'));
    expect(fake.spoken).toEqual([['Hallo!', 'de'], ['Wie geht es?', 'de']]);
    session.dispose();
  });

  it('starts a fresh line after auto-translate comes back on', () => {
    const before = fake.scanner.resets;
    store.set('ocrPaused', true);
    expect(fake.scanner.resets).toBe(before);
    store.set('ocrPaused', false);
    expect(fake.scanner.resets).toBe(before + 1);
    session.dispose();
    // a disposed session no longer listens
    store.set('ocrPaused', true);
    store.set('ocrPaused', false);
    expect(fake.scanner.resets).toBe(before + 1);
  });

  it('retries an earlier line directly and saves it back to history', async () => {
    const c = capture('Tschüss!');
    fake.scanner.emit('capture', c);
    const failed = { ...c, dialog: { text: 'Tschüss!', translation: '', status: 'error' } };
    history.update(failed);
    const next = await session.retry(failed, 'dialog', 'history');
    expect(next.dialog).toEqual({ text: 'Tschüss!', translation: '[en] Tschüss!', status: 'done' });
    expect(history.get(c.id).dialog.translation).toBe('[en] Tschüss!');
    session.dispose();
  });
});
