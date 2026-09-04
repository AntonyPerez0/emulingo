// ROM library: metadata in localStorage, ROM bytes + save states in IndexedDB.

import { load, save, remove } from './localStorage.js';
import { idbSet, idbGet, idbDel } from './idb.js';

const KEY = 'roms';

export function listRoms() { return load(KEY, []); }

export function saveRom(rec) {
  const list = listRoms().filter((r) => r.id !== rec.id);
  list.unshift(rec);
  save(KEY, list.slice(0, 10));
}

export function getRom(id) {
  return listRoms().find((r) => r.id === id) || null;
}

export async function deleteRom(id) {
  await idbDel('rom:' + id);
  await idbDel('state:' + id);
  remove('romdata:' + id); // legacy
  save(KEY, listRoms().filter((r) => r.id !== id));
}

// Store ROM bytes in IndexedDB (handles big GBA ROMs that would break localStorage).
export async function storeRom(id, file) {
  const buf = await file.arrayBuffer();
  await idbSet('rom:' + id, buf);
  return buf;
}

export async function loadRomData(id) {
  let buf = await idbGet('rom:' + id);
  if (!buf) {
    // migrate legacy base64 records from localStorage
    const legacy = load('romdata:' + id, null);
    if (legacy && legacy.b64) {
      buf = base64ToArrayBuffer(legacy.b64);
      await idbSet('rom:' + id, buf);
      remove('romdata:' + id);
    }
  }
  return buf || null;
}

export function romFileName(id) {
  const rec = getRom(id);
  if (rec && rec.name) return rec.name;
  const legacy = load('romdata:' + id, null);
  return legacy ? legacy.name : 'game.gb';
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
