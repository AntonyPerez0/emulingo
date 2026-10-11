// In-memory collections persisted to IndexedDB record stores.
// Everything is loaded once at boot (initDb), so reads are synchronous.
// Writes mark records dirty and are flushed in one transaction after
// ~400 ms (at most 2 s while writes keep coming), on pagehide and when the
// page is hidden. Write failures are never silent: onStorageError listeners
// hear about them (quota, blocked storage) and hear again on recovery.

import { openDb, closeDb, idbGetAll, idbBatch, RECORD_STORES } from './idb.js';
import { load as lsLoad, remove as lsRemove, freezeLocalStorage } from './localStorage.js';
import { isQuotaError, ID_RE, newId } from './utils.js';

export const COLLECTIONS = RECORD_STORES;

const WRITE_DELAY = 400;
const MAX_WAIT = 2000;
const RETRY_DELAYS = [5000, 15000, 60000];
const CHANNEL = 'emulingo-db';
// v1 kept everything in localStorage; these move into IndexedDB once.
// ('emulingo:roms' is migrated by rom.js, which owns the ROM library.)
const V1_KEYS = { cards: 'cards', dict: 'dict', history: 'history', activity: 'activitylog' };
const V1_DEAD_KEYS = ['streak']; // recomputed from the activity log now

const mem = new Map(COLLECTIONS.map((n) => [n, new Map()]));
const pending = new Map(COLLECTIONS.map((n) => [n, { ops: new Map(), cleared: false }]));
const sanitizers = new Map();
const sanitized = new Set();
const remoteLoaded = new Set(); // last loaded from another tab's write, not at boot
const handles = new Map();
const errorListeners = new Set();
const recoveryListeners = new Set();
const changeListeners = new Set();
const legacyHooks = new Set();
const tabId = newId('t');

let initPromise = null;
let ready = false;
let memoryOnly = false;
let frozen = false;
let timer = null;
let firstScheduled = 0;
let flushing = null;
let reloading = null;
let failures = 0;
let retryAt = 0;
let lastError = null;
let quotaMode = false;
let legacyInfo = null;
let channel = null;
let changed = null;

const validId = (id) => typeof id === 'string' && ID_RE.test(id);

// Records are frozen so a view can't change one behind the dirty tracking.
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v) && !ArrayBuffer.isView(v)) {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null || Array.isArray(v)) {
      Object.freeze(v);
      for (const k of Object.keys(v)) deepFreeze(v[k]);
    }
  }
  return v;
}

function sameJson(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// ---- change + error events ----

function emitChange(name, remote = false) {
  if (!changed) {
    changed = { names: new Set(), remote };
    queueMicrotask(() => {
      const evt = { collections: [...changed.names], remote: changed.remote };
      changed = null;
      for (const fn of changeListeners) {
        try { fn(evt); } catch (e) { console.error(e); }
      }
    });
  }
  changed.names.add(name);
  changed.remote = changed.remote || remote;
}

// fn({ collections: string[], remote: bool }) after records change (batched per tick).
export function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

const MESSAGES = {
  quota: 'Storage is full, so recent changes aren’t being saved. Export a backup, then delete cards or games you no longer need.',
  unavailable: 'This browser is blocking storage, so nothing will be kept after you close the page.',
  blocked: 'Emulingo is open in another tab with an older version. Close the other tabs, then reload this one.',
  failed: 'Couldn’t save your latest changes. Emulingo will keep trying.',
  erased: 'Your data was erased in another tab. Reload this page to start fresh.',
  // the saved data is from a newer Emulingo than this (cached) page
  outdated: 'A newer version of Emulingo saved data here. Reload this page to update.'
};

function emit(listeners, info) {
  for (const fn of listeners) {
    try { fn(info); } catch (e) { console.error(e); }
  }
}

// Other modules (settings, translation cache) report their write failures here.
export function reportStorageError(error, { source = 'db', kind } = {}) {
  const k = kind || (isQuotaError(error) ? 'quota' : 'failed');
  const isNew = !lastError || lastError.kind !== k;
  lastError = {
    name: error?.name || 'Error', // error-like, so a generic handler can read it too
    message: MESSAGES[k],
    kind: k,
    quota: k === 'quota',
    source,
    error
  };
  console.warn('[emulingo] storage error', source, error);
  if (isNew) emit(errorListeners, lastError);
}

function reportRecovered() {
  if (!lastError || memoryOnly) return;
  lastError = null;
  emit(recoveryListeners, { message: 'Your changes are being saved again.' });
}

// fn({ name, message, kind, quota, source, error }) once per problem (repeats
// of the same kind stay quiet); message is ready to show. kind:
// 'quota' | 'failed' (writes are retried), 'unavailable' | 'blocked' |
// 'outdated' (this session runs from memory only), 'erased' (another tab ran
// Erase everything; nothing is saved until reload).
// A subscriber that arrives while a problem is ongoing hears about it at once.
export function onStorageError(fn) {
  errorListeners.add(fn);
  if (lastError) {
    const info = lastError;
    queueMicrotask(() => { if (errorListeners.has(fn)) fn(info); });
  }
  return () => errorListeners.delete(fn);
}

// fn({ message }) when saving works again after a reported error (hide the banner).
export function onStorageRecovered(fn) {
  recoveryListeners.add(fn);
  return () => recoveryListeners.delete(fn);
}

export function storageStatus() {
  return { ready, memoryOnly, error: lastError };
}

// ---- collections ----

function ensureSanitized(name) {
  if (sanitized.has(name)) return;
  const fn = sanitizers.get(name);
  if (!fn) return; // raw until the owning module registers its schema
  sanitized.add(name);
  const ctx = { remote: remoteLoaded.has(name) };
  const map = mem.get(name);
  for (const [id, rec] of [...map]) {
    let clean = null;
    try { clean = fn(rec, ctx); } catch (e) { console.warn('[emulingo] dropped damaged record', name, e); }
    if (!clean || !validId(clean.id)) {
      map.delete(id);
      markOp(name, id, 'del');
      continue;
    }
    if (clean.id !== id) {
      map.delete(id);
      markOp(name, id, 'del');
    }
    if (clean === rec) continue;
    map.set(clean.id, deepFreeze(clean));
    if (clean.id !== id || !sameJson(rec, clean)) markOp(name, clean.id, 'put');
  }
  if (hasPending()) schedule();
}

function records(name) {
  ensureSanitized(name);
  return mem.get(name);
}

function markOp(name, id, op) {
  pending.get(name).ops.set(id, op);
}

function makeHandle(name) {
  const put = (rec) => {
    if (!rec || !validId(rec.id)) throw new TypeError(`Invalid ${name} record id`);
    const frozenRec = deepFreeze(rec);
    records(name).set(rec.id, frozenRec);
    markOp(name, rec.id, 'put');
    return frozenRec;
  };
  return Object.freeze({
    name,
    all: () => [...records(name).values()],
    get: (id) => records(name).get(id) ?? null,
    has: (id) => records(name).has(id),
    size: () => records(name).size,
    put(rec) {
      const out = put(rec);
      touched(name);
      return out;
    },
    putMany(list) {
      const out = list.map(put);
      if (out.length) touched(name);
      return out;
    },
    delete(id) {
      const map = records(name);
      const rec = map.get(id);
      if (!rec) return null;
      map.delete(id);
      markOp(name, id, 'del');
      touched(name);
      return rec;
    },
    clear() {
      records(name).clear();
      const p = pending.get(name);
      p.ops.clear();
      p.cleared = true;
      touched(name);
    },
    replaceAll(list) {
      this.clear();
      return this.putMany(list);
    }
  });
}

function touched(name) {
  emitChange(name);
  schedule();
}

// collection('cards', { sanitize }) -> { all, get, has, size, put, putMany, delete, clear, replaceAll }
// sanitize(raw, { remote }) -> clean record | null runs once over loaded records
// (v1 shapes included) so the owning module upgrades and validates its own
// data. remote is true when the records were just written by another open tab
// (their unfinished work is still live there).
export function collection(name, { sanitize } = {}) {
  if (!mem.has(name)) throw new Error('Unknown collection: ' + name);
  if (sanitize && sanitizers.get(name) !== sanitize) {
    sanitizers.set(name, sanitize);
    sanitized.delete(name);
  }
  let h = handles.get(name);
  if (!h) {
    h = makeHandle(name);
    handles.set(name, h);
  }
  return h;
}

// Load stored records while keeping this tab's unsaved changes on top.
// Returns false when a pending clear makes the stored list irrelevant.
function fillUnderPending(name, list, opts) {
  const p = pending.get(name);
  if (p.cleared) return false; // our own reset wins
  const map = mem.get(name);
  const ours = [];
  for (const [id, op] of p.ops) if (op === 'put' && map.has(id)) ours.push(map.get(id));
  fill(name, list, opts);
  for (const rec of ours) map.set(rec.id, rec);
  for (const [id, op] of p.ops) if (op === 'del') map.delete(id);
  return true;
}

function fill(name, list, { remote = false } = {}) {
  if (remote) remoteLoaded.add(name);
  else remoteLoaded.delete(name);
  const map = mem.get(name);
  map.clear();
  for (const rec of list || []) {
    if (rec && typeof rec === 'object' && validId(rec.id)) map.set(rec.id, deepFreeze(rec));
  }
  sanitized.delete(name);
}

// ---- writing ----

function hasPending() {
  for (const p of pending.values()) if (p.cleared || p.ops.size) return true;
  return false;
}

function schedule() {
  if (frozen || memoryOnly || !ready) return;
  const now = Date.now();
  if (!firstScheduled) firstScheduled = now;
  let wait = Math.max(0, Math.min(WRITE_DELAY, firstScheduled + MAX_WAIT - now));
  if (retryAt > now) wait = Math.max(wait, retryAt - now);
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flush().catch(() => { /* reported via onStorageError */ });
  }, wait);
}

function takeSnapshot() {
  const snap = new Map();
  for (const [name, p] of pending) {
    if (!p.cleared && !p.ops.size) continue;
    snap.set(name, { ops: p.ops, cleared: p.cleared });
    pending.set(name, { ops: new Map(), cleared: false });
  }
  return snap;
}

// Put a failed snapshot back underneath any newer changes.
function restore(snap) {
  for (const [name, s] of snap) {
    const p = pending.get(name);
    if (p.cleared) continue; // a newer clear supersedes the failed ops
    if (s.cleared) p.cleared = true;
    for (const [id, op] of s.ops) if (!p.ops.has(id)) p.ops.set(id, op);
  }
}

function buildOps(snap, filter = () => true) {
  const ops = [];
  for (const [name, s] of snap) {
    if (s.cleared && filter('clear')) ops.push({ store: name, type: 'clear' });
    for (const [id, op] of s.ops) {
      if (!filter(op)) continue;
      if (op === 'del') ops.push({ store: name, type: 'delete', key: id });
      else {
        const rec = mem.get(name).get(id);
        if (rec) ops.push({ store: name, type: 'put', value: rec });
      }
    }
  }
  return ops;
}

async function writeSnapshot(snap) {
  // After a quota failure, commit plain deletions on their own first: they
  // free space, and they must not fail together with the puts that don't fit.
  if (quotaMode) {
    const dels = buildOps(snap, (op) => op === 'del');
    if (dels.length) {
      await idbBatch(dels);
      for (const s of snap.values()) for (const [id, op] of [...s.ops]) if (op === 'del') s.ops.delete(id);
    }
  }
  await idbBatch(buildOps(snap));
}

// Write everything pending now. Rejects with the storage error on failure
// (the changes stay queued and are retried with backoff).
export function flush() {
  clearTimeout(timer);
  timer = null;
  firstScheduled = 0;
  // one write at a time; a caller arriving mid-write waits for it, then writes the rest
  if (flushing) return flushing.then(() => (hasPending() ? flush() : undefined));
  // a reload from another tab is reading: writing now would let it drop these records
  if (reloading) return reloading.then(() => flush());
  if (!ready || frozen || memoryOnly || !hasPending()) return Promise.resolve();
  const snap = takeSnapshot();
  const names = [...snap.keys()];
  const p = writeSnapshot(snap).then(() => {
    flushing = null;
    failures = 0;
    retryAt = 0;
    quotaMode = false;
    reportRecovered();
    broadcast(names);
    if (hasPending()) schedule();
  }, (err) => {
    flushing = null;
    restore(snap);
    if (frozen) return; // erase in progress: nothing left to save
    failures++;
    quotaMode = isQuotaError(err);
    retryAt = Date.now() + RETRY_DELAYS[Math.min(failures - 1, RETRY_DELAYS.length - 1)];
    reportStorageError(err, { source: 'db' });
    schedule();
    throw err;
  });
  flushing = p;
  return p;
}

// Drop queued writes (Erase everything, restore from backup). With
// { freeze: true } nothing is written again until the page reloads;
// { erase: true } (implies freeze) also tells other open tabs to stop writing,
// so they can't recreate the database Erase everything is deleting.
export function cancelPending({ freeze = false, erase = false } = {}) {
  clearTimeout(timer);
  timer = null;
  firstScheduled = 0;
  for (const name of COLLECTIONS) pending.set(name, { ops: new Map(), cleared: false });
  if (freeze || erase) {
    frozen = true;
    if (erase) {
      try { channel?.postMessage({ type: 'erased', from: tabId }); } catch { /* closed */ }
    }
    try { channel?.close(); } catch { /* already closed */ }
    channel = null;
  }
}

// ---- other tabs ----

function broadcast(names) {
  try { channel?.postMessage({ type: 'changed', from: tabId, collections: names }); } catch { /* closed */ }
}

// Reloads and flushes never overlap: a write committed while a reload reads
// would be missing from what it read, and the reload would then drop the
// written records from memory.
async function readAndApply(names) {
  while (flushing) await flushing.catch(() => {});
  if (!ready || memoryOnly || frozen) return;
  const valid = names.filter((n) => mem.has(n));
  const lists = await Promise.all(valid.map((n) => idbGetAll(n)));
  if (frozen) return;
  valid.forEach((name, i) => {
    if (fillUnderPending(name, lists[i], { remote: true })) emitChange(name, true);
  });
}

function reloadCollections(names) {
  const run = () => readAndApply(names).catch((err) => console.warn('[emulingo] reload failed', err));
  const p = (reloading || Promise.resolve()).then(run).finally(() => {
    if (reloading === p) reloading = null;
  });
  reloading = p;
  return p;
}

// Another tab ran Erase everything: stop writing here too and say so.
function erasedElsewhere() {
  cancelPending({ freeze: true });
  freezeLocalStorage();
  closeDb({ forever: true }).catch(() => {});
  reportStorageError(new DOMException('Erased in another tab', 'InvalidStateError'), { source: 'db', kind: 'erased' });
}

function installListeners() {
  if (typeof window !== 'undefined' && window.addEventListener) {
    const flushQuietly = () => { flush().catch(() => {}); };
    window.addEventListener('pagehide', flushQuietly);
    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushQuietly();
    });
  }
  if (typeof BroadcastChannel !== 'undefined' && !memoryOnly) {
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.from === tabId || frozen) return;
        if (msg.type === 'changed' && Array.isArray(msg.collections)) reloadCollections(msg.collections);
        else if (msg.type === 'erased') erasedElsewhere();
      };
    } catch { channel = null; }
  }
}

// ---- boot + v1 migration ----

// v1 records keep their shapes here (each module's sanitizer upgrades them);
// only ids are made safe so they can be keyed.
function readV1() {
  const out = {};
  let found = false;
  for (const [name, key] of Object.entries(V1_KEYS)) {
    const raw = lsLoad(key, null);
    if (raw == null) continue;
    found = true;
    let list = [];
    if (name === 'activity') {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [day, count] of Object.entries(raw)) {
          const n = Number(count);
          if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(n) && n > 0) list.push({ id: day, count: Math.round(n) });
        }
      }
    } else if (Array.isArray(raw)) {
      list = raw.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((r, i) => {
        const rec = { ...r };
        if (rec.id != null && typeof rec.id !== 'string') rec.id = String(rec.id);
        if (!validId(rec.id)) {
          const t = Number(rec.time || rec.added) || Date.now();
          rec.id = name === 'history' ? `h${t.toString(36)}-${i}` : newId(name[0]);
        }
        return rec;
      });
    }
    out[name] = list;
  }
  return found ? out : null;
}

function removeV1Keys() {
  for (const key of [...Object.values(V1_KEYS), ...V1_DEAD_KEYS]) lsRemove(key);
}

function notifyLegacy(info) {
  legacyInfo = info;
  for (const fn of legacyHooks) {
    try { fn(info); } catch (e) { console.error(e); }
  }
}

// fn({ hadLearningData }) once, when v1 localStorage data was migrated this session.
export function onLegacyMigration(fn) {
  if (legacyInfo) fn(legacyInfo);
  else legacyHooks.add(fn);
  return () => legacyHooks.delete(fn);
}

async function migrateV1() {
  const meta = mem.get('meta');
  if (meta.get('migration')?.v1) {
    removeV1Keys(); // a previous migration was saved; clear leftovers
    return;
  }
  const v1 = readV1();
  if (v1) {
    for (const [name, list] of Object.entries(v1)) {
      const map = mem.get(name);
      for (const rec of list) {
        if (!map.has(rec.id)) {
          map.set(rec.id, deepFreeze(rec));
          markOp(name, rec.id, 'put');
        }
      }
      sanitized.delete(name);
    }
  }
  const marker = deepFreeze({ id: 'migration', v1: true, at: Date.now() });
  meta.set(marker.id, marker);
  markOp('meta', marker.id, 'put');
  try {
    await flush();
    if (v1) removeV1Keys();
  } catch {
    // keep the v1 keys: the migration reruns (idempotently) next time
  }
  if (v1) notifyLegacy({ hadLearningData: (v1.cards?.length || 0) + (v1.history?.length || 0) > 0 });
}

function loadV1IntoMemory() {
  const v1 = readV1();
  if (!v1) return;
  for (const [name, list] of Object.entries(v1)) fill(name, list);
  notifyLegacy({ hadLearningData: (v1.cards?.length || 0) + (v1.history?.length || 0) > 0 });
}

// Load every collection into memory (and migrate v1 data once). Idempotent.
// If IndexedDB is unavailable the app still runs from memory and an
// 'unavailable' storage error is reported.
export function initDb() {
  initPromise ||= (async () => {
    try {
      await openDb();
      const lists = await Promise.all(COLLECTIONS.map((n) => idbGetAll(n)));
      // records written before boot finished (none in normal use) stay on top
      COLLECTIONS.forEach((n, i) => fillUnderPending(n, lists[i]));
      ready = true;
      await migrateV1();
      if (hasPending()) schedule(); // early writes, sanitizer upgrades
    } catch (e) {
      ready = true;
      memoryOnly = true;
      for (const n of COLLECTIONS) pending.set(n, { ops: new Map(), cleared: false });
      const kind = e?.name === 'BlockedError' ? 'blocked' : e?.name === 'VersionError' ? 'outdated' : 'unavailable';
      reportStorageError(e, { source: 'db', kind });
      loadV1IntoMemory();
    }
    installListeners();
    for (const n of COLLECTIONS) if (mem.get(n).size) emitChange(n);
  })();
  return initPromise;
}

export function isReady() { return ready; }

// Close the connection (Erase everything deletes the database next).
export async function closeDatabase() {
  cancelPending({ freeze: true });
  await closeDb();
}

// Ask the browser not to evict our data (call after a user gesture, e.g. the first ROM import).
export async function requestPersistence() {
  const s = globalThis.navigator?.storage;
  if (!s?.persist) return null;
  try {
    if (s.persisted && await s.persisted()) return true;
    return await s.persist();
  } catch { return false; }
}

export async function storageEstimate() {
  const s = globalThis.navigator?.storage;
  if (!s?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await s.estimate();
    const persisted = s.persisted ? await s.persisted() : false;
    return { usage, quota, persisted };
  } catch { return null; }
}
