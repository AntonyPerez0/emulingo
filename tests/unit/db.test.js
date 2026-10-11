// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let db;
let idb;

const T0 = 1759650000000; // Oct 2025

const V1 = {
  cards: [
    { id: '1759650000000-ab12c', text: 'Ein wildes TAUBSI erscheint!', lang: 'de', translation: 'A wild PIDGEY appears!',
      ease: 2.45, interval: 86400000, reps: 1, lapses: 0, due: T0 + 86400000, added: T0, lastResult: 1, seen: 1 },
    { id: 'x"><img src=x onerror=alert(1)>', text: 'KAMPF', lang: 'de', translation: 'FIGHT', ease: 2.5, interval: 0,
      reps: 0, lapses: 0, due: T0, added: T0, lastResult: null, seen: 0 }
  ],
  dict: [
    { id: '1759650000001-x1y2', key: 'de|wildes', kind: 'word', text: 'wildes', translation: 'wild', lang: 'de', tgt: 'en',
      count: 3, firstSeen: T0, lastSeen: T0 + 1000, pending: false }
  ],
  history: [
    { original: 'KAMPF / Ein wildes TAUBSI erscheint!', translation: 'FIGHT / A wild PIDGEY appears!',
      regions: [{ original: 'KAMPF', translation: 'FIGHT', conf: 90 }, { original: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!', conf: 95 }],
      time: T0 + 5000, conf: 92, src: 'de', tgt: 'en', status: null }
  ],
  activitylog: { '2025-10-05': 5, '2025-10-06': 3, bogus: 4, '2025-10-07': '<b>' },
  streak: 2,
  roms: [{ id: 'rom-1759650000000', name: 'Pokemon Rot.gb', size: 1048576, added: T0 }]
};

function seedV1() {
  for (const [k, v] of Object.entries(V1)) localStorage.setItem('emulingo:' + k, JSON.stringify(v));
}

async function freshModules() {
  vi.resetModules();
  idb = await import('../../src/core/idb.js');
  db = await import('../../src/core/db.js');
}

const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

// Make every readwrite transaction that writes a record abort over quota.
function failPuts() {
  const real = IDBObjectStore.prototype.put;
  const aborted = new WeakSet();
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function () {
    const tx = this.transaction;
    if (!aborted.has(tx)) {
      aborted.add(tx);
      Object.defineProperty(tx, 'error', { value: quota(), configurable: true });
      queueMicrotask(() => { try { tx.abort(); } catch { /* done */ } });
    }
    return {};
  });
  return { spy, real };
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  await freshModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.cancelPending({ freeze: true });
  await idb.closeDb();
});

describe('initDb', () => {
  it('starts empty and is idempotent', async () => {
    const p1 = db.initDb();
    const p2 = db.initDb();
    expect(p1).toBe(p2);
    await p1;
    expect(db.isReady()).toBe(true);
    expect(db.collection('cards').all()).toEqual([]);
    expect(db.storageStatus().memoryOnly).toBe(false);
  });

  it('keeps records written before loading finished, and saves them', async () => {
    await idb.idbBatch([{ store: 'cards', type: 'put', value: { id: 'stored' } }]);
    const cards = db.collection('cards');
    cards.put({ id: 'early' }); // e.g. a view that didn't wait for initDb
    await db.initDb();
    expect(cards.all().map((c) => c.id).sort()).toEqual(['early', 'stored']);
    await db.flush();
    expect((await idb.idbGetAll('cards')).map((c) => c.id).sort()).toEqual(['early', 'stored']);
  });

  it('rejects unknown collections and invalid ids', async () => {
    await db.initDb();
    expect(() => db.collection('nope')).toThrow();
    expect(() => db.collection('cards').put({ id: 'bad id!' })).toThrow();
    expect(() => db.collection('cards').put({ text: 'no id' })).toThrow();
  });
});

describe('v1 migration', () => {
  it('moves localStorage data into IndexedDB once and removes the old keys', async () => {
    seedV1();
    const legacy = vi.fn();
    db.onLegacyMigration(legacy);
    await db.initDb();

    const cards = db.collection('cards').all();
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => /^[\w.:-]{1,80}$/.test(c.id))).toBe(true); // unsafe v1 id replaced
    expect(db.collection('dict').get('1759650000001-x1y2').text).toBe('wildes');
    expect(db.collection('history').all()).toHaveLength(1);
    expect(db.collection('history').all()[0].id).toMatch(/^h/);
    expect(db.collection('activity').all().sort((a, b) => (a.id < b.id ? -1 : 1)))
      .toEqual([{ id: '2025-10-05', count: 5 }, { id: '2025-10-06', count: 3 }]);
    expect(db.collection('roms').all()).toEqual([]); // rom.js owns the ROM library
    expect(legacy).toHaveBeenCalledWith({ hadLearningData: true });

    for (const k of ['cards', 'dict', 'history', 'activitylog', 'streak']) {
      expect(localStorage.getItem('emulingo:' + k)).toBe(null);
    }
    expect(localStorage.getItem('emulingo:roms')).not.toBe(null);
    expect((await idb.idbGetAll('cards')).length).toBe(2);
    expect((await idb.idbGetAll('meta')).find((m) => m.id === 'migration').v1).toBe(true);

    // next boot reads IndexedDB and doesn't migrate again
    localStorage.setItem('emulingo:cards', JSON.stringify([{ id: 'late', text: 'x', lang: 'de' }]));
    db.cancelPending({ freeze: true });
    await idb.closeDb();
    await freshModules();
    const again = vi.fn();
    db.onLegacyMigration(again);
    await db.initDb();
    expect(db.collection('cards').all()).toHaveLength(2);
    expect(db.collection('cards').get('late')).toBe(null);
    expect(again).not.toHaveBeenCalled();
    expect(localStorage.getItem('emulingo:cards')).toBe(null); // leftovers cleared
  });

  it('reports no learning data for a v1 user with only study days', async () => {
    localStorage.setItem('emulingo:activitylog', JSON.stringify(V1.activitylog));
    const legacy = vi.fn();
    db.onLegacyMigration(legacy);
    await db.initDb();
    expect(legacy).toHaveBeenCalledWith({ hadLearningData: false });
  });

  it('keeps the v1 keys when the migration cannot be saved, and retries next boot', async () => {
    seedV1();
    failPuts();
    await db.initDb();
    expect(db.collection('cards').all()).toHaveLength(2); // usable this session
    expect(localStorage.getItem('emulingo:cards')).not.toBe(null);
  });
});

describe('sanitizers', () => {
  it('upgrade loaded records once and write the result back', async () => {
    await db.initDb();
    const raw = db.collection('cards');
    raw.putMany([{ id: 'a', text: ' hi ', v: 1 }, { id: 'b', text: '' }]);
    await db.flush();
    await freshModules();
    await db.initDb();
    const sanitize = vi.fn((r) => (r.text.trim() ? { id: r.id, text: r.text.trim(), v: 2 } : null));
    const cards = db.collection('cards', { sanitize });
    expect(cards.all()).toEqual([{ id: 'a', text: 'hi', v: 2 }]);
    expect(sanitize).toHaveBeenCalledTimes(2);
    cards.all();
    expect(sanitize).toHaveBeenCalledTimes(2); // only once per load
    await db.flush();
    expect(await idb.idbGetAll('cards')).toEqual([{ id: 'a', text: 'hi', v: 2 }]);
  });

  it('freezes records so they cannot change behind the write tracking', async () => {
    await db.initDb();
    const rec = db.collection('cards').put({ id: 'a', nested: { x: 1 } });
    expect(Object.isFrozen(rec)).toBe(true);
    expect(() => { rec.nested.x = 2; }).toThrow();
  });
});

describe('writes', () => {
  it('debounces writes into one flush', async () => {
    await db.initDb();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cards = db.collection('cards');
    cards.put({ id: 'a' });
    vi.advanceTimersByTime(200);
    cards.put({ id: 'b' });
    vi.advanceTimersByTime(300);
    expect(await idb.idbGetAll('cards')).toEqual([]);
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
    await db.flush();
    expect((await idb.idbGetAll('cards')).map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('flushes deletes, clears and replaceAll in order', async () => {
    await db.initDb();
    const dict = db.collection('dict');
    dict.putMany([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    dict.delete('b');
    await db.flush();
    expect((await idb.idbGetAll('dict')).map((d) => d.id)).toEqual(['a', 'c']);
    dict.replaceAll([{ id: 'z' }]);
    await db.flush();
    expect(await idb.idbGetAll('dict')).toEqual([{ id: 'z' }]);
    expect(dict.delete('missing')).toBe(null);
  });

  it('flushes on pagehide', async () => {
    await db.initDb();
    db.collection('history').put({ id: 'h1' });
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 20));
    expect(await idb.idbGetAll('history')).toEqual([{ id: 'h1' }]);
  });

  it('emits batched change events', async () => {
    await db.initDb();
    const fn = vi.fn();
    db.onChange(fn);
    db.collection('cards').put({ id: 'a' });
    db.collection('dict').put({ id: 'b' });
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toEqual({ collections: ['cards', 'dict'], remote: false });
  });

  it('cancelPending drops queued writes; freeze stops all later ones', async () => {
    await db.initDb();
    db.collection('cards').put({ id: 'a' });
    db.cancelPending();
    await db.flush();
    expect(await idb.idbGetAll('cards')).toEqual([]);
    db.cancelPending({ freeze: true });
    db.collection('cards').put({ id: 'b' });
    await db.flush();
    expect(await idb.idbGetAll('cards')).toEqual([]);
  });
});

describe('storage errors', () => {
  it('reports quota errors, keeps the data queued and recovers', async () => {
    await db.initDb();
    const events = [];
    const recovered = vi.fn();
    db.onStorageError((e) => events.push(e));
    db.onStorageRecovered(recovered);
    const { spy } = failPuts();
    db.collection('cards').put({ id: 'a' });
    await expect(db.flush()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'quota', quota: true, source: 'db', name: 'QuotaExceededError' });
    expect(events[0].message).toMatch(/Storage is full/);
    expect(db.collection('cards').get('a')).toBeTruthy(); // still in memory

    // a second failure of the same kind isn't announced again
    await expect(db.flush()).rejects.toBeTruthy();
    expect(events).toHaveLength(1);

    // late subscribers hear about the ongoing problem
    const late = vi.fn();
    db.onStorageError(late);
    await Promise.resolve();
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quota' }));

    spy.mockRestore();
    await db.flush();
    expect(await idb.idbGetAll('cards')).toEqual([{ id: 'a' }]);
    expect(events).toHaveLength(1); // recovery isn't an error
    expect(recovered).toHaveBeenCalledWith({ message: 'Your changes are being saved again.' });
  });

  it('commits deletions on their own after a quota failure (they free space)', async () => {
    await db.initDb();
    const cards = db.collection('cards');
    cards.putMany([{ id: 'old1' }, { id: 'old2' }]);
    await db.flush();
    failPuts();
    db.onStorageError(() => {});
    cards.put({ id: 'new' });
    await expect(db.flush()).rejects.toBeTruthy();
    cards.delete('old1');
    await expect(db.flush()).rejects.toBeTruthy(); // the put still doesn't fit
    expect((await idb.idbGetAll('cards')).map((c) => c.id)).toEqual(['old2']);
  });

  it('runs from memory when IndexedDB is unavailable', async () => {
    seedV1();
    globalThis.indexedDB = undefined;
    const events = [];
    db.onStorageError((e) => events.push(e));
    await db.initDb();
    expect(db.storageStatus().memoryOnly).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'unavailable' });
    expect(db.collection('cards').all()).toHaveLength(2);
    expect(localStorage.getItem('emulingo:cards')).not.toBe(null); // nothing deleted
    db.collection('cards').put({ id: 'x' });
    await db.flush(); // no-op, no throw
  });

  it('explains when an old tab blocks the upgrade', async () => {
    const old = await new Promise((resolve) => {
      const r = indexedDB.open('emulingo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
    });
    old.onversionchange = () => {}; // a v1 tab never lets go
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const events = [];
    db.onStorageError((e) => events.push(e));
    const p = db.initDb();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    vi.advanceTimersByTime(5000);
    await p;
    vi.useRealTimers();
    expect(events[0]).toMatchObject({ kind: 'blocked' });
    expect(events[0].message).toMatch(/another tab/);
    expect(db.storageStatus().memoryOnly).toBe(true);
    old.close();
  });

  it('reportStorageError lets other modules surface their failures', async () => {
    const fn = vi.fn();
    db.onStorageError(fn);
    db.reportStorageError(quota(), { source: 'settings' });
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quota', source: 'settings' }));
  });
});

describe('other tabs', () => {
  it('reloads a collection when another tab broadcasts a change, keeping local edits', async () => {
    await db.initDb();
    const cards = db.collection('cards');
    cards.put({ id: 'mine', v: 1 });
    await db.flush();
    cards.put({ id: 'unsaved', v: 1 });

    // the other tab writes and announces it
    await idb.idbBatch([{ store: 'cards', type: 'put', value: { id: 'theirs', v: 2 } }]);
    const changes = [];
    db.onChange((e) => changes.push(e));
    const other = new BroadcastChannel('emulingo-db');
    other.postMessage({ type: 'changed', from: 'other-tab', collections: ['cards'] });
    await vi.waitFor(() => expect(cards.get('theirs')).toBeTruthy());
    other.close();
    expect(cards.get('unsaved')).toBeTruthy();
    expect(cards.get('mine')).toBeTruthy();
    expect(changes.some((c) => c.remote && c.collections.includes('cards'))).toBe(true);
  });
});

describe('other tabs: races and erase', () => {
  it('a reload never drops records that a local write is saving', async () => {
    await db.initDb();
    const cards = db.collection('cards');
    // the moment the reload starts reading, this tab adds a card and saves it
    const realGetAll = IDBObjectStore.prototype.getAll;
    let armed = true;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
      const req = realGetAll.apply(this, args);
      if (armed) {
        armed = false;
        cards.put({ id: 'new' });
        db.flush();
      }
      return req;
    });
    const other = new BroadcastChannel('emulingo-db');
    other.postMessage({ type: 'changed', from: 'other-tab', collections: ['cards'] });
    await vi.waitFor(() => expect(armed).toBe(false));
    await db.flush();
    await new Promise((r) => setTimeout(r, 20));
    other.close();
    expect(cards.get('new')).toBeTruthy(); // used to vanish from memory while saved in IndexedDB
    expect((await idb.idbGetAll('cards')).map((c) => c.id)).toEqual(['new']);
  });

  it('tells sanitizers whether records were just written by another tab', async () => {
    await idb.idbBatch([{ store: 'history', type: 'put', value: { id: 'h1', status: 'translating' } }]);
    await db.initDb();
    const seen = [];
    const col = db.collection('history', { sanitize: (r, ctx) => { seen.push(ctx.remote); return r; } });
    col.all();
    expect(seen).toEqual([false]); // boot: from an earlier session
    await idb.idbBatch([{ store: 'history', type: 'put', value: { id: 'h2', status: 'translating' } }]);
    const other = new BroadcastChannel('emulingo-db');
    other.postMessage({ type: 'changed', from: 'other-tab', collections: ['history'] });
    await vi.waitFor(() => expect(col.has('h2')).toBe(true));
    other.close();
    col.all();
    expect(seen.slice(1)).toEqual([true, true]); // live in the other tab
  });

  it('cancelPending({ erase }) tells other tabs, which stop writing and say why', async () => {
    await db.initDb();
    const heard = [];
    const other = new BroadcastChannel('emulingo-db');
    other.onmessage = (e) => heard.push(e.data.type);
    db.cancelPending({ erase: true });
    await vi.waitFor(() => expect(heard).toEqual(['erased']));
    other.close();
  });

  it('stops writing when another tab erases everything', async () => {
    await db.initDb();
    const events = [];
    db.onStorageError((e) => events.push(e));
    const other = new BroadcastChannel('emulingo-db');
    other.postMessage({ type: 'erased', from: 'other-tab' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    other.close();
    expect(events[0]).toMatchObject({ kind: 'erased' });
    expect(events[0].message).toMatch(/erased in another tab/);
    db.collection('cards').put({ id: 'late' });
    await db.flush();
    await expect(idb.idbGet('x')).rejects.toBeTruthy(); // the database can't be recreated
    localStorage.removeItem('emulingo:probe');
    const { save } = await import('../../src/core/localStorage.js');
    save('probe', 1);
    expect(localStorage.getItem('emulingo:probe')).toBe(null);
  });

  it('explains a database saved by a newer version', async () => {
    await new Promise((resolve) => {
      const r = indexedDB.open('emulingo', 99);
      r.onsuccess = () => { r.result.close(); resolve(); };
    });
    const events = [];
    db.onStorageError((e) => events.push(e));
    await db.initDb();
    expect(events[0]).toMatchObject({ kind: 'outdated' });
    expect(events[0].message).toMatch(/newer version/);
    expect(db.storageStatus().memoryOnly).toBe(true);
  });
});

describe('persistence helpers', () => {
  it('handle a missing StorageManager', async () => {
    expect(await db.requestPersistence()).toBe(null);
    expect(await db.storageEstimate()).toBe(null);
  });

  it('request persistence once granted', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist, estimate: async () => ({ usage: 5, quota: 10 }) } });
    expect(await db.requestPersistence()).toBe(true);
    expect(await db.storageEstimate()).toEqual({ usage: 5, quota: 10, persisted: false });
    vi.unstubAllGlobals();
  });
});
