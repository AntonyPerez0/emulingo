// ROM library: one metadata index plus ROM bytes, save states and battery-save
// mirrors in IndexedDB (kv store, see idb.js). Owns the v1 migration from
// localStorage 'emulingo:roms'.
//
// kv keys
//   roms:index           [RomRecord]  (this module is the only writer)
//   rom:<id>             ArrayBuffer  ROM bytes, stored once
//   state:<id>:manual    Uint8Array   Quick save slot
//   state:<id>:auto      Uint8Array   Autosave slot ("Resume where you left off?")
//   sram:<id>            { v, files: { path: { data, mtime } }, t }  battery-save mirror
//
// RomRecord = { id, name, title, ext, core, size, sha1, fileName, gameName,
//   saveStem, source: 'file'|'zip'|'archive', added, lastPlayed,
//   saves: { auto?: SaveMeta, manual?: SaveMeta }, v1? }
// SaveMeta = { t, core, ejs }

import * as idb from './idb.js';
import { idbGet, idbSet, idbDel, idbKeys } from './idb.js';
import { isZip, is7z, listZipEntries, findEntry, extractEntry, extOf, baseName } from './zip.js';
import { stemOf, deleteEjsSaveFiles } from './saves.js';

export const INDEX_KEY = 'roms:index';
const V1_INDEX_KEY = 'emulingo:roms';
const V1_ROMDATA_PREFIX = 'emulingo:romdata:';

export const LARGE_ROM_BYTES = 64 * 1024 * 1024;
export const MAX_ROM_BYTES = 1024 * 1024 * 1024;

// One table drives the accept list, the copy and core detection.
// `core` is the EmulatorJS system name (EJS_core).
export const SYSTEMS = [
  { core: 'gb', name: 'Game Boy and Game Boy Color', short: 'Game Boy', exts: ['gb', 'gbc'], native: [160, 144], aspect: 10 / 9 },
  { core: 'gba', name: 'Game Boy Advance', short: 'GBA', exts: ['gba'], native: [240, 160], aspect: 3 / 2 },
  { core: 'nes', name: 'NES', short: 'NES', exts: ['nes', 'fds'], native: [256, 240], aspect: 4 / 3 },
  { core: 'snes', name: 'Super Nintendo', short: 'SNES', exts: ['sfc', 'smc'], native: [256, 224], aspect: 4 / 3 },
  { core: 'segaMD', name: 'Sega Mega Drive and Genesis', short: 'Mega Drive', exts: ['md', 'gen', 'smd'], native: [320, 224], aspect: 4 / 3 },
  { core: 'segaMS', name: 'Sega Master System', short: 'Master System', exts: ['sms'], native: [256, 192], aspect: 4 / 3 },
  { core: 'segaGG', name: 'Sega Game Gear', short: 'Game Gear', exts: ['gg'], native: [160, 144], aspect: 10 / 9 },
  { core: 'nds', name: 'Nintendo DS', short: 'DS', exts: ['nds'], native: [256, 384], aspect: 2 / 3 },
  { core: 'n64', name: 'Nintendo 64', short: 'N64', exts: ['n64', 'z64', 'v64'], native: [320, 240], aspect: 4 / 3 },
  { core: 'vb', name: 'Virtual Boy', short: 'Virtual Boy', exts: ['vb'], native: [384, 224], aspect: 12 / 7 }
];

export const ARCHIVE_EXTS = ['zip', '7z'];

// extension -> EmulatorJS core, or 'detect' for archives
export const SUPPORTED = Object.freeze(Object.fromEntries([
  ...SYSTEMS.flatMap((s) => s.exts.map((ext) => [ext, s.core])),
  ...ARCHIVE_EXTS.map((ext) => [ext, 'detect'])
]));

// v1 Settings values and common names -> EmulatorJS core
const CORE_ALIASES = { gbc: 'gb', md: 'segaMD', genesis: 'segaMD', sms: 'segaMS', gg: 'segaGG' };

export class RomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RomError';
    this.code = code;
  }
}

export function systemFor(core) {
  return SYSTEMS.find((s) => s.core === core) || null;
}

export function isSupportedExt(ext) {
  return Object.hasOwn(SUPPORTED, String(ext || '').toLowerCase());
}

export function coreForExt(ext) {
  const e = String(ext || '').toLowerCase();
  const core = Object.hasOwn(SUPPORTED, e) ? SUPPORTED[e] : null;
  return core && core !== 'detect' ? core : null;
}

export function normalizeCore(core) {
  if (!core || core === 'auto') return null;
  const c = CORE_ALIASES[core] || core;
  return systemFor(c) ? c : null;
}

// Options for Settings › Emulator › System. Values are lowercase because
// store.js only accepts [a-z0-9_]; resolveCore() maps them back.
const SETTING_VALUE = { segaMD: 'md', segaMS: 'sms', segaGG: 'gg' };
export function coreSettingOptions() {
  return [
    { value: 'auto', label: 'Automatic (recommended)' },
    ...SYSTEMS.map((s) => ({ value: SETTING_VALUE[s.core] || s.core, label: s.name }))
  ];
}

// The core to boot: an explicit Settings choice wins (anything but 'auto'),
// then the core detected at import, then the file extension.
export function resolveCore(rom, override = 'auto') {
  return normalizeCore(override) || normalizeCore(rom && rom.core) || coreForExt(rom && rom.ext) || null;
}

// Core from the bytes themselves: a ZIP's first ROM entry, else the name.
export function detectCore(bytes, name = '') {
  try {
    if (bytes && isZip(bytes)) {
      const entry = findEntry(listZipEntries(bytes), (ext) => !!coreForExt(ext));
      if (entry) return coreForExt(extOf(entry.name));
    }
  } catch { /* not a readable archive */ }
  return coreForExt(extOf(name));
}

function isIOS() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  return /iPad|iPhone|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

// Value for <input type=file accept>. iOS greys out files whose extension
// has no registered type (.gba, .gb…), so it gets no filter there.
export function acceptAttr({ ios = isIOS() } = {}) {
  if (ios) return '';
  return Object.keys(SUPPORTED).map((ext) => '.' + ext).join(',');
}

// '.gb, .gbc, .gba, … or .7z' for copy ("Choose a … file").
export function supportedExtensionsLabel() {
  const exts = Object.keys(SUPPORTED).map((e) => '.' + e);
  return exts.slice(0, -1).join(', ') + ' or ' + exts[exts.length - 1];
}

// kv key names, shared with emulator.js
export const romKeys = {
  bytes: (id) => 'rom:' + id,
  state: (id, slot) => 'state:' + id + ':' + slot,
  legacyState: (id) => 'state:' + id,
  sram: (id) => 'sram:' + id
};

// ------------------------------------------------------------- hashing

function sha1Block(w, dv, off, h) {
  for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
  for (let i = 16; i < 80; i++) {
    const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
    w[i] = (x << 1) | (x >>> 31);
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
  for (let i = 0; i < 80; i++) {
    let f, k;
    if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
    else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
    else { f = b ^ c ^ d; k = 0xca62c1d6; }
    const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0;
  h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
}

// Plain-JS SHA-1 for insecure contexts (http:// LAN dev), where
// crypto.subtle does not exist. Hashes in place without a padded copy.
export function sha1Js(bytes) {
  const h = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Int32Array(80);
  const full = bytes.length - (bytes.length % 64);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = 0; off < full; off += 64) sha1Block(w, dv, off, h);
  const rem = bytes.length - full;
  const tail = new Uint8Array(rem + 9 <= 64 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[rem] = 0x80;
  const tdv = new DataView(tail.buffer);
  const bits = bytes.length * 8;
  tdv.setUint32(tail.length - 8, Math.floor(bits / 0x100000000), false);
  tdv.setUint32(tail.length - 4, bits >>> 0, false);
  for (let off = 0; off < tail.length; off += 64) sha1Block(w, tdv, off, h);
  return Array.from(h, (x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export async function sha1Hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) {
    try {
      const digest = new Uint8Array(await subtle.digest('SHA-1', bytes));
      return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch { /* fall through */ }
  }
  return sha1Js(bytes);
}

// ------------------------------------------------------------- names

// Characters EmulatorJS strips from game names. Dots become spaces:
// RetroArch would treat everything after one as an extension when naming
// the save file.
const UNSAFE_NAME = /[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/g;

function cleanStem(name) {
  const stem = stemOf(baseName(name)).replace(UNSAFE_NAME, '').replace(/\./g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 48).trim();
  return stem || 'game';
}

export function titleFor(name) {
  const stem = stemOf(baseName(name)).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return stem || 'Untitled game';
}

// v1 passed the bytes as a blob URL, so EmulatorJS wrote the ROM to the
// virtual disk as the sanitised game name without extension and RetroArch
// named the battery save after that minus its "extension". Reproduce the
// same file stem so existing .srm files keep loading.
const EJS_INVALID = /[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/g;
function v1Names(name) {
  const gameName = String(name || 'game.gb').replace(/\.[^.]+$/, '');
  const saveStem = stemOf(gameName.replace(EJS_INVALID, '').trim()) || 'game';
  return { gameName, saveStem };
}

// ------------------------------------------------------------- index

let chain = Promise.resolve();
// Index read-modify-writes run one at a time (imports, deletes and metadata
// updates can overlap: double drops, autosave meta while deleting…).
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const ID_RE = /^rom-[A-Za-z0-9_-]{1,40}$/;

function normalizeRecord(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const name = typeof r.name === 'string' && r.name ? r.name.slice(0, 255) : 'game';
  const ext = typeof r.ext === 'string' ? r.ext.toLowerCase() : extOf(name);
  const v1 = !!r.v1 || typeof r.fileName !== 'string';
  const legacy = v1Names(name);
  const gameName = typeof r.gameName === 'string' && r.gameName ? r.gameName : legacy.gameName;
  // null = unknown (a .7z unpacked by EmulatorJS names its own save file)
  const saveStem = r.saveStem === null ? null
    : typeof r.saveStem === 'string' ? r.saveStem
      : v1 ? legacy.saveStem : stemOf(r.fileName);
  return {
    id: r.id,
    name,
    title: typeof r.title === 'string' && r.title ? r.title : titleFor(name),
    ext,
    core: normalizeCore(r.core) || coreForExt(ext),
    size: Number.isFinite(r.size) ? r.size : 0,
    sha1: typeof r.sha1 === 'string' ? r.sha1 : null,
    fileName: typeof r.fileName === 'string' && r.fileName ? r.fileName : (saveStem || 'game') + (ext ? '.' + ext : ''),
    gameName,
    saveStem,
    source: ['file', 'zip', 'archive'].includes(r.source) ? r.source : 'file',
    added: Number.isFinite(r.added) ? r.added : 0,
    lastPlayed: Number.isFinite(r.lastPlayed) ? r.lastPlayed : null,
    saves: r.saves && typeof r.saves === 'object' ? { ...r.saves } : {},
    ...(v1 ? { v1: true } : {})
  };
}

function readV1Index() {
  try {
    const raw = globalThis.localStorage && localStorage.getItem(V1_INDEX_KEY);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list : null;
  } catch { return null; }
}

function removeLocal(key) {
  try { globalThis.localStorage && localStorage.removeItem(key); } catch { /* ignore */ }
}

// v1 kept one 'state:<id>' slot (written by autosave and Save alike)
async function migrateV1State(id) {
  try {
    const old = await idbGet(romKeys.legacyState(id));
    if (old == null) return;
    const auto = romKeys.state(id, 'auto');
    if ((await idbGet(auto)) == null) await idbSet(auto, old);
    await idbDel(romKeys.legacyState(id));
  } catch { /* keep the old key; sweep and delete still know it */ }
}

// db.js may already have moved the v1 list into its 'roms' record store
// (DESIGN says it shouldn't; this keeps the library either way).
async function readV1FromRecordStore() {
  try {
    const recs = typeof idb.idbGetAll === 'function' ? await idb.idbGetAll('roms') : null;
    return Array.isArray(recs) && recs.length ? recs : null;
  } catch { return null; }
}

async function migrateFromV1() {
  const v1 = readV1Index() || await readV1FromRecordStore();
  if (!v1) return [];
  const seen = new Set();
  const list = [];
  for (const r of v1) {
    const rec = normalizeRecord({ ...r, v1: true, fileName: undefined });
    if (!rec || seen.has(rec.id)) continue;
    seen.add(rec.id);
    list.push(rec);
    await migrateV1State(rec.id);
  }
  try {
    await idbSet(INDEX_KEY, list);
    removeLocal(V1_INDEX_KEY);
  } catch { /* storage full: serve the migrated list, retry next time */ }
  return list;
}

async function readIndex() {
  const stored = await idbGet(INDEX_KEY);
  if (Array.isArray(stored)) {
    // a half-finished migration may have left the v1 copy behind
    if (readV1Index()) removeLocal(V1_INDEX_KEY);
    return stored.map(normalizeRecord).filter(Boolean);
  }
  return migrateFromV1();
}

function writeIndex(list) {
  return idbSet(INDEX_KEY, list);
}

function recency(r) {
  return Math.max(r.lastPlayed || 0, r.added || 0);
}

export function listRoms() {
  return serial(async () => (await readIndex()).sort((a, b) => recency(b) - recency(a)));
}

export function getRom(id) {
  return serial(async () => (await readIndex()).find((r) => r.id === id) || null);
}

// Shallow merge; `saves` is merged one level deep. No-op for unknown ids
// (e.g. a ROM that could only be kept in memory this session).
export function updateRom(id, patch) {
  return serial(async () => {
    const list = await readIndex();
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const cur = list[i];
    list[i] = normalizeRecord({ ...cur, ...patch, id: cur.id, saves: { ...cur.saves, ...(patch && patch.saves) } });
    await writeIndex(list);
    return list[i];
  });
}

export function markPlayed(id) {
  return updateRom(id, { lastPlayed: Date.now() });
}

// ------------------------------------------------------------- bytes

function toU8(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// v0 kept small ROMs as base64 in localStorage
async function readLegacyRomData(id) {
  try {
    const raw = globalThis.localStorage && localStorage.getItem(V1_ROMDATA_PREFIX + id);
    const rec = raw ? JSON.parse(raw) : null;
    if (!rec || typeof rec.b64 !== 'string') return null;
    const bytes = base64ToBytes(rec.b64);
    try {
      await idbSet(romKeys.bytes(id), bytes.buffer);
      removeLocal(V1_ROMDATA_PREFIX + id);
    } catch { /* keep the legacy copy */ }
    return bytes;
  } catch { return null; }
}

// Uint8Array, or null when the ROM's bytes are not stored.
export async function getRomBytes(id) {
  const v = await idbGet(romKeys.bytes(id));
  if (v != null) {
    const u8 = toU8(v);
    if (u8) return u8;
    if (typeof Blob !== 'undefined' && v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  }
  return readLegacyRomData(id);
}

// Own ArrayBuffer of exactly the payload (IDB would otherwise clone the
// whole underlying buffer of a subarray).
function ownBuffer(u8) {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
}

// ------------------------------------------------------------- import

const MESSAGES = {
  unsupported: (name) => `“${name}” isn’t a game file Emulingo can play. Choose a ROM file such as .gb, .gba or .nes.`,
  'needs-system': () => 'Choose which system this game is for.',
  'no-rom-in-archive': () => 'This archive doesn’t contain a game Emulingo can play.',
  empty: () => 'This file is empty.',
  'too-large': () => 'This file is too large to play in the browser.',
  'read-failed': () => 'Couldn’t read this file. Try choosing it again.',
  corrupt: () => 'This ZIP file is damaged.',
  encrypted: () => 'This ZIP file is password-protected.'
};

function fail(code, name) {
  return new RomError(code, MESSAGES[code](name));
}

// Work out what to store and which core runs it. A ZIP is unpacked so the
// stored ROM keeps its real extension and gets its own battery-save name;
// if unpacking is impossible the archive is stored and EmulatorJS unpacks it.
async function preparePayload(bytes, file, ext, chosenCore) {
  if (isZip(bytes)) {
    let entries;
    try { entries = listZipEntries(bytes); } catch { throw fail('corrupt'); }
    const entry = findEntry(entries, (e) => !!coreForExt(e));
    if (!entry) {
      if (chosenCore) return { payload: bytes, ext: 'zip', core: chosenCore, source: 'archive', saveStem: null };
      throw fail('no-rom-in-archive');
    }
    if (entry.encrypted) throw fail('encrypted');
    if (entry.size > MAX_ROM_BYTES) throw fail('too-large');
    const innerExt = extOf(entry.name);
    const core = chosenCore || coreForExt(innerExt);
    try {
      const payload = await extractEntry(bytes, entry);
      return { payload, ext: innerExt, core, source: 'zip' };
    } catch (e) {
      if (e && e.code === 'unsupported') {
        return { payload: bytes, ext: 'zip', core, source: 'archive', saveStem: stemOf(baseName(entry.name)) };
      }
      throw fail(e && e.code === 'encrypted' ? 'encrypted' : 'corrupt');
    }
  }
  if (ext === 'zip') throw fail('corrupt');
  if (is7z(bytes) || ext === '7z') {
    if (!chosenCore) throw fail('needs-system');
    return { payload: bytes, ext: '7z', core: chosenCore, source: 'archive', saveStem: null };
  }
  const core = chosenCore || coreForExt(ext);
  if (!core) throw fail('unsupported', file.name);
  return { payload: bytes, ext: ext || 'bin', core, source: 'file' };
}

// v1 records have no hash: compare same-size candidates by content
async function findDuplicate(list, hex, size) {
  const byHash = list.find((r) => r.sha1 === hex);
  if (byHash) return byHash;
  for (const r of list) {
    if (r.sha1 || r.size !== size) continue;
    const bytes = await getRomBytes(r.id).catch(() => null);
    if (bytes && bytes.length === size && (await sha1Hex(bytes)) === hex) {
      r.sha1 = hex;
      return r;
    }
  }
  return null;
}

let persistAsked = false;
// Ask once per session for persistent storage so the browser doesn't evict
// ROMs and saves under storage pressure (Safari's 7-day rule, MISS-04).
async function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    const s = globalThis.navigator && navigator.storage;
    if (!s || typeof s.persist !== 'function') return;
    const already = typeof s.persisted === 'function' ? await s.persisted() : false;
    if (!already) await s.persist();
  } catch { /* not supported */ }
}

// Import a ROM file chosen or dropped by the user.
// Resolves { rom, bytes, duplicate, persisted, warnings } where warnings may
// hold 'large' (over 64 MB) and 'not-saved' (storage full: playable this
// session only). Rejects with a RomError whose `code` is one of
// unsupported | needs-system | no-rom-in-archive | empty | too-large |
// read-failed | corrupt | encrypted. Pass { core } (an EmulatorJS system,
// see SYSTEMS) after a 'needs-system' error to import with that system.
export async function importRomFile(file, { core: chosen = null } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw fail('read-failed');
  const name = baseName(file.name || 'game');
  const ext = extOf(name);
  const chosenCore = normalizeCore(chosen);
  if (!isSupportedExt(ext) && !chosenCore) throw fail('unsupported', name);
  if (!file.size) throw fail('empty');
  if (file.size > MAX_ROM_BYTES) throw fail('too-large');

  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { throw fail('read-failed'); }
  const prepared = await preparePayload(bytes, file, ext, chosenCore);
  bytes = null;
  const { payload } = prepared;
  if (!payload.length) throw fail('empty');

  const hex = await sha1Hex(payload);
  const id = 'rom-' + hex.slice(0, 16);
  const warnings = payload.length > LARGE_ROM_BYTES ? ['large'] : [];

  const result = await serial(async () => {
    let list;
    try { list = await readIndex(); } catch { list = null; }
    if (list) {
      const dup = list.find((r) => r.id === id) || await findDuplicate(list, hex, payload.length);
      if (dup) return storeDuplicate(list, dup, hex, payload, warnings);
    }
    const gameName = cleanStem(name) + '-' + hex.slice(0, 6);
    const rec = normalizeRecord({
      id,
      name,
      title: titleFor(name),
      ext: prepared.ext,
      core: prepared.core,
      size: payload.length,
      sha1: hex,
      gameName,
      fileName: gameName + '.' + prepared.ext,
      // undefined = the stored file names the save; null = unknown
      saveStem: prepared.saveStem === undefined ? gameName : prepared.saveStem,
      source: prepared.source,
      added: Date.now(),
      lastPlayed: null,
      saves: {}
    });
    if (!list) return { rom: rec, bytes: payload, duplicate: false, persisted: false, warnings: [...warnings, 'not-saved'] };
    try {
      await idbSet(romKeys.bytes(id), ownBuffer(payload));
    } catch {
      return { rom: rec, bytes: payload, duplicate: false, persisted: false, warnings: [...warnings, 'not-saved'] };
    }
    try {
      await writeIndex([rec, ...list]);
    } catch {
      await idbDel(romKeys.bytes(id)).catch(() => {});
      return { rom: rec, bytes: payload, duplicate: false, persisted: false, warnings: [...warnings, 'not-saved'] };
    }
    return { rom: rec, bytes: payload, duplicate: false, persisted: true, warnings };
  });
  if (result.persisted) requestPersistence();
  return result;
}

async function storeDuplicate(list, dup, hex, payload, warnings) {
  dup.added = Date.now();
  dup.sha1 = dup.sha1 || hex;
  let persisted = true;
  try {
    // the bytes may have been lost (quota, manual cleanup): store them again
    const present = await idbKeys(romKeys.bytes(dup.id));
    if (!present.includes(romKeys.bytes(dup.id))) await idbSet(romKeys.bytes(dup.id), ownBuffer(payload));
    await writeIndex(list);
  } catch { persisted = false; }
  return { rom: { ...dup }, bytes: payload, duplicate: true, persisted, warnings: persisted ? warnings : [...warnings, 'not-saved'] };
}

// ------------------------------------------------------------- delete & sweep

async function deleteKeysFor(id) {
  let extra = [];
  try { extra = await idbKeys('state:' + id + ':'); } catch { /* fixed list below */ }
  const all = new Set([romKeys.bytes(id), romKeys.state(id, 'manual'), romKeys.state(id, 'auto'), romKeys.legacyState(id), romKeys.sram(id), ...extra]);
  const results = await Promise.allSettled([...all].map((k) => idbDel(k)));
  return results.every((r) => r.status === 'fulfilled');
}

// Removes the ROM, both save-state slots, the battery-save mirror and
// EmulatorJS's own copy of its battery save. Resolves true when it existed.
// Don't call it for the game that is running (eject first).
export function deleteRom(id) {
  return serial(async () => {
    const list = await readIndex();
    const rec = list.find((r) => r.id === id) || null;
    if (rec) await writeIndex(list.filter((r) => r.id !== id));
    // blobs that fail to delete now are orphans; sweepOrphans() retries
    await deleteKeysFor(id);
    removeLocal(V1_ROMDATA_PREFIX + id);
    // v1 ROMs imported under the same file name share one battery save
    const shared = rec && list.some((r) => r.id !== id && r.saveStem === rec.saveStem);
    if (rec && rec.saveStem && !shared) {
      const FS = globalThis.EJS_emulator && globalThis.EJS_emulator.gameManager && globalThis.EJS_emulator.gameManager.FS;
      await deleteEjsSaveFiles(rec.saveStem, { FS }).catch(() => 0);
    }
    return !!rec;
  });
}

const OWNED_KEY = /^(?:rom|state|sram):(rom-[A-Za-z0-9_-]+)/;

// Delete rom:/state:/sram: keys whose ROM is not in the library (left by
// v1's 10-entry cap, failed imports or crashes). `keep` protects ids in use
// this session (a ROM that could not be persisted). Resolves the count.
export function sweepOrphans({ keep = [] } = {}) {
  return serial(async () => {
    const list = await readIndex();
    const live = new Set([...list.map((r) => r.id), ...keep]);
    const all = await idbKeys('');
    const doomed = all.filter((k) => {
      const m = OWNED_KEY.exec(String(k));
      return m && !live.has(m[1]);
    });
    const results = await Promise.allSettled(doomed.map((k) => idbDel(k)));
    return results.filter((r) => r.status === 'fulfilled').length;
  });
}

export function formatSystem(core) {
  const s = systemFor(core);
  return s ? s.name : 'Unknown system';
}
