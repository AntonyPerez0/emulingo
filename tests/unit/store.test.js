// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let mod;
let db;

const stored = () => JSON.parse(localStorage.getItem('emulingo:settings'));

async function load({ coarse = false } = {}) {
  vi.resetModules();
  window.matchMedia = vi.fn((q) => ({ matches: coarse && q === '(pointer: coarse)' }));
  db = await import('../../src/core/db.js');
  mod = await import('../../src/core/store.js');
  return mod.store;
}

// v1 saved its whole state on every change, defaults included.
const V1_UNTOUCHED = {
  source: 'de', target: 'en', ttsLang: 'auto', rate: 1, showRtl: false, flashcardThreshold: 7, keepHistory: 200,
  ocrInterval: 2000, stableThreshold: 2, minWordLen: 2, spellCheck: true, ocrEngine: 'paddle', autoTts: false,
  autoAdd: true, scale: 2, platform: 'gb', core: 'auto', fastBoot: false, captureScale: 3
};

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  db?.cancelPending({ freeze: true });
});

describe('defaults', () => {
  it('starts with the pinned defaults and writes nothing', async () => {
    const store = await load();
    expect(store.all()).toEqual({ ...mod.DEFAULTS });
    expect(store.get('source')).toBe(null);
    expect(store.get('onboarded')).toBe(false);
    expect(store.get('readAllText')).toBe(true);
    expect(store.get('autoAdd')).toBe('sentences');
    expect(localStorage.getItem('emulingo:settings')).toBe(null);
  });

  it('uses a gentler scan speed on touch devices without storing it', async () => {
    const store = await load({ coarse: true });
    expect(store.get('scanSpeed')).toBe('relaxed');
    store.set('target', 'fr');
    expect(stored()).toEqual({ settingsVersion: 2, target: 'fr' });
    store.set('scanSpeed', 'normal');
    expect(stored().scanSpeed).toBe('normal');
  });
});

describe('persistence', () => {
  it('stores only values that differ from the defaults', async () => {
    const store = await load();
    store.set('target', 'de');
    store.set('rate', 1.25);
    expect(stored()).toEqual({ settingsVersion: 2, target: 'de', rate: 1.25 });
    store.set('target', 'en');
    expect(stored()).toEqual({ settingsVersion: 2, rate: 1.25 });
    const again = await load();
    expect(again.get('rate')).toBe(1.25);
  });

  it('reports a failed save instead of hiding it', async () => {
    const store = await load();
    const errors = [];
    db.onStorageError((e) => errors.push(e));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(store.set('target', 'fr')).toBe(true); // in memory for this session
    expect(store.get('target')).toBe('fr');
    expect(errors[0]).toMatchObject({ kind: 'quota', source: 'settings' });
  });
});

describe('validation', () => {
  it('coerces or rejects values on set', async () => {
    const store = await load();
    expect(store.set('rate', '"><img src=x onerror=alert(1)>')).toBe(false);
    expect(store.get('rate')).toBe(1);
    expect(store.set('rate', 5)).toBe(true);
    expect(store.get('rate')).toBe(2);
    expect(store.set('rate', '0.87')).toBe(true);
    expect(store.get('rate')).toBe(0.85);
    expect(store.set('source', 'xx')).toBe(false);
    expect(store.set('source', 'ja')).toBe(true);
    expect(store.set('theme', 'neon')).toBe(false);
    expect(store.set('newPerDay', NaN)).toBe(false);
    expect(store.set('keepHistory', 99999)).toBe(true);
    expect(store.get('keepHistory')).toBe(1000);
    expect(store.set('nope', 1)).toBe(false);
    expect(store.set('core', 'mgba')).toBe(true);
    expect(store.set('core', 'x y')).toBe(false);
    store.set('voiceByLang', { de: 'com.apple.voice.Anna', '<x>': 'y', fr: 123 });
    expect(store.get('voiceByLang')).toEqual({ de: 'com.apple.voice.Anna' });
  });

  it('cleans tampered stored settings on load (stored XSS)', async () => {
    localStorage.setItem('emulingo:settings', JSON.stringify({
      settingsVersion: 2,
      source: '<img src=x onerror="window.__xss=1">',
      target: 'fr',
      rate: '"><img src=x>',
      keepHistory: 1e9,
      theme: 'evil',
      minWordLen: 'x',
      onboarded: 'yes',
      voiceByLang: '<svg onload=alert(1)>',
      evil: '<script>'
    }));
    const store = await load();
    expect(store.get('source')).toBe(null);
    expect(store.get('target')).toBe('fr');
    expect(store.get('rate')).toBe(1);
    expect(store.get('keepHistory')).toBe(1000);
    expect(store.get('theme')).toBe('system');
    expect(store.get('onboarded')).toBe(false);
    expect(store.get('voiceByLang')).toEqual({});
    expect(store.all()).not.toHaveProperty('evil');
    expect(stored()).toEqual({ settingsVersion: 2, target: 'fr', keepHistory: 1000 });
  });

  it('survives unreadable stored settings', async () => {
    localStorage.setItem('emulingo:settings', '{not json');
    const store = await load();
    expect(store.get('target')).toBe('en');
  });
});

describe('v1 migration', () => {
  it('drops values equal to the old defaults but keeps the game language', async () => {
    localStorage.setItem('emulingo:settings', JSON.stringify({ ...V1_UNTOUCHED, source: 'fr' }));
    localStorage.setItem('emulingo:tts-default-migrated', 'true');
    const store = await load();
    expect(store.get('source')).toBe('fr');
    expect(store.get('ocrEngine')).toBe('auto');
    expect(store.get('autoAdd')).toBe('sentences');
    expect(store.get('minWordLen')).toBe(3);
    expect(store.all()).not.toHaveProperty('ttsLang');
    expect(stored()).toEqual({ settingsVersion: 2, source: 'fr' });
    expect(localStorage.getItem('emulingo:tts-default-migrated')).toBe(null);
  });

  it('keeps and maps real choices', async () => {
    localStorage.setItem('emulingo:settings', JSON.stringify({
      ...V1_UNTOUCHED, target: 'es', autoAdd: false, ocrEngine: 'tesseract', minWordLen: 5, rate: 1.3,
      autoTts: true, keepHistory: 300, spellCheck: false
    }));
    const store = await load();
    expect(store.all()).toMatchObject({
      source: 'de', target: 'es', autoAdd: 'off', ocrEngine: 'tesseract', minWordLen: 5, rate: 1.3,
      autoTts: true, keepHistory: 300, spellCheck: false, onboarded: false
    });
  });

  it('marks v1 users with cards or history as onboarded', async () => {
    localStorage.setItem('emulingo:cards', JSON.stringify([{ id: 'c1', text: 'Hallo', lang: 'de', translation: 'Hello' }]));
    const store = await load(); // no stored settings: v1 never changed anything
    const changes = vi.fn();
    store.subscribe(changes);
    await db.initDb();
    expect(store.get('onboarded')).toBe(true);
    expect(store.get('source')).toBe('de'); // v1's default game language
    expect(changes).toHaveBeenCalledWith('onboarded', true);
    expect(stored()).toMatchObject({ source: 'de', onboarded: true });
  });

  it('leaves v1 users without learning data to onboarding', async () => {
    localStorage.setItem('emulingo:settings', JSON.stringify({ ...V1_UNTOUCHED, source: 'it' }));
    localStorage.setItem('emulingo:roms', JSON.stringify([{ id: 'rom-1', name: 'Game.gb' }]));
    const store = await load();
    await db.initDb();
    expect(store.get('onboarded')).toBe(false);
    expect(store.get('source')).toBe('it'); // pre-selected in onboarding
  });
});

describe('subscribe, reset and other tabs', () => {
  it('notifies subscribers of real changes only', async () => {
    const store = await load();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.set('theme', 'dark');
    store.set('theme', 'dark');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('theme', 'dark');
    off();
    store.set('theme', 'light');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reset keeps the language pair unless asked not to', async () => {
    const store = await load();
    store.set('source', 'de');
    store.set('target', 'fr');
    store.set('onboarded', true);
    store.set('theme', 'dark');
    store.reset();
    expect(store.all()).toMatchObject({ source: 'de', target: 'fr', onboarded: true, theme: 'system' });
    store.reset({ keep: [] });
    expect(store.all()).toEqual({ ...mod.DEFAULTS });
    expect(stored()).toEqual({ settingsVersion: 2 });
    expect(store.isDefault('theme')).toBe(true);
  });

  it('adopts changes made in another tab without writing back', async () => {
    const store = await load();
    const fn = vi.fn();
    store.subscribe(fn);
    const value = JSON.stringify({ settingsVersion: 2, target: 'ja', theme: 'dark' });
    localStorage.setItem('emulingo:settings', value);
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    window.dispatchEvent(new StorageEvent('storage', { key: 'emulingo:settings', newValue: value }));
    expect(store.get('target')).toBe('ja');
    expect(fn).toHaveBeenCalledWith('target', 'ja');
    expect(fn).toHaveBeenCalledWith('theme', 'dark');
    expect(spy).not.toHaveBeenCalled();
  });
});
