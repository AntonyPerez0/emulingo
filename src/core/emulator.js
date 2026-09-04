// EmulatorJS integration: loads the player, exposes game canvas for OCR.

import { load, save } from './localStorage.js';
import { romFileName } from './rom.js';

let currentRomId = null;
let readyResolve = null;

const EJS_BASE = 'https://cdn.emulatorjs.org/stable/data/';

export function isLoaded() { return currentRomId !== null; }

export function currentRom() { return currentRomId; }

export function getLastRomId() { return load('lastRomId', null); }
export function setLastRomId(id) { save('lastRomId', id); }

export async function loadRom(id, opts = {}) {
  currentRomId = id;
  setLastRomId(id);

  const container = document.getElementById('game');
  container.innerHTML = '';

  const settings = {
    ...(opts.fastBoot ? { fastForwardOnLoad: false } : {}),
    startOnLoaded: true,
    colorScheme: 'dark'
  };

  window.EJS_player = '#game';
  window.EJS_core = opts.core || 'auto';
  window.EJS_gameName = (romFileName(id) || 'game').replace(/\.[^.]+$/, '');
  window.EJS_gameUrl = createObjectUrlFor(id);
  window.EJS_pathtodata = EJS_BASE + 'data/';
  window.EJS_startOnLoaded = true;
  window.EJS_colorScheme = 'dark';
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

export function snapshot(scale = 3) {
  const src = getGameCanvas();
  if (!src || src.width < 10) return null;
  const w = src.width, h = src.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  try {
    ctx.drawImage(src, 0, 0, w, h, 0, 0, w, h);
  } catch {
    return null;
  }
  return out;
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
    return !!(window.EJS_emulator && window.EJS_emulator.playing);
  } catch { return false; }
}
