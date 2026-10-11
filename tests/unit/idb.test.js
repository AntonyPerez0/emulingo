import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  idbGet, idbSet, idbDel, idbKeys, idbClear, closeDb, openDb, idbGetAll, idbBatch, deleteDatabase,
  DB_NAME, DB_VERSION, RECORD_STORES
} from '../../src/core/idb.js';

const tick = () => new Promise((r) => setImmediate(r));

function rawOpen(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await closeDb();
});

describe('kv store', () => {
  it('sets, gets, lists by prefix, deletes and clears', async () => {
    await idbSet('rom:a', new Uint8Array([1, 2]).buffer);
    await idbSet('state:a:manual', { bytes: new Uint8Array([3]) });
    await idbSet('state:b', 'x');
    expect(new Uint8Array(await idbGet('rom:a'))).toEqual(new Uint8Array([1, 2]));
    expect((await idbKeys('state:')).sort()).toEqual(['state:a:manual', 'state:b']);
    expect((await idbKeys()).length).toBe(3);
    await idbDel('state:b');
    expect(await idbGet('state:b')).toBeUndefined();
    await idbClear();
    expect(await idbKeys()).toEqual([]);
  });
});

describe('upgrade from v1', () => {
  it('keeps the v1 kv data and adds the record stores', async () => {
    const v1 = await rawOpen(DB_NAME, 1, (db) => db.createObjectStore('kv'));
    await new Promise((resolve) => {
      const tx = v1.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(new Uint8Array([9, 9]).buffer, 'rom:rom-1');
      tx.objectStore('kv').put({ aff: 'x', dic: 'y' }, 'spelldict:de');
      tx.oncomplete = resolve;
    });
    v1.close();

    const db = await openDb();
    expect(db.version).toBe(DB_VERSION);
    for (const name of ['kv', ...RECORD_STORES]) expect(db.objectStoreNames.contains(name)).toBe(true);
    expect(new Uint8Array(await idbGet('rom:rom-1'))).toEqual(new Uint8Array([9, 9]));
    expect(await idbGet('spelldict:de')).toEqual({ aff: 'x', dic: 'y' });
  });
});

describe('record stores', () => {
  it('applies batches in one transaction', async () => {
    await idbBatch([
      { store: 'cards', type: 'put', value: { id: 'c1', text: 'a' } },
      { store: 'cards', type: 'put', value: { id: 'c2', text: 'b' } },
      { store: 'dict', type: 'put', value: { id: 'd1' } }
    ]);
    await idbBatch([
      { store: 'cards', type: 'delete', key: 'c1' },
      { store: 'dict', type: 'clear' }
    ]);
    expect(await idbGetAll('cards')).toEqual([{ id: 'c2', text: 'b' }]);
    expect(await idbGetAll('dict')).toEqual([]);
  });

  it('rolls back the whole batch when one write fails', async () => {
    await expect(idbBatch([
      { store: 'cards', type: 'put', value: { id: 'ok' } },
      { store: 'cards', type: 'put', value: { notAnId: true } } // DataError: no key
    ])).rejects.toBeTruthy();
    expect(await idbGetAll('cards')).toEqual([]);
  });
});

describe('failures never hang', () => {
  it('rejects when a transaction aborts with QuotaExceededError', async () => {
    const db = await openDb();
    const real = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((...args) => {
      const tx = real(...args);
      // what Chrome does when the origin is over quota: only 'abort' fires
      Object.defineProperty(tx, 'error', { value: new DOMException('Quota exceeded', 'QuotaExceededError') });
      queueMicrotask(() => tx.abort());
      return tx;
    });
    const err = await idbSet('rom:big', new ArrayBuffer(8)).catch((e) => e);
    expect(err.name).toBe('QuotaExceededError');
    await expect(idbBatch([{ store: 'cards', type: 'put', value: { id: 'x' } }])).rejects.toMatchObject({ name: 'QuotaExceededError' });
  });

  it('rejects with AbortError when aborted without an error', async () => {
    const db = await openDb();
    const real = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((...args) => {
      const tx = real(...args);
      queueMicrotask(() => tx.abort());
      return tx;
    });
    await expect(idbDel('x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a failed open is not cached', async () => {
    const realOpen = indexedDB.open.bind(indexedDB);
    let calls = 0;
    vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
      calls++;
      if (calls === 1) throw new DOMException('denied', 'SecurityError');
      return realOpen(...args);
    });
    await expect(idbGet('a')).rejects.toMatchObject({ name: 'SecurityError' });
    await idbSet('a', 1);
    expect(await idbGet('a')).toBe(1);
  });

  it('rejects when IndexedDB is missing', async () => {
    globalThis.indexedDB = undefined;
    await expect(idbGet('a')).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  it('gives up when an old tab blocks the upgrade', async () => {
    const old = await rawOpen(DB_NAME, 1, (db) => db.createObjectStore('kv'));
    old.onversionchange = () => {}; // a v1 tab never closes its connection
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = openDb().catch((e) => e);
    for (let i = 0; i < 20; i++) await tick();
    vi.advanceTimersByTime(5000);
    const err = await p;
    expect(err.name).toBe('BlockedError');
    expect(err.message).toMatch(/another Emulingo tab/i);
    vi.useRealTimers();
    old.close();
    // after the other tab is gone, opening works again
    await idbSet('k', 'v');
    expect(await idbGet('k')).toBe('v');
  });
});

describe('upgrade failures', () => {
  it('a failed upgrade keeps the old version, so the next open upgrades properly', async () => {
    const old = await rawOpen(DB_NAME, 1, (db) => db.createObjectStore('kv'));
    await new Promise((resolve) => {
      const tx = old.transaction('kv', 'readwrite');
      tx.objectStore('kv').put('bytes', 'rom:r1');
      tx.oncomplete = resolve;
    });
    old.close();
    const real = IDBDatabase.prototype.createObjectStore;
    let calls = 0;
    const spy = vi.spyOn(IDBDatabase.prototype, 'createObjectStore').mockImplementation(function (...args) {
      if (++calls === 3) throw new DOMException('disk trouble', 'UnknownError'); // half-way through
      return real.apply(this, args);
    });
    await expect(openDb()).rejects.toMatchObject({ name: 'UnknownError' });
    spy.mockRestore();
    for (const name of RECORD_STORES) expect(await idbGetAll(name)).toEqual([]); // every store exists
    expect(await idbGet('rom:r1')).toBe('bytes');
  });
});

describe('connections', () => {
  it('retries once on a fresh connection when the old one closed under it', async () => {
    await idbSet('k', 1);
    const db = await openDb();
    db.onclose = null;
    db.onversionchange = null;
    db.close(); // e.g. closed by the browser between open and transaction
    expect(await idbGet('k')).toBe(1);
    await idbSet('k', 2);
    expect(await idbGet('k')).toBe(2);
  });


  it('closeDb lets the database be deleted and reopened', async () => {
    await idbSet('k', 1);
    await closeDb();
    expect(await deleteDatabase(DB_NAME)).toBe('deleted');
    expect(await idbGet('k')).toBeUndefined();
  });

  it('closes itself when another tab deletes the database', async () => {
    await idbSet('k', 1);
    expect(await deleteDatabase(DB_NAME)).toBe('deleted');
    expect(await idbGet('k')).toBeUndefined();
  });

  it('deleteDatabase settles when blocked by another connection', async () => {
    const other = await rawOpen('/data/saves', 21, (db) => db.createObjectStore('FILE_DATA'));
    other.onversionchange = () => {}; // EmulatorJS keeps its filesystem open
    expect(await deleteDatabase('/data/saves')).toBe('blocked');
    other.close();
  });
});
