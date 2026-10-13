// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// jsdom's Blob lacks text()/arrayBuffer(), which every target browser has
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(this);
    });
  };
}
if (!Blob.prototype.text) {
  Blob.prototype.text = function () { return this.arrayBuffer().then((b) => new TextDecoder().decode(b)); };
}

let backup;
let db;
let idb;
let srs;
let dict;
let history;
let store;

const T0 = 1759650000000;

async function boot() {
  vi.resetModules();
  idb = await import('../../src/core/idb.js');
  db = await import('../../src/core/db.js');
  ({ store } = await import('../../src/core/store.js'));
  srs = await import('../../src/core/srs.js');
  dict = await import('../../src/core/dictionary.js');
  history = await import('../../src/core/history.js');
  backup = await import('../../src/core/backup.js');
  await db.initDb();
}

async function reboot() {
  db.cancelPending({ freeze: true });
  await idb.closeDb();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  await boot();
}

function seed() {
  store.set('source', 'de');
  store.set('target', 'en');
  store.set('onboarded', true);
  store.set('theme', 'dark');
  const { card } = srs.addCard({ text: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!', src: 'de', tgt: 'en' });
  srs.grade(card.id, 2);
  srs.addCard({ text: 'KAMPF', translation: 'FIGHT', src: 'de', tgt: 'en' });
  dict.recordCapture([{ kind: 'dialog', text: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!' }], 'de', 'en');
  history.add({ id: 'cap1', time: T0, src: 'de', tgt: 'en', dialog: { text: 'Hallo', translation: 'Hello', status: 'done' }, others: [], conf: 90 });
  return card;
}

const blobJson = async (blob) => JSON.parse(await blob.text());
const file = (obj) => new Blob([typeof obj === 'string' ? obj : JSON.stringify(obj)], { type: 'application/json' });

beforeEach(async () => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await boot();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.cancelPending({ freeze: true });
  await idb.closeDb();
});

describe('exportBackup', () => {
  it('exports learning data and setting overrides, never ROMs or the translation cache', async () => {
    seed();
    await idb.idbSet('roms:index', [{ id: 'rom-0123456789abcdef', name: 'Pokemon Rot.gb', size: 1 }]);
    const data = await blobJson(await backup.exportBackup());
    expect(data).toMatchObject({ app: 'emulingo', format: 2 });
    expect(Object.keys(data).sort()).toEqual(['activity', 'app', 'cards', 'dictionary', 'exported', 'format', 'history', 'settings']);
    expect(data.settings).toEqual({ settingsVersion: 2, source: 'de', onboarded: true, theme: 'dark' });
    expect(data.cards).toHaveLength(2);
    expect(data.dictionary.length).toBeGreaterThan(1);
    expect(data.history).toHaveLength(1);
    expect(data.activity).toHaveLength(1);
    expect(backup.backupFileName(new Date(2026, 9, 11))).toBe('spritespeak-backup-2026-10-11.json');
  });

  it('includes game saves with their ROM’s id, SHA-1 and file name when asked', async () => {
    const sha1 = 'ab'.repeat(20);
    await idb.idbSet('roms:index', [{ id: 'rom-abababababababab', name: 'Pokemon Rot.gb', sha1 }]);
    await idb.idbSet('state:rom-abababababababab:manual', new Uint8Array([1, 2, 3]));
    await idb.idbSet('sram:rom-abababababababab', { v: 1, files: { '/data/saves/Pokemon Rot.srm': { data: new Uint8Array([9, 8]), mtime: 5 } }, t: 6 });
    await idb.idbSet('state:rom-gone:auto', new Uint8Array([7])); // its game was deleted
    const data = await blobJson(await backup.exportBackup({ includeSaves: true }));
    expect(data.saves).toEqual([
      { kind: 'state', romId: 'rom-abababababababab', rom: 'Pokemon Rot.gb', sha1, suffix: ':manual', data: { $u8: 'AQID' } },
      { kind: 'sram', romId: 'rom-abababababababab', rom: 'Pokemon Rot.gb', sha1, suffix: '', data: { v: 1, files: { '/data/saves/Pokemon Rot.srm': { data: { $u8: 'CQg=' }, mtime: 5 } }, t: 6 } }
    ]);
  });
});

describe('round trip', () => {
  it('restores everything on a fresh device (replace)', async () => {
    const card = seed();
    const blob = await backup.exportBackup();
    await reboot();
    const summary = await backup.parseBackup(blob);
    expect(summary.warnings).toEqual([]);
    expect(summary.counts).toMatchObject({ cards: 2, history: 1, activity: 1, settings: 3 });
    const res = await backup.applyBackup(summary, { mode: 'replace' });
    expect(res.cards).toBe(2);
    expect(srs.getCard(card.id)).toMatchObject({ seen: 1, text: 'Ein wildes TAUBSI erscheint!' });
    expect(srs.streak()).toBe(1);
    expect(store.get('theme')).toBe('dark');
    expect(store.get('onboarded')).toBe(true);
    expect(history.list()[0].dialog.translation).toBe('Hello');
    expect(dict.search({ kind: 'line' }).items[0].translation).toBe('A wild PIDGEY appears!');
    expect((await idb.idbGetAll('cards')).length).toBe(2); // flushed
  });

  it('merges into existing data, keeping the better-studied copy and current settings', async () => {
    const card = seed();
    const blob = await backup.exportBackup();
    // this device: same card never studied, plus a card of its own
    await reboot();
    store.set('onboarded', true);
    store.set('source', 'de');
    store.set('theme', 'light');
    srs.addCard({ text: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!', src: 'de', tgt: 'en' });
    srs.addCard({ text: 'Trank', translation: 'Potion', src: 'de', tgt: 'en' });
    const res = await backup.applyBackup(await backup.parseBackup(blob), { mode: 'merge' });
    expect(srs.totalCards()).toBe(3);
    expect(srs.findCard('Ein wildes TAUBSI erscheint!', 'de', 'en').seen).toBe(1);
    expect(srs.findCard('Ein wildes TAUBSI erscheint!', 'de', 'en').id).not.toBe(card.id); // keeps this device's id
    expect(store.get('theme')).toBe('light');
    expect(res.settings).toBe(0);
    // importing the same file twice changes nothing more
    await backup.applyBackup(await backup.parseBackup(blob), { mode: 'merge' });
    expect(srs.totalCards()).toBe(3);
    expect(srs.reviewsOn(srs.todayKey())).toBe(1);
  });

  it('adopts the backup’s settings when merging on a device that isn’t set up yet', async () => {
    seed();
    const blob = await backup.exportBackup();
    await reboot();
    await backup.applyBackup(await backup.parseBackup(blob), { mode: 'merge' });
    expect(store.get('onboarded')).toBe(true);
    expect(store.get('source')).toBe('de');
  });
});

describe('validation', () => {
  it('drops XSS payloads and malformed records with warnings', async () => {
    const summary = await backup.parseBackup(file({
      app: 'emulingo', format: 2, exported: 'yesterday',
      settings: { settingsVersion: 2, source: '<img src=x onerror="window.__xss=1">', rate: '"><img src=x>', target: 'fr', evil: 1 },
      cards: [
        { id: 'x"><img src=x onerror=alert(1)>', text: 'a', src: 'de', tgt: 'en' },
        { id: 'c1', text: 'Hallo', translation: 'Hello', src: 'de', tgt: 'en', ease: '"><img>', seen: '<b>' },
        { id: 'c2', text: 'Tschüss', src: '<svg/onload=alert(1)>', tgt: 'en' },
        'junk', null
      ],
      dictionary: [{ id: 'd1', kind: 'word', text: 'Hallo', src: 'de', count: '"><x>', translations: { en: 'Hello', '<x>': 'y' } }],
      history: [{ id: 'h1', time: 1, src: 'de', tgt: 'en', conf: '<img>', dialog: { text: 'Hi', translation: 'Hi', status: 'done' }, others: [] }],
      activity: [{ id: '2026-10-05', count: '"><img src=x onerror=alert(1)>' }, { id: '<b>', count: 3 }, { id: '2026-10-06', count: 2 }],
      roms: [{ id: 'r1', name: 'x' }],
      extra: '<script>'
    }));
    expect(summary.counts).toEqual({ cards: 1, dictionary: 1, history: 1, activity: 1, settings: 1, saves: 0 });
    expect(summary.data.settings).toEqual({ target: 'fr' });
    expect(summary.data.cards[0]).toMatchObject({ id: 'c1', ease: 2.5, seen: 0 });
    expect(summary.data.dictionary[0]).toMatchObject({ count: 1, translations: { en: 'Hello' } });
    expect(summary.data.history[0].conf).toBe(null);
    expect(summary.exported).toBe(null);
    expect(summary.warnings).toEqual(expect.arrayContaining([
      'Some unknown data in the file was ignored.',
      'Game files aren’t part of backups. Add your games again on this device.',
      '4 damaged items in cards were skipped.',
      '2 damaged items in study days were skipped.'
    ]));
    await backup.applyBackup(summary, { mode: 'replace' });
    expect(db.collection('roms').all()).toEqual([]);
    expect(await idb.idbGet('roms:index')).toBeUndefined();
    expect(JSON.stringify(srs.cards())).not.toMatch(/<img|onerror/);
  });

  it('rejects files that aren’t backups', async () => {
    await expect(backup.parseBackup(file('{not json'))).rejects.toMatchObject({ name: 'BackupError' });
    await expect(backup.parseBackup(file([1, 2]))).rejects.toThrow('isn’t a Spritespeak backup');
    await expect(backup.parseBackup(file({ hello: 1 }))).rejects.toThrow('isn’t a Spritespeak backup');
    await expect(backup.parseBackup(file({ app: 'emulingo', format: 3 }))).rejects.toThrow('newer version');
    await expect(backup.parseBackup(null)).rejects.toThrow('Choose a Spritespeak backup file.');
    await expect(backup.parseBackup({ size: 1e12, text: async () => '{}' })).rejects.toThrow('too large');
    await expect(backup.applyBackup(null)).rejects.toThrow('Nothing to restore.');
  });

  it('skips damaged sections and saves', async () => {
    const summary = await backup.parseBackup(file({
      app: 'emulingo', format: 2, cards: 'oops',
      saves: [
        { kind: 'state', rom: 'Game.gb', suffix: ':manual', data: { $u8: '!!!' } },
        { kind: 'evil', rom: 'Game.gb', suffix: '', data: 1 },
        { kind: 'sram', rom: 'Game.gb', suffix: '/../x', data: 1 },
        { kind: 'sram', rom: 'Game.gb', suffix: '', data: { $ab: 'AQID' } }
      ]
    }));
    expect(summary.counts.saves).toBe(1);
    expect(summary.warnings).toContain('The cards in this backup are damaged and were skipped.');
    expect(summary.warnings).toContain('3 damaged game saves were skipped.');
  });
});

describe('v1 backups', () => {
  it('migrates a v1 export', async () => {
    const v1 = {
      version: 1,
      exported: '2025-10-05T10:00:00.000Z',
      'emulingo:settings': JSON.stringify({ source: 'de', target: 'en', autoAdd: true, ocrEngine: 'paddle', keepHistory: 300, ttsLang: 'auto' }),
      'emulingo:cards': JSON.stringify([
        { id: '1759650000000-ab12c', text: 'Ein wildes TAUBSI erscheint!', lang: 'de', translation: 'A wild PIDGEY appears!', ease: 2.45, interval: 86400000, reps: 1, lapses: 0, due: T0, added: T0, lastResult: 1, seen: 1 },
        { id: 'bad id <x>', text: 'KAMPF', lang: 'de', translation: 'FIGHT', ease: 2.5, interval: 0, reps: 0, lapses: 0, due: T0, added: T0, lastResult: null, seen: 0 }
      ]),
      'emulingo:dict': JSON.stringify([{ id: 'd-1', key: 'de|wildes', kind: 'word', text: 'wildes', translation: 'wild', lang: 'de', tgt: 'en', count: 3, firstSeen: T0, lastSeen: T0, pending: false }]),
      'emulingo:history': JSON.stringify([{ original: 'Hallo', translation: 'Hello', regions: [{ original: 'Hallo Welt', translation: 'Hello world' }], time: T0, conf: 90, src: 'de', tgt: 'en' }]),
      'emulingo:activitylog': JSON.stringify({ '2025-10-05': 4, '2025-10-06': '<img>' }),
      'emulingo:streak': '"<img src=x onerror=alert(1)>"',
      'emulingo:roms': JSON.stringify([{ id: 'rom-1', name: 'Pokemon Rot.gb' }]),
      'emulingo:translations': JSON.stringify({ 'v2|de>en|x': 'y' }),
      'emulingo:lastRomId': '"rom-1"'
    };
    const summary = await backup.parseBackup(file(v1));
    expect(summary.format).toBe(1);
    expect(summary.counts).toEqual({ cards: 2, dictionary: 1, history: 1, activity: 1, settings: 2, saves: 0 });
    expect(summary.data.settings).toEqual({ source: 'de', keepHistory: 300 }); // v1 defaults dropped
    expect(summary.data.cards.every((c) => /^[\w.:-]+$/.test(c.id) && c.src === 'de' && c.tgt === 'en')).toBe(true);
    expect(summary.data.dictionary[0].translations).toEqual({ en: 'wild' });
    expect(summary.data.history[0].dialog.text).toBe('Hallo Welt');
    expect(summary.warnings).toContain('Game files aren’t part of backups. Add your games again on this device.');
    await backup.applyBackup(summary, { mode: 'replace' });
    expect(srs.totalCards()).toBe(2);
    expect(store.get('keepHistory')).toBe(300);
    // v1 had no onboarding: a restored deck means this person is set up
    expect(store.get('source')).toBe('de');
    expect(store.get('onboarded')).toBe(true);
  });

  it('replacing keeps this device’s game language and setup when the backup doesn’t say', async () => {
    store.set('source', 'fr');
    store.set('onboarded', true);
    store.set('theme', 'dark');
    const summary = await backup.parseBackup(file({
      version: 1,
      'emulingo:settings': JSON.stringify({ target: 'en', rate: 1.5 }),
      'emulingo:cards': JSON.stringify([])
    }));
    await backup.applyBackup(summary, { mode: 'replace' });
    expect(store.get('source')).toBe('fr');
    expect(store.get('onboarded')).toBe(true);
    expect(store.get('theme')).toBe('system'); // everything else is the backup's
    expect(store.get('rate')).toBe(1.5);
  });

  it('accepts hand-edited v1 files with object values, still validated', async () => {
    const summary = await backup.parseBackup(file({
      version: 1,
      'emulingo:cards': [{ id: 'c1', text: 'Hallo', lang: 'de', translation: 'Hello' }, { id: 'c2', text: 5, lang: 'de' }],
      'emulingo:dict': '{broken'
    }));
    expect(summary.counts.cards).toBe(1);
    expect(summary.warnings).toContain('The dictionary entries in this backup are damaged and were skipped.');
  });
});

describe('game saves', () => {
  const savesBackup = (saves) => file({ app: 'emulingo', format: 2, cards: [], saves });

  it('links saves to the same ROM by id or file name, or keeps them until it is added', async () => {
    await idb.idbSet('roms:index', [{ id: 'rom-1111111111111111', name: 'Pokemon Rot.gb' }, { id: 'rom-2222222222222222', name: 'Renamed.gb' }]);
    const summary = await backup.parseBackup(savesBackup([
      { kind: 'state', rom: 'pokemon rot.GB', suffix: ':manual', data: { $u8: 'AQID' } },
      { kind: 'state', romId: 'rom-2222222222222222', rom: 'Original name.gb', suffix: ':auto', data: { $u8: 'BA==' } },
      { kind: 'sram', romId: 'rom-3333333333333333', rom: 'Pokemon Gelb.gbc', suffix: '', data: { 'x.srm': { $ab: 'CQg=' } } }
    ]));
    const res = await backup.applyBackup(summary, { mode: 'merge' });
    expect(res.saves).toEqual({ linked: 2, waiting: 1 });
    expect(new Uint8Array(await idb.idbGet('state:rom-1111111111111111:manual'))).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await idb.idbGet('state:rom-2222222222222222:auto'))).toEqual(new Uint8Array([4]));

    // later the user adds Pokémon Gelb: its save moves into place
    expect(await backup.relinkSaves({ id: 'rom-4444444444444444', name: 'Other.gb' })).toBe(0);
    expect(await backup.relinkSaves({ id: 'rom-3333333333333333', name: 'gelb.gbc' })).toBe(1);
    const sram = await idb.idbGet('sram:rom-3333333333333333');
    expect(new Uint8Array(sram['x.srm'])).toEqual(new Uint8Array([9, 8]));
    expect(await idb.idbKeys('pendingsave:')).toEqual([]);
    expect(await backup.relinkSaves({ id: 'bad id!', name: 'x' })).toBe(0);
    expect(await backup.relinkSaves(null)).toBe(0);
  });

  it('keeps waiting saves in later exports', async () => {
    const summary = await backup.parseBackup(savesBackup([{ kind: 'sram', rom: 'Gelb.gbc', suffix: '', data: { $u8: 'AQ==' } }]));
    await backup.applyBackup(summary);
    const data = await blobJson(await backup.exportBackup({ includeSaves: true }));
    expect(data.saves).toEqual([{ kind: 'sram', rom: 'Gelb.gbc', suffix: '', data: { $u8: 'AQ==' } }]);
  });

  it('never overwrites existing progress when merging, but does when replacing', async () => {
    await idb.idbSet('roms:index', [{ id: 'r1', name: 'Game.gb' }]);
    await idb.idbSet('sram:r1', new Uint8Array([5]));
    const summary = await backup.parseBackup(savesBackup([{ kind: 'sram', rom: 'Game.gb', suffix: '', data: { $u8: 'AQ==' } }]));
    await backup.applyBackup(summary, { mode: 'merge' });
    expect(Array.from(await idb.idbGet('sram:r1'))).toEqual([5]);
    await backup.applyBackup(summary, { mode: 'replace' });
    expect(Array.from(await idb.idbGet('sram:r1'))).toEqual([1]);
    await backup.applyBackup(summary, { mode: 'replace', includeSaves: false });
  });

  it('marks battery saves restored by Replace so they win over the emulator’s newer copy', async () => {
    await idb.idbSet('roms:index', [{ id: 'r1', name: 'Game.gb' }]);
    const mirror = { v: 1, t: 6, files: { '/data/saves/Gambatte/Game.srm': { data: { $u8: 'AQ==' }, mtime: 5 } } };
    const summary = await backup.parseBackup(savesBackup([{ kind: 'sram', rom: 'Game.gb', suffix: '', data: mirror }]));
    await backup.applyBackup(summary, { mode: 'merge' });
    expect((await idb.idbGet('sram:r1')).restored).toBeUndefined();
    await backup.applyBackup(summary, { mode: 'replace' });
    expect(await idb.idbGet('sram:r1')).toMatchObject({ v: 1, restored: true });
  });

  it('encodes and decodes stored values', async () => {
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'application/octet-stream' });
    const enc = await backup.encodeValue({ a: new Uint8Array([1]), b: [new ArrayBuffer(2), 'x', 3, null], c: blob, d: () => 1, e: new Date() });
    expect(enc).toEqual({ a: { $u8: 'AQ==' }, b: [{ $ab: 'AAA=' }, 'x', 3, null], c: { $blob: 'AQI=', type: 'application/octet-stream' } });
    const dec = backup.decodeValue(enc);
    expect(dec.a).toEqual(new Uint8Array([1]));
    expect(dec.b[0].byteLength).toBe(2);
    expect(dec.c.type).toBe('application/octet-stream');
    expect(() => backup.decodeValue({ $u8: 'AQ==' }, { bytes: 0 })).toThrow('too large');
    expect(() => backup.decodeValue(Infinity)).toThrow();
  });

  it('describes counts for the confirm dialog', () => {
    expect(backup.describeCounts({ cards: 1, dictionary: 2, history: 0, saves: 3 })).toBe('1 card, 2 dictionary entries and 3 game saves');
    expect(backup.describeCounts({ cards: 5 })).toBe('5 cards');
    expect(backup.describeCounts({})).toBe('no data');
    expect(backup.describeCounts({ cards: 1234, dictionary: 1 })).toBe('1,234 cards and 1 dictionary entry');
  });
});

describe('wipeAll', () => {
  it('removes Spritespeak and EmulatorJS data only, and stops further writes', async () => {
    window.history.pushState({}, '', '/spritespeak/index.html');
    seed();
    await db.flush();
    await idb.idbSet('rom:r1', new Uint8Array([1]));
    const open = (name) => new Promise((resolve) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('s');
      r.onsuccess = () => resolve(r.result);
    });
    const saves = await open('/data/saves');
    saves.onversionchange = () => {}; // EmulatorJS keeps it open
    (await open('EmulatorJS-roms')).close();
    (await open('keyval-store')).close();
    (await open('other-app')).close();
    localStorage.setItem('ejs-settings', '{}');
    localStorage.setItem('ejs-1-gb-Pokemon-settings', '{}');
    localStorage.setItem('other-app:data', 'keep');
    sessionStorage.setItem('emulingo:autostart', 'r1');
    const deleted = [];
    vi.stubGlobal('caches', {
      keys: async () => ['emulingo-shell-abc', 'emulingo-models-v1', 'other-cache'],
      delete: async (n) => { deleted.push(n); return true; }
    });
    const unregistered = [];
    const reg = (scope) => ({ scope, unregister: async () => { unregistered.push(scope); return true; } });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: async () => [reg(location.origin + '/spritespeak/'), reg(location.origin + '/other/')] }
    });

    const otherTab = [];
    const channel = new BroadcastChannel('emulingo-db');
    channel.onmessage = (e) => otherTab.push(e.data.type);

    const report = await backup.wipeAll();
    await vi.waitFor(() => expect(otherTab).toEqual(['erased'])); // other open tabs stop writing too
    channel.close();

    expect(report.databases).toMatchObject({ emulingo: 'deleted', '/data/saves': 'blocked', 'EmulatorJS-roms': 'deleted', 'keyval-store': 'deleted' });
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toContain('other-app');
    expect(names).not.toContain('emulingo');
    expect(names).not.toContain('EmulatorJS-roms');
    expect(Object.keys(localStorage)).toEqual(['other-app:data']);
    expect(sessionStorage.getItem('emulingo:autostart')).toBe(null);
    expect(deleted).toEqual(['emulingo-shell-abc', 'emulingo-models-v1']);
    expect(unregistered).toEqual([location.origin + '/spritespeak/']);

    // nothing comes back: no late flush, no settings write
    srs.addCard({ text: 'Neu', translation: 'New', src: 'de', tgt: 'en' });
    store.set('theme', 'dark');
    window.dispatchEvent(new Event('pagehide'));
    await db.flush();
    expect(localStorage.getItem('emulingo:settings')).toBe(null);
    await expect(idb.idbSet('state:r1:auto', new Uint8Array([1]))).rejects.toThrow('erased'); // a late autosave
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('emulingo');
    saves.close();
    delete navigator.serviceWorker;
  });
});
