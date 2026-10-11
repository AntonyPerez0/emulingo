// Backup, restore and Erase everything.
// A backup is JSON: { app: 'emulingo', format: 2, exported, settings, cards,
// dictionary, history, activity, saves? }. ROM files are never included
// (they're large and the user owns them); game saves can be. Each save
// carries its ROM's id (a content hash), SHA-1 and file name, so it finds its
// game again on another device, now or once that game is added (relinkSaves).
// Every imported field goes through the same validators as stored data, so
// a crafted file can't inject markup or break the app. v1 backups
// ({ version: 1, 'emulingo:cards': '<json>', … }) are accepted too.

import { flush, collection, cancelPending } from './db.js';
import { idbGet, idbSet, idbDel, idbKeys, closeDb, deleteDatabase } from './idb.js';
import { store, migrateSettings, SETTINGS_VERSION } from './store.js';
import { sanitizeCard, sanitizeActivity, importCards, importActivity } from './srs.js';
import { sanitizeEntry, importEntries } from './dictionary.js';
import { sanitizeCapture, importCaptures } from './history.js';
import { clearTranslateCache } from './translate.js';
import { rawKeys, rawRemove, freezeLocalStorage } from './localStorage.js';
import { ID_RE, newId, hashString } from './utils.js';

export const BACKUP_FORMAT = 2;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SAVE_BYTES = 64 * 1024 * 1024;
const LIMITS = { cards: 50000, dictionary: 20000, history: 5000, activity: 20000, saves: 2000 };
const KNOWN_V2 = new Set(['app', 'format', 'exported', 'settings', 'cards', 'dictionary', 'history', 'activity', 'saves', 'roms']);
const SAVE_KINDS = ['state', 'sram'];
const SUFFIX_RE = /^(:[\w.-]{1,40}){0,3}$/;
const PENDING = 'pendingsave:';

// Databases Erase everything removes. Only known names: the origin may be
// shared with other apps (username.github.io).
export const APP_DATABASES = ['emulingo', '/data/saves', 'EmulatorJS-roms', 'EmulatorJS-core',
  'EmulatorJS-bios', 'EmulatorJS-states', 'keyval-store'];

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

const numberFormat = new Intl.NumberFormat('en');
const plural = (n, one, many) => `${numberFormat.format(n)} ${n === 1 ? one : many}`;

// ---- binary values (save states, SRAM) <-> JSON ----

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new BackupError('A game save in this backup is damaged.');
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Tag checks work across realms (IndexedDB values from a worker or iframe).
const tagOf = (v) => Object.prototype.toString.call(v);
const isArrayBuffer = (v) => tagOf(v) === '[object ArrayBuffer]';
const isBlob = (v) => (tagOf(v) === '[object Blob]' || tagOf(v) === '[object File]') && typeof v.arrayBuffer === 'function';

// Encode what the emulator stores (ArrayBuffer, typed arrays, Blobs, plain
// objects of those) as JSON. Unknown types are skipped (undefined).
export async function encodeValue(v, depth = 0) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (depth > 4 || typeof v !== 'object') return undefined;
  if (isArrayBuffer(v)) return { $ab: bytesToBase64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $u8: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (isBlob(v)) {
    return { $blob: bytesToBase64(new Uint8Array(await v.arrayBuffer())), type: String(v.type || '').slice(0, 100) };
  }
  if (Array.isArray(v)) return Promise.all(v.map((x) => encodeValue(x, depth + 1)));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const e = await encodeValue(x, depth + 1);
    if (e !== undefined) out[k] = e;
  }
  return out;
}

// Strict inverse of encodeValue; budget.bytes limits the decoded size.
export function decodeValue(v, budget = { bytes: MAX_SAVE_BYTES }, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v.length > 100000) throw new BackupError('A game save in this backup is damaged.');
    return v;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new BackupError('A game save in this backup is damaged.');
    return v;
  }
  if (depth > 4 || typeof v !== 'object') throw new BackupError('A game save in this backup is damaged.');
  const take = (b64) => {
    budget.bytes -= (b64.length * 3) / 4;
    if (budget.bytes < 0) throw new BackupError('A game save in this backup is too large.');
    return base64ToBytes(b64);
  };
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, budget, depth + 1));
  if (typeof v.$ab === 'string') return take(v.$ab).buffer;
  if (typeof v.$u8 === 'string') return take(v.$u8);
  if (typeof v.$blob === 'string') {
    const type = typeof v.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(v.type) ? v.type : '';
    return new Blob([take(v.$blob)], { type });
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k.length > 200 || k === '__proto__') continue;
    out[k] = decodeValue(x, budget, depth + 1);
  }
  return out;
}

// ---- export ----

// The ROM library ({ id, name, sha1? }). rom.js keeps it in kv 'roms:index';
// the 'roms' record store is read too in case a library lives there.
async function romList() {
  const out = [];
  try {
    const index = await idbGet('roms:index');
    if (Array.isArray(index)) out.push(...index);
  } catch { /* no library yet */ }
  out.push(...collection('roms').all());
  return out.filter((r) => r && typeof r.id === 'string' && ID_RE.test(r.id) && typeof r.name === 'string');
}

async function collectSaves() {
  const roms = new Map((await romList()).map((r) => [r.id, r]));
  const saves = [];
  const keys = [...await idbKeys('state:'), ...await idbKeys('sram:')];
  for (const key of keys) {
    const m = /^(state|sram):([\w.-]+)(.*)$/.exec(key);
    const rom = m && roms.get(m[2]);
    if (!rom || !SUFFIX_RE.test(m[3])) continue; // orphaned: no game to link it to
    const data = await encodeValue(await idbGet(key));
    if (data === undefined) continue;
    const save = { kind: m[1], romId: rom.id, rom: rom.name, suffix: m[3], data };
    if (typeof rom.sha1 === 'string' && /^[0-9a-f]{40}$/.test(rom.sha1)) save.sha1 = rom.sha1;
    saves.push(save);
  }
  // saves restored earlier whose game hasn't been added on this device yet
  for (const key of await idbKeys(PENDING)) {
    const p = await idbGet(key);
    if (!p || !SAVE_KINDS.includes(p.kind) || typeof p.rom !== 'string') continue;
    const data = await encodeValue(p.value);
    if (data === undefined) continue;
    const save = { kind: p.kind, rom: p.rom, suffix: p.suffix || '', data };
    if (p.romId) save.romId = p.romId;
    if (p.sha1) save.sha1 = p.sha1;
    saves.push(save);
  }
  return saves;
}

function settingsOverrides() {
  const all = store.all();
  const out = { settingsVersion: SETTINGS_VERSION };
  for (const key of Object.keys(all)) if (!store.isDefault(key)) out[key] = all[key];
  return out;
}

// Build the backup file. includeSaves adds save states and in-game saves.
export async function exportBackup({ includeSaves = false } = {}) {
  await flush().catch(() => { /* memory is the source of truth either way */ });
  const data = {
    app: 'emulingo',
    format: BACKUP_FORMAT,
    exported: new Date().toISOString(),
    settings: settingsOverrides(),
    cards: collection('cards').all(),
    dictionary: collection('dict').all(),
    history: collection('history').all(),
    activity: collection('activity').all()
  };
  if (includeSaves) data.saves = await collectSaves();
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `emulingo-backup-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.json`;
}

// ---- parse + validate ----

function takeList(list, { limit, sanitize, label, warnings }) {
  if (list == null) return [];
  if (!Array.isArray(list)) {
    warnings.push(`The ${label} in this backup are damaged and were skipped.`);
    return [];
  }
  const out = [];
  const ids = new Set();
  let bad = 0;
  for (const raw of list.slice(0, limit)) {
    let rec = null;
    try { rec = sanitize(raw); } catch { rec = null; }
    if (!rec || ids.has(rec.id)) { bad++; continue; }
    ids.add(rec.id);
    out.push(rec);
  }
  if (list.length > limit) warnings.push(`Only the first ${numberFormat.format(limit)} ${label} were read.`);
  if (bad) warnings.push(`${plural(bad, `damaged item in ${label} was`, `damaged items in ${label} were`)} skipped.`);
  return out;
}

function cleanRomName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
}

function takeSaves(list, warnings) {
  if (list == null) return [];
  if (!Array.isArray(list)) {
    warnings.push('The game saves in this backup are damaged and were skipped.');
    return [];
  }
  const out = [];
  const budget = { bytes: MAX_SAVE_BYTES * 4 };
  let bad = 0;
  for (const s of list.slice(0, LIMITS.saves)) {
    try {
      const rom = cleanRomName(s?.rom);
      const suffix = typeof s?.suffix === 'string' ? s.suffix : '';
      if (!SAVE_KINDS.includes(s?.kind) || !rom || !SUFFIX_RE.test(suffix) || s.data === undefined) throw new Error('bad');
      const save = { kind: s.kind, rom, suffix, value: decodeValue(s.data, budget) };
      if (typeof s.romId === 'string' && ID_RE.test(s.romId)) save.romId = s.romId;
      if (typeof s.sha1 === 'string' && /^[0-9a-f]{40}$/.test(s.sha1)) save.sha1 = s.sha1;
      out.push(save);
    } catch {
      bad++;
    }
  }
  if (bad) warnings.push(`${plural(bad, 'damaged game save was', 'damaged game saves were')} skipped.`);
  return out;
}

function summarize(format, exported, data, warnings) {
  return {
    format,
    exported,
    counts: {
      cards: data.cards.length,
      dictionary: data.dictionary.length,
      history: data.history.length,
      activity: data.activity.length,
      settings: Object.keys(data.settings).length,
      saves: data.saves.length
    },
    warnings,
    data
  };
}

function parseV2(json) {
  const warnings = [];
  if (Object.keys(json).some((k) => !KNOWN_V2.has(k))) warnings.push('Some unknown data in the file was ignored.');
  if (json.roms != null) warnings.push('Game files aren’t part of backups. Add your games again on this device.');
  const settings = migrateSettings(json.settings);
  const fallbackTgt = settings.target || store.get('target');
  const data = {
    settings,
    cards: takeList(json.cards, { limit: LIMITS.cards, label: 'cards', warnings, sanitize: (r) => sanitizeCard(r, { fallbackTgt }) }),
    dictionary: takeList(json.dictionary, { limit: LIMITS.dictionary, label: 'dictionary entries', warnings, sanitize: (r) => sanitizeEntry(r, { fallbackTgt }) }),
    history: takeList(json.history, { limit: LIMITS.history, label: 'recent lines', warnings, sanitize: (r) => sanitizeCapture(r, { stored: true }) }),
    activity: takeList(json.activity, { limit: LIMITS.activity, label: 'study days', warnings, sanitize: sanitizeActivity }),
    saves: takeSaves(json.saves, warnings)
  };
  const exported = typeof json.exported === 'string' && !Number.isNaN(Date.parse(json.exported)) ? json.exported : null;
  return summarize(2, exported, data, warnings);
}

// v1 stored each data set as a JSON string under its localStorage key.
function v1Value(json, key, warnings, label) {
  const raw = json['emulingo:' + key];
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw; // hand-edited file: validated below anyway
  try {
    return JSON.parse(raw);
  } catch {
    warnings.push(`The ${label} in this backup are damaged and were skipped.`);
    return null;
  }
}

// v1 records may lack ids (history) or carry unsafe ones: give them fresh ids.
const withIds = (list, prefix) => (Array.isArray(list)
  ? list.map((r, i) => (r && typeof r === 'object' && !(typeof r.id === 'string' && ID_RE.test(r.id))
    ? { ...r, id: prefix === 'h' ? `h${(Number(r.time) || 0).toString(36)}-${i}` : newId(prefix) }
    : r))
  : list);

function parseV1(json) {
  const warnings = [];
  const settings = migrateSettings(v1Value(json, 'settings', warnings, 'settings') || {});
  if (json['emulingo:roms'] != null) warnings.push('Game files aren’t part of backups. Add your games again on this device.');
  const fallbackTgt = settings.target || store.get('target');
  const log = v1Value(json, 'activitylog', warnings, 'study days');
  const activity = log && typeof log === 'object' && !Array.isArray(log)
    ? Object.entries(log).map(([id, count]) => ({ id, count })) : log;
  const cards = withIds(v1Value(json, 'cards', warnings, 'cards'), 'c');
  const data = {
    settings,
    cards: takeList(cards, { limit: LIMITS.cards, label: 'cards', warnings, sanitize: (r) => sanitizeCard(r, { fallbackTgt }) }),
    dictionary: takeList(withIds(v1Value(json, 'dict', warnings, 'dictionary entries'), 'd'), {
      limit: LIMITS.dictionary, label: 'dictionary entries', warnings, sanitize: (r) => sanitizeEntry(r, { fallbackTgt })
    }),
    history: takeList(withIds(v1Value(json, 'history', warnings, 'recent lines'), 'h'), {
      limit: LIMITS.history, label: 'recent lines', warnings, sanitize: (r) => sanitizeCapture(r, { stored: true })
    }),
    activity: takeList(activity, { limit: LIMITS.activity, label: 'study days', warnings, sanitize: sanitizeActivity }),
    saves: []
  };
  const exported = typeof json.exported === 'string' && !Number.isNaN(Date.parse(json.exported)) ? json.exported : null;
  return summarize(1, exported, data, warnings);
}

// Read and validate a backup file (File, Blob or JSON text). Nothing is
// written. Resolves with { format, exported, counts, warnings, data };
// rejects with a BackupError whose message can be shown as is.
export async function parseBackup(file) {
  let text;
  if (typeof file === 'string') {
    text = file;
  } else if (file && typeof file.text === 'function') {
    if (file.size > MAX_FILE_BYTES) throw new BackupError('This file is too large to be an Emulingo backup.');
    text = await file.text();
  } else {
    throw new BackupError('Choose an Emulingo backup file.');
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BackupError('This file isn’t an Emulingo backup (it couldn’t be read).');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new BackupError('This file isn’t an Emulingo backup.');
  if (json.app === 'emulingo' && json.format === BACKUP_FORMAT) return parseV2(json);
  if (json.app === 'emulingo' && Number(json.format) > BACKUP_FORMAT) {
    throw new BackupError('This backup was made by a newer version of Emulingo. Update the app, then try again.');
  }
  if (json.version === 1 && Object.keys(json).some((k) => k.startsWith('emulingo:'))) return parseV1(json);
  throw new BackupError('This file isn’t an Emulingo backup.');
}

// ---- apply ----

const pendingKey = (s) => `${PENDING}${s.kind}:${hashString(s.romId || s.rom.toLowerCase())}${s.suffix}`;

// The game a save belongs to: same ROM id (ids are content hashes, so the
// same file matches on any device), same SHA-1, or the same file name.
function findRom(roms, save) {
  return roms.find((r) => save.romId && r.id === save.romId) ||
    roms.find((r) => save.sha1 && r.sha1 === save.sha1) ||
    roms.find((r) => r.name.toLowerCase() === save.rom.toLowerCase()) || null;
}

// A battery save restored in Replace mode must beat EmulatorJS's own copy,
// which is newer by its timestamps: the emulator writes a flagged mirror back
// at the next start whatever the dates say, then clears the flag.
const valueToRestore = (s, overwrite) => (overwrite && s.kind === 'sram' && s.value && typeof s.value === 'object' && s.value.files
  ? { ...s.value, restored: true }
  : s.value);

async function restoreSaves(saves, { overwrite }) {
  const roms = await romList();
  let linked = 0;
  let waiting = 0;
  for (const s of saves) {
    const rom = findRom(roms, s);
    if (rom) {
      const key = `${s.kind}:${rom.id}${s.suffix}`;
      if (!overwrite && (await idbGet(key)) !== undefined) continue; // never clobber newer progress
      await idbSet(key, valueToRestore(s, overwrite));
      linked++;
    } else {
      const rec = { kind: s.kind, rom: s.rom, suffix: s.suffix, value: valueToRestore(s, overwrite) };
      if (s.romId) rec.romId = s.romId;
      if (s.sha1) rec.sha1 = s.sha1;
      await idbSet(pendingKey(s), rec);
      waiting++;
    }
  }
  return { linked, waiting };
}

// Call after a game is added to the library: moves restored saves that
// belong to it (same id, SHA-1 or file name) into place. Existing saves are
// kept unless overwrite is set. Resolves with how many were linked.
export async function relinkSaves(rom, { overwrite = false } = {}) {
  if (!rom || typeof rom.id !== 'string' || !ID_RE.test(rom.id) || typeof rom.name !== 'string') return 0;
  let n = 0;
  for (const key of await idbKeys(PENDING)) {
    const p = await idbGet(key);
    if (!p || typeof p.rom !== 'string' || !SAVE_KINDS.includes(p.kind)) continue;
    if (!findRom([rom], p)) continue;
    const target = `${p.kind}:${rom.id}${SUFFIX_RE.test(p.suffix || '') ? p.suffix || '' : ''}`;
    if (overwrite || (await idbGet(target)) === undefined) {
      await idbSet(target, p.value);
      n++;
    }
    await idbDel(key);
  }
  return n;
}

// Write a parsed backup. 'replace' swaps cards, dictionary, history, study
// days and settings for the backup's; 'merge' adds to what's here and keeps
// the current settings (unless this device hasn't been set up yet).
// Game saves never overwrite existing ones in 'merge' mode.
// Resolves with what was written; rejects if storage refuses the data.
export async function applyBackup(summary, { mode = 'merge', includeSaves = true } = {}) {
  const data = summary?.data;
  if (!data || !Array.isArray(data.cards)) throw new BackupError('Nothing to restore.');
  if (mode !== 'merge' && mode !== 'replace') throw new TypeError('mode must be merge or replace');
  const result = {
    cards: importCards(data.cards, { mode }),
    dictionary: importEntries(data.dictionary, { mode }),
    history: importCaptures(data.history, { mode }),
    activity: importActivity(data.activity, { mode }),
    settings: 0,
    saves: { linked: 0, waiting: 0 }
  };
  if (mode === 'replace' || !store.get('onboarded')) {
    // backups hold only changed settings: the game language and onboarding
    // stay as they are here unless the backup says otherwise
    if (mode === 'replace') store.reset({ keep: ['source', 'onboarded'] });
    for (const [key, value] of Object.entries(data.settings || {})) {
      if (key !== 'settingsVersion' && store.set(key, value)) result.settings++;
    }
  }
  // v1 backups predate onboarding: restored study data means this person is set up
  const restoredStudy = data.cards.length + (data.history?.length || 0) > 0;
  if (restoredStudy && store.get('source') && !store.get('onboarded')) store.set('onboarded', true);
  if (includeSaves && data.saves?.length) {
    result.saves = await restoreSaves(data.saves, { overwrite: mode === 'replace' });
  }
  await flush();
  return result;
}

// Simple confirm text for the UI, e.g. "128 cards, 940 dictionary entries and 3 game saves".
export function describeCounts(counts) {
  const parts = [];
  if (counts.cards) parts.push(plural(counts.cards, 'card', 'cards'));
  if (counts.dictionary) parts.push(plural(counts.dictionary, 'dictionary entry', 'dictionary entries'));
  if (counts.history) parts.push(plural(counts.history, 'recent line', 'recent lines'));
  if (counts.saves) parts.push(plural(counts.saves, 'game save', 'game saves'));
  if (!parts.length) return 'no data';
  return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// ---- erase everything ----

function sessionKeys(prefix) {
  const out = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(prefix)) out.push(k);
    }
  } catch { /* unavailable */ }
  return out;
}

// Remove everything Emulingo and EmulatorJS stored on this device. Pending
// writes are dropped and further writes blocked; the UI reloads afterwards.
// Each step runs even if an earlier one fails. Resolves with a report.
export async function wipeAll() {
  const report = { databases: {}, localStorage: 0, caches: 0, serviceWorkers: 0 };
  cancelPending({ erase: true }); // other open tabs stop writing too
  try { clearTranslateCache(); } catch { /* best effort */ }
  freezeLocalStorage();
  try { await closeDb({ forever: true }); } catch { /* not open */ }
  const results = await Promise.all(APP_DATABASES.map((name) => deleteDatabase(name).catch(() => 'error')));
  APP_DATABASES.forEach((name, i) => { report.databases[name] = results[i]; });
  for (const key of [...rawKeys('emulingo:'), ...rawKeys('ejs-')]) {
    rawRemove(key);
    report.localStorage++;
  }
  for (const key of sessionKeys('emulingo:')) {
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  }
  try {
    if (globalThis.caches?.keys) {
      for (const name of await caches.keys()) {
        if (name.startsWith('emulingo') && await caches.delete(name)) report.caches++;
      }
    }
  } catch { /* Cache Storage unavailable */ }
  try {
    const sw = globalThis.navigator?.serviceWorker;
    if (sw?.getRegistrations) {
      const scope = new URL('./', globalThis.document?.baseURI || globalThis.location?.href).href;
      for (const reg of await sw.getRegistrations()) {
        if (reg.scope.startsWith(scope) && await reg.unregister()) report.serviceWorkers++;
      }
    }
  } catch { /* no service worker support */ }
  return report;
}

