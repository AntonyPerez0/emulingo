// Battery-save (SRAM) helpers around EmulatorJS's save folder.
//
// EmulatorJS keeps in-game saves in an Emscripten IDBFS mount at /data/saves
// (IndexedDB database '/data/saves', store 'FILE_DATA', keyed by full path).
// Its own exit handler can wipe that folder (EMU-01), so Emulingo mirrors the
// files of the running game into its own store ('sram:<romId>') and puts them
// back before the core boots when EmulatorJS's copy is missing or older.

export const SAVE_ROOT = '/data/saves';
export const SAVES_DB = '/data/saves';
const SAVES_STORE = 'FILE_DATA';

export function dirname(path) {
  const i = String(path).lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '/';
}

export function basename(path) {
  return String(path).split('/').pop();
}

// 'Pokemon Red.gb' -> 'Pokemon Red' (RetroArch names saves after the content
// file with its last extension removed)
export function stemOf(name) {
  const base = basename(name || '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function isSavePath(path) {
  return typeof path === 'string' && path.startsWith(SAVE_ROOT + '/') && !path.includes('/../');
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function statOrNull(FS, path) {
  try { return FS.stat(path); } catch { return null; }
}

function mtimeOf(st) {
  const t = st && (st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime));
  return Number.isFinite(t) ? t : 0;
}

export function mkdirp(FS, dir) {
  let cur = '';
  for (const part of String(dir).split('/')) {
    if (!part) continue;
    cur += '/' + part;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

// Every file next to `savePath` that belongs to the same game: the .srm plus
// companions such as the .rtc clock of Pokémon Gold/Silver/Crystal.
// Returns { [path]: { data: Uint8Array, mtime } } or null when there are none.
export function readSaveFiles(FS, savePath) {
  if (!FS || !isSavePath(savePath)) return null;
  const dir = dirname(savePath);
  const prefix = stemOf(savePath) + '.';
  let names;
  try { names = FS.readdir(dir); } catch { return null; }
  const files = {};
  let count = 0;
  for (const name of names) {
    // 'Red.srm' belongs to stem 'Red'; 'Red.v2.srm' belongs to 'Red.v2'
    if (!name.startsWith(prefix) || name.slice(prefix.length).includes('.')) continue;
    const path = dir + '/' + name;
    const st = statOrNull(FS, path);
    if (!st || (FS.isDir && FS.isDir(st.mode))) continue;
    try {
      files[path] = { data: new Uint8Array(FS.readFile(path)), mtime: mtimeOf(st) };
      count++;
    } catch { /* unreadable: skip */ }
  }
  return count ? files : null;
}

function sameBytes(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Same paths with the same contents (timestamps are ignored on purpose:
// RetroArch rewrites unchanged saves and we don't want to re-store them).
export function sameFiles(a, b) {
  if (!a || !b) return a === b;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && sameBytes(toBytes(a[k].data), toBytes(b[k].data)));
}

// Write mirrored files whose EmulatorJS copy is missing or older. Call it
// before the core boots (EmulatorJS's 'saveDatabaseLoaded' event) so the
// game reads them at power-on. With `stem`, files saved under another name
// are left for relocateFiles() (written now they would only be strays).
// Returns the paths written.
export function restoreSaveFiles(FS, mirror, { stem = null } = {}) {
  const files = mirror && mirror.files;
  if (!FS || !files || typeof files !== 'object') return [];
  const written = [];
  for (const [path, file] of Object.entries(files)) {
    const data = toBytes(file && file.data);
    if (!isSavePath(path) || !data) continue;
    if (stem && stemOf(path) !== stem) continue;
    const mtime = Number(file.mtime) || 0;
    const st = statOrNull(FS, path);
    // 1 s of slack: IDBFS stores timestamps with millisecond precision but
    // some FS backends round them
    if (st && mtimeOf(st) >= mtime - 1000) continue;
    try {
      mkdirp(FS, dirname(path));
      FS.writeFile(path, data);
      if (mtime && FS.utime) { try { FS.utime(path, mtime, mtime); } catch { /* keep now() */ } }
      written.push(path);
    } catch { /* read-only or full: leave EmulatorJS's copy alone */ }
  }
  return written;
}

// The mirror re-homed next to `savePath`: each file keeps its extension but
// takes the save's folder and name. A mirror belongs to one ROM, so another
// name or folder only means the ROM was imported under another file name
// (another device, a restored backup) or the core renamed its save folder.
// Returns a mirror-shaped { files } or null.
export function relocateFiles(mirror, savePath) {
  const files = mirror && mirror.files;
  if (!files || typeof files !== 'object' || !isSavePath(savePath)) return null;
  const dir = dirname(savePath);
  const stem = stemOf(savePath);
  const out = {};
  for (const [path, file] of Object.entries(files)) {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    if (!isSavePath(path) || dot <= 0) continue;
    // the exact file wins over a renamed one with the same extension
    const target = dir + '/' + stem + name.slice(dot);
    if (!out[target] || path === target) out[target] = file;
  }
  return Object.keys(out).length ? { files: out } : null;
}

function matchesStem(path, stem) {
  if (!stem || !isSavePath(path)) return false;
  const name = basename(path);
  return name.startsWith(stem + '.') && !name.slice(stem.length + 1).includes('.');
}

function openSavesDb() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(SAVES_DB); } catch { resolve(null); return; }
    // the database does not exist yet: don't create an empty one that would
    // then confuse Emscripten's own versioned open
    req.onupgradeneeded = () => { try { req.transaction.abort(); } catch { /* ignore */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

// Delete a game's battery saves from EmulatorJS's own storage, plus the
// in-memory copy of a running instance (its next sync would otherwise write
// them back). `stem` is the save file name without extension.
export async function deleteEjsSaveFiles(stem, { FS = null } = {}) {
  if (!stem) return 0;
  if (FS) {
    for (const dir of safeReaddir(FS, SAVE_ROOT)) {
      const base = SAVE_ROOT + '/' + dir;
      for (const name of safeReaddir(FS, base)) {
        const path = base + '/' + name;
        if (matchesStem(path, stem)) { try { FS.unlink(path); } catch { /* gone */ } }
      }
    }
  }
  if (typeof indexedDB === 'undefined') return 0;
  const db = await openSavesDb();
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains(SAVES_STORE)) return 0;
    return await new Promise((resolve) => {
      let removed = 0;
      const tx = db.transaction(SAVES_STORE, 'readwrite');
      const store = tx.objectStore(SAVES_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result) {
          if (matchesStem(String(key), stem)) { store.delete(key); removed++; }
        }
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => resolve(0);
      tx.onabort = () => resolve(0);
    });
  } finally {
    db.close();
  }
}

function safeReaddir(FS, dir) {
  try { return FS.readdir(dir).filter((n) => n !== '.' && n !== '..'); } catch { return []; }
}
