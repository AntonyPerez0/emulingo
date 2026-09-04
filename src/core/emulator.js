// EmulatorJS integration: loads the player, exposes game canvas for OCR.

import { load, save } from './localStorage.js';
import { romFileName } from './rom.js';

let currentRomId = null;
let readyResolve = null;

const EJS_BASE = 'https://cdn.emulatorjs.org/stable/data/';

// Force preserveDrawingBuffer on WebGL contexts created by the emulator so
// canvas readbacks (OCR snapshots) always contain the presented frame.
// Without this, drawImage/readPixels between render passes returns cleared
// buffers and OCR has nothing to read.
if (typeof HTMLCanvasElement !== 'undefined' && !HTMLCanvasElement.prototype.__emulingoPatched) {
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (typeof type === 'string' && type.includes('webgl')) {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    return origGetContext.call(this, type, attrs);
  };
  HTMLCanvasElement.prototype.__emulingoPatched = true;
}

export function isLoaded() { return currentRomId !== null; }

export function currentRom() { return currentRomId; }

export function getLastRomId() { return load('lastRomId', null); }
export function setLastRomId(id) { save('lastRomId', id); }

// Map our Settings "core" values to EmulatorJS core names.
const CORE_ALIASES = { gb: 'gb', gbc: 'gb', gba: 'gba', nes: 'nes', snes: 'snes', md: 'segaMD', nds: 'nds' };

// EmulatorJS cannot auto-detect the system from a blob URL (no extension),
// so derive the core from the ROM's original file name.
function detectCoreFromName(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const map = { gb: 'gb', gbc: 'gb', gba: 'gba', nes: 'nes', fds: 'nes', smc: 'snes', sfc: 'snes', md: 'segaMD', gen: 'segaMD', smd: 'segaMD', nds: 'nds', sms: 'segaMS', gg: 'segaGG', vb: 'vb', n64: 'n64', z64: 'n64' };
  return map[ext] || '';
}

export async function loadRom(id, opts = {}) {
  currentRomId = id;
  setLastRomId(id);

  const container = document.getElementById('game');
  container.innerHTML = '';

  const name = romFileName(id) || 'game.gb';
  const core = opts.core && opts.core !== 'auto' ? (CORE_ALIASES[opts.core] || opts.core) : detectCoreFromName(name);

  window.EJS_player = '#game';
  window.EJS_core = core || 'gb';
  window.EJS_gameName = name.replace(/\.[^.]+$/, '');
  window.EJS_gameUrl = createObjectUrlFor(id);
  window.EJS_pathtodata = EJS_BASE;
  window.EJS_startOnLoaded = true;
  window.EJS_Volume = 0.6;
  window.EJS_ready = () => { if (readyResolve) { readyResolve(); readyResolve = null; } };

  const script = document.createElement('script');
  script.src = EJS_BASE + 'loader.js';
  script.dataset.emulator = 'loader';
  container.appendChild(script);

  await new Promise((resolve, reject) => {
    readyResolve = resolve;
    setTimeout(() => reject(new Error('Emulator timed out loading (check your internet connection).')), 60000);
    script.onerror = () => reject(new Error('Failed to load EmulatorJS (check your internet connection).'));
  });
}

export function quit() {
  flushSram();
  currentRomId = null;
  const container = document.getElementById('game');
  if (container) container.innerHTML = '';
}

// ---- save states / SRAM ----

function gameManager() {
  try { return (window.EJS_emulator && window.EJS_emulator.gameManager) || null; }
  catch { return null; }
}

export function canSaveState() {
  const gm = gameManager();
  return !!(gm && typeof gm.getState === 'function');
}

// Flush battery save (in-game save slots, e.g. Pokémon "Save") to emulator storage.
export function flushSram() {
  try { gameManager()?.saveSaveFiles?.(); } catch {}
}

// Export a full save state (snapshot of the whole machine) as Uint8Array, or null.
export async function exportState() {
  try {
    const gm = gameManager();
    if (!gm || typeof gm.getState !== 'function') return null;
    const state = await gm.getState();
    if (!state) return null;
    return state instanceof Uint8Array ? state : new Uint8Array(state);
  } catch { return null; }
}

export async function importState(bytes) {
  try {
    const gm = gameManager();
    if (!gm || typeof gm.loadState !== 'function') return false;
    await gm.loadState(bytes);
    return true;
  } catch { return false; }
}

let objectUrl = null;
function createObjectUrlFor(id) {
  // EmulatorJS accepts URLs; use IndexedDB-stored blob via object URL
  const data = window.__emulingoRomBytes && window.__emulingoRomBytes[id];
  if (data) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([data]));
    return objectUrl;
  }
  return '';
}

export function setRomBytes(id, bytes) {
  if (!window.__emulingoRomBytes) window.__emulingoRomBytes = {};
  window.__emulingoRomBytes[id] = bytes;
}

// ---- canvas access for OCR ----
export function getGameCanvas() {
  const c = document.querySelector('#game canvas');
  return c || null;
}

// True if every sampled pixel is fully transparent - i.e. the WebGL drawing
// buffer was already cleared (happens when reading outside the render loop).
function isCleared(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let checked = 0;
    const step = Math.max(4, ((d.length / 4 / 2048) | 0) * 4);
    for (let i = 3; i < d.length; i += step) {
      checked++;
      if (d[i] !== 0) return false;
    }
    return checked > 0;
  } catch { return false; }
}

function grabFrame(src) {
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(src, 0, 0); } catch { return null; }
  return out;
}

// Grab the current game frame. WebGL canvases without preserveDrawingBuffer
// read back empty between frames, so if the first grab is cleared we retry
// inside requestAnimationFrame callbacks - the buffer holds the presented
// frame right after the emulator's own render pass. A few tries smooth out
// the race between our callback and the emulator's render loop.
export function snapshot() {
  const src = getGameCanvas();
  if (!src || src.width < 10 || src.height < 10) return Promise.resolve(null);
  const first = grabFrame(src);
  if (first && !isCleared(first)) return Promise.resolve(first);
  return new Promise((resolve) => {
    let tries = 0;
    const attempt = () => {
      const out = grabFrame(src);
      if ((out && !isCleared(out)) || ++tries >= 6) resolve(out);
      else requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  });
}

export function restartGame() {
  try {
    if (window.EJS_emulator && window.EJS_emulator.restart) window.EJS_emulator.restart();
  } catch {}
}

export function pressButton(name) {
  // EmulatorJS exposes gamepad control via EJS_emulator.gameManager
  try {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (gm && gm.simulateInput) {
      const map = { up: 0, down: 1, left: 2, right: 3, a: 8, b: 0, start: 3, select: 2, l: 10, r: 11 };
      const idx = map[name];
      if (idx === undefined) return;
      const val = name === 'a' || name === 'b' || name === 'l' || name === 'r' ? 1 : 1;
      gm.simulateInput(0, idx, val);
      setTimeout(() => gm.simulateInput(0, idx, 0), 100);
    }
  } catch {}
}

export function isPlaying() {
  try {
    const e = window.EJS_emulator;
    if (!e) return false;
    if (e.playing === true) return true;
    return !!getGameCanvas();
  } catch { return false; }
}
