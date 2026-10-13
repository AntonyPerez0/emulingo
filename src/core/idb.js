// IndexedDB access for the 'emulingo' database.
// Storage names keep the app's former name, Emulingo: this database, the
// 'emulingo:' localStorage keys, the 'emulingo-' caches, the backup marker
// and the cross-tab channel and lock. Renaming them would strand everything
// saved before the app became Spritespeak.
// - 'kv' (out-of-line keys) is kept from v1: rom:<id>, state:<id>…, sram:<id>,
//   spelldict:<code>. The idb* helpers below read and write it.
// - The other stores hold one record per item ({ id, … }) and are managed by
//   db.js, which batches writes with idbBatch().
// Every promise settles: requests and transactions handle error AND abort
// (a quota failure only fires 'abort', which used to hang the app forever).

export const DB_NAME = 'emulingo';
export const DB_VERSION = 2;
export const KV = 'kv';
export const RECORD_STORES = ['cards', 'dict', 'history', 'activity', 'roms', 'meta'];

const BLOCKED_GRACE_MS = 4000;
let dbPromise = null;
let closedForGood = false;

function abortError(tx, fallback = 'The storage transaction was aborted') {
  return tx?.error || new DOMException(fallback, 'AbortError');
}

const isRequest = (r) => !!r && typeof r === 'object' && 'readyState' in r && 'result' in r;

function upgrade(db) {
  if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
  for (const name of RECORD_STORES) {
    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
  }
}

export function openDb() {
  if (dbPromise) return dbPromise;
  // after Erase everything a late write must not recreate the database
  if (closedForGood) return Promise.reject(new DOMException('Storage was erased. Reload the page.', 'InvalidStateError'));
  let p = null;
  let failed = false;
  p = new Promise((resolve, reject) => {
    let settled = false;
    let blockedTimer = null;
    const fail = (err) => {
      clearTimeout(blockedTimer);
      if (settled) return;
      settled = true;
      failed = true;
      if (p && dbPromise === p) dbPromise = null; // a failed open can be retried
      reject(err);
    };
    let req;
    try {
      const factory = globalThis.indexedDB;
      if (!factory) throw new DOMException('IndexedDB is not available', 'NotSupportedError');
      req = factory.open(DB_NAME, DB_VERSION);
    } catch (e) {
      fail(e);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        upgrade(req.result);
      } catch (e) {
        try { req.transaction?.abort(); } catch { /* already finished */ } // keep the old version intact
        fail(e);
      }
    };
    req.onsuccess = () => {
      clearTimeout(blockedTimer);
      const db = req.result;
      if (settled) { db.close(); return; } // gave up on it while blocked
      settled = true;
      // let other tabs upgrade or delete the database (Erase everything)
      db.onversionchange = () => {
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      db.onclose = () => { if (dbPromise === p) dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => fail(req.error || new DOMException('Could not open storage', 'UnknownError'));
    // An older tab keeps the v1 database open and never lets go: don't wait forever.
    req.onblocked = () => {
      clearTimeout(blockedTimer);
      blockedTimer = setTimeout(() => fail(new DOMException(
        'Storage is busy in another Spritespeak tab. Close other tabs and reload.', 'BlockedError'
      )), BLOCKED_GRACE_MS);
    };
  });
  if (!failed) dbPromise = p;
  return p;
}

// { forever: true } (Erase everything) also refuses to reopen until reload.
export async function closeDb({ forever = false } = {}) {
  if (forever) closedForGood = true;
  const p = dbPromise;
  dbPromise = null;
  if (!p) return;
  try { (await p).close(); } catch { /* it never opened */ }
}

// Run fn(stores) inside one transaction; resolves with fn's return value (or
// a request result it hands back) once the transaction has completed.
async function withTx(storeNames, mode, fn) {
  let db = await openDb();
  let tx;
  try {
    tx = db.transaction(storeNames, mode);
  } catch (e) {
    if (e?.name !== 'InvalidStateError' || closedForGood) throw e;
    // the connection closed under us (another tab upgraded or deleted the
    // database): forget it and try once more on a fresh one
    if (dbPromise && (await dbPromise.catch(() => null)) === db) dbPromise = null;
    db = await openDb();
    tx = db.transaction(storeNames, mode);
  }
  return new Promise((resolve, reject) => {
    let result;
    let done = false;
    const finish = (fnOk) => { if (!done) { done = true; fnOk(); } };
    tx.oncomplete = () => finish(() => resolve(isRequest(result) ? result.result : result));
    // a failed request bubbles here; tx.error is only set once the transaction aborts
    tx.onerror = (e) => finish(() => reject(tx.error || e?.target?.error || new DOMException('Storage error', 'UnknownError')));
    tx.onabort = () => finish(() => reject(abortError(tx)));
    try {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
      result = fn(stores, tx);
    } catch (e) {
      try { tx.abort(); } catch { /* already finished */ }
      finish(() => reject(e));
    }
  });
}

// ---- kv store (v1-compatible) ----

export function idbGet(key) {
  return withTx(KV, 'readonly', (s) => s[KV].get(key));
}

export function idbSet(key, value) {
  return withTx(KV, 'readwrite', (s) => { s[KV].put(value, key); return true; });
}

export function idbDel(key) {
  return withTx(KV, 'readwrite', (s) => { s[KV].delete(key); return true; });
}

export function idbKeys(prefix = '') {
  return withTx(KV, 'readonly', (s) => {
    if (!prefix) return s[KV].getAllKeys();
    return s[KV].getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'));
  });
}

export function idbClear() {
  return withTx(KV, 'readwrite', (s) => { s[KV].clear(); return true; });
}

// ---- record stores (used by db.js) ----

export function idbGetAll(store) {
  return withTx(store, 'readonly', (s) => s[store].getAll());
}

// ops: [{ store, type: 'put'|'delete'|'clear', value?, key? }], applied in order
// in ONE transaction, so a batch is all-or-nothing.
export function idbBatch(ops) {
  const names = [...new Set(ops.map((o) => o.store))];
  if (!names.length) return Promise.resolve(true);
  return withTx(names, 'readwrite', (s) => {
    for (const op of ops) {
      const st = s[op.store];
      if (op.type === 'clear') st.clear();
      else if (op.type === 'delete') st.delete(op.key);
      else st.put(op.value);
    }
    return true;
  });
}

// Delete a whole database; settles on success, error, or after timeoutMs
// ('blocked' when another connection still holds it: other tabs are asked to
// let go (versionchange) and may do so a moment later; otherwise the delete
// finishes once they close, e.g. on reload).
export function deleteDatabase(name, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let req;
    let blocked = false;
    const timer = setTimeout(() => resolve(blocked ? 'blocked' : 'timeout'), timeoutMs);
    const done = (state) => { clearTimeout(timer); resolve(state); };
    try {
      req = globalThis.indexedDB.deleteDatabase(name);
    } catch {
      done('error');
      return;
    }
    req.onsuccess = () => done('deleted');
    req.onerror = () => done('error');
    req.onblocked = () => { blocked = true; };
  });
}
