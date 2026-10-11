// EmulatorJS 4.2.3 integration.
//
// One emulator per page: EmulatorJS has no teardown, so switching games goes
// through ejectAndReload() (saves, then reloads with an autostart id).
// loadGame() resolves when the game is actually running (EJS 'start'), not
// on EJS_ready, which fires before the core has even downloaded.
//
// Saves (see DESIGN §3, EMU-01/02):
// - EmulatorJS's exit handler (beforeunload, its Exit button, a failed
//   start) unmounts the save folder and the IDBFS sync then deletes every
//   battery save. It is removed as soon as the save folder mounts.
// - Battery saves are flushed every 10 s, when the tab is hidden, on pagehide
//   and before eject, and mirrored to kv 'sram:<romId>'. The mirror is put
//   back before the core boots when EmulatorJS's copy is missing or older,
//   and re-homed at start when the ROM's save file name changed.
// - Save states: 'state:<id>:manual' (Quick save/load) and 'state:<id>:auto'
//   (every 60 s once the game has run 30 s, and only after the "Resume where
//   you left off?" decision, so a fresh boot never overwrites the last session).

import { idbGet, idbSet, idbKeys } from './idb.js';
import { romKeys, resolveCore, detectCore, getRom, updateRom, markPlayed } from './rom.js';
import { readSaveFiles, sameFiles, restoreSaveFiles, relocateFiles, isSavePath } from './saves.js';
import { isFrozen } from './localStorage.js';

export const EJS_VERSION = '4.2.3';
export const EJS_DATA = `https://cdn.emulatorjs.org/${EJS_VERSION}/data/`;
export const PLAYER = '#game';
export const AUTOSTART_KEY = 'emulingo:autostart';

const SRAM_FLUSH_MS = 10_000;
const AUTOSAVE_MS = 60_000;
const AUTOSAVE_MIN_RUN_MS = 30_000;
const HIDDEN_AUTOSAVE_GAP_MS = 10_000;
const LOADER_TIMEOUT_MS = 60_000; // loader.js + emulator scripts: no progress events
const STALL_TIMEOUT_MS = 90_000; // no visible progress once EmulatorJS runs (big cores compile silently)
const HARD_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 250;
const EJECT_SAVE_BUDGET_MS = 4000;
const GAME_LOCK = 'emulingo:game';
const GAME_LOCK_WAIT_MS = 2000; // a reload (Eject, another game) frees the old page's lock a moment later

// Emulingo has its own pause, restart, save/load and fullscreen controls.
// Hidden buttons also stop being invisible keyboard stops (A11Y-M1).
// Keys verified against EmulatorJS 4.2.3 defaultButtonOptions.
export const EJS_BUTTONS = Object.freeze({
  playPause: false,
  restart: false,
  saveState: false,
  loadState: false,
  quickSave: false,
  quickLoad: false,
  saveSavFiles: false,
  loadSavFiles: false,
  screenRecord: false,
  cacheManager: false,
  exitEmulation: false,
  netplay: false,
  cheat: false,
  fullscreen: false
});

// EmulatorJS 4.2.3 default keyboard map (RetroArch ids 8 = A, 0 = B)
export const DEFAULT_KEYS = Object.freeze([
  { button: 'A', key: 'Z' },
  { button: 'B', key: 'X' },
  { button: 'Start', key: 'Enter' },
  { button: 'Select', key: 'V' },
  { button: 'D-pad', key: 'Arrow keys' },
  { button: 'L', key: 'Q' },
  { button: 'R', key: 'E' }
]);

export class EmulatorError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.name = 'EmulatorError';
    this.code = code;
    this.detail = detail;
  }
}

const listeners = new Set();
let session = null; // the one game of this page
let reloadPage = () => location.reload();

function emit(type, detail = {}) {
  for (const fn of [...listeners]) {
    try { fn(type, detail); } catch (e) { console.error(e); }
  }
}

// fn(type, detail) for 'progress', 'start', 'error', 'paused', 'resumed',
// 'saved' ({ slot: 'manual'|'auto'|'sram', t }), 'loaded' ({ slot }),
// 'restarted'. Returns an unsubscribe function.
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function ejs() {
  return globalThis.window ? window.EJS_emulator || null : null;
}

function gm() {
  try { return (ejs() && ejs().gameManager) || null; } catch { return null; }
}

function now() {
  return Date.now();
}

// ------------------------------------------------------------- state queries

export function hasInstance() {
  return !!(ejs() || (session && session.injected));
}

export function isStarted() {
  const e = ejs();
  return !!(e && e.started && !e.failedToStart && session && session.started);
}

export function isPaused() {
  return isStarted() && !!ejs().paused;
}

// started, running and not failed: what OCR and autosave care about
export function isPlaying() {
  return isStarted() && !ejs().paused;
}

export function isUserPaused() {
  return !!(session && session.pauseReasons.has('user'));
}

export function currentRom() {
  return session ? session.rom : null;
}

export function getGameElement() {
  return document.querySelector(PLAYER);
}

export function getCanvas() {
  const e = ejs();
  if (!isStarted() || !e.canvas || !e.canvas.isConnected) return null;
  return e.canvas;
}

let videoDimsBroken = false;
// Native output size of the core, e.g. { w: 160, h: 144, aspect: 1.11 } for
// a Game Boy; null before start or when the core can't say.
export function getVideoDims() {
  const g = gm();
  if (!isStarted() || !g || videoDimsBroken || typeof g.functions?.getVideoDimensions !== 'function') return null;
  try {
    // call the cwrap directly: GameManager's wrapper console.warns on errors
    const w = g.functions.getVideoDimensions('width');
    const h = g.functions.getVideoDimensions('height');
    if (!(w > 0 && h > 0)) return null;
    const a = g.functions.getVideoDimensions('aspect');
    return { w, h, aspect: a > 0 ? a : w / h };
  } catch {
    videoDimsBroken = true;
    return null;
  }
}

// Systems whose pad has no L/R shoulder buttons
const NO_SHOULDERS = new Set(['gb', 'nes', 'segaMS', 'segaGG']);

function keyName(controls, id) {
  const v = String((controls[id] && controls[id].value) || '');
  return v.replace(/ arrow$/, '').replace(/^./, (c) => c.toUpperCase());
}

// Player 1's keyboard map for the key hint, [{ button, key }]. Follows
// changes made in EmulatorJS's Control Settings once the game runs.
export function getKeyMap() {
  const system = session && session.system;
  const keep = (k) => !(NO_SHOULDERS.has(system) && (k.button === 'L' || k.button === 'R'));
  const controls = ejs() && ejs().controls && ejs().controls[0];
  if (!controls) return DEFAULT_KEYS.filter(keep);
  const map = [[8, 'A'], [0, 'B'], [3, 'Start'], [2, 'Select']]
    .map(([id, button]) => ({ button, key: keyName(controls, id) }));
  // up, left, down, right
  const pad = [4, 6, 5, 7].map((id) => String((controls[id] && controls[id].value) || ''));
  if (pad.every((v) => / arrow$/.test(v))) map.push({ button: 'D-pad', key: 'Arrow keys' });
  else if (pad.every(Boolean)) map.push({ button: 'D-pad', key: [4, 6, 5, 7].map((id) => keyName(controls, id)).join(' ') });
  map.push({ button: 'L', key: keyName(controls, 10) }, { button: 'R', key: keyName(controls, 11) });
  const out = map.filter((k) => k.key && keep(k));
  return out.length ? out : DEFAULT_KEYS.filter(keep);
}

// ------------------------------------------------------------- canvas patch

// OCR reads the game canvas between frames; WebGL clears it unless
// preserveDrawingBuffer is set. Scoped to EmulatorJS's canvas (it gets the
// class 'ejs_canvas' in the EmulatorJS constructor, before the core creates
// its context) so no other WebGL user pays for the extra copy.
function installCanvasPatch() {
  const proto = globalThis.HTMLCanvasElement && HTMLCanvasElement.prototype;
  if (!proto || proto.__emulingoPatched) return;
  const original = proto.getContext;
  proto.getContext = function getContext(type, attrs) {
    if (typeof type === 'string' && type.startsWith('webgl') && this.classList && this.classList.contains('ejs_canvas')) {
      attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
    }
    return original.call(this, type, attrs);
  };
  Object.defineProperty(proto, '__emulingoPatched', { value: true });
}

// RetroArch's web frontend asks for a screen wake lock and never handles a
// refusal (hidden tab, battery saver, headless): keep that rejection away
// from the app's global error handling. Capture listeners run first.
let wakeLockGuard = false;
function installWakeLockGuard() {
  if (wakeLockGuard || !globalThis.window) return;
  wakeLockGuard = true;
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r && r.name === 'NotAllowedError' && /wake lock/i.test(String(r.message))) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

// ------------------------------------------------------------- start

function friendlyStartError(text) {
  const t = String(text || '');
  if (/download|network/i.test(t)) return 'Couldn’t download the emulator. Check your internet connection and try again.';
  if (/graphics|webgl/i.test(t)) return 'This browser’s graphics support is too old for this system.';
  if (/threads|site owner/i.test(t)) return 'This system can’t run in this browser.';
  return 'The emulator couldn’t start this game.';
}

function ejsMessageText() {
  const e = ejs();
  const el = (e && e.textElem) || document.querySelector(PLAYER + ' .ejs_error_text, ' + PLAYER + ' .ejs_loading_text');
  // textContent: no forced layout (this is also polled)
  return el ? String(el.textContent || el.innerText || '').trim() : '';
}

// EmulatorJS's own status text, e.g. "Download Game Core 45%"
export function parseProgress(text) {
  const t = String(text || '');
  let phase = 'loading';
  if (/decompress/i.test(t)) phase = 'unpack';
  else if (/download game core/i.test(t)) phase = 'download';
  else if (/download game/i.test(t)) phase = 'prepare';
  const pct = t.match(/(\d{1,3})%/);
  const mb = t.match(/([\d.]+)\s*MB/i);
  return {
    phase,
    progress: pct ? Math.min(1, Number(pct[1]) / 100) : null,
    loadedBytes: !pct && mb ? Math.round(parseFloat(mb[1]) * 1048576) : null,
    text: t
  };
}

function clearStartTimers(s) {
  clearTimeout(s.loaderTimer);
  clearTimeout(s.stallTimer);
  clearTimeout(s.hardTimer);
  clearInterval(s.pollTimer);
  if (s.observer) s.observer.disconnect();
  s.observer = null;
}

function settleStart(s, err) {
  if (s.settled) return;
  s.settled = true;
  clearStartTimers(s);
  if (err) {
    s.failed = true;
    emit('error', { phase: 'start', code: err.code, message: err.message, detail: err.detail });
    s.reject(err);
  } else {
    s.resolve();
  }
}

const START_ERRORS = {
  timeout: 'The emulator is taking too long to start. Check your internet connection and try again.',
  busy: 'A game is already running in another Emulingo tab or window. Close it there, then select Try again.',
  'loader-failed': 'Couldn’t load the emulator. Check your internet connection and try again.'
};

function failStart(s, code, detail) {
  const message = START_ERRORS[code] || friendlyStartError(detail);
  settleStart(s, new EmulatorError(code, message, detail || ''));
}

function armStall(s) {
  clearTimeout(s.stallTimer);
  s.stallTimer = setTimeout(() => failStart(s, 'timeout', ejsMessageText()), STALL_TIMEOUT_MS);
}

function reportProgress(s, onProgress) {
  const text = ejsMessageText();
  if (!text || text === s.lastProgressText) return;
  s.lastProgressText = text;
  armStall(s);
  const p = parseProgress(text);
  emit('progress', p);
  if (onProgress) { try { onProgress(p); } catch (e) { console.error(e); } }
}

function checkFailure(s) {
  const e = ejs();
  if (e && e.failedToStart) failStart(s, 'start-failed', ejsMessageText());
}

// EmulatorJS sets tabindex=-1 on the player; keyboard users must be able
// to Tab back into the game (EMU-07). The view names it; these are only
// fallbacks so the focus stop is never anonymous.
function keepGameFocusable() {
  const el = getGameElement();
  if (!el) return;
  el.setAttribute('tabindex', '0');
  if (!el.hasAttribute('role')) el.setAttribute('role', 'application');
  if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) el.setAttribute('aria-label', 'Game screen');
}

// GameManager's 'exit' handler unmounts the save folder; IDBFS then deletes
// every battery save (EMU-01). Emulingo never needs it: it reloads instead.
function dropExitHandler(e) {
  if (e && e.functions) e.functions.exit = [];
}

function onEjsReady(s, onProgress) {
  const e = ejs();
  if (!e || s.ready) return;
  s.ready = true;
  clearTimeout(s.loaderTimer);
  keepGameFocusable();
  // startGameError is how every EmulatorJS failure is reported
  const original = typeof e.startGameError === 'function' ? e.startGameError : null;
  if (original) {
    e.startGameError = function startGameError(message) {
      const r = original.call(this, message);
      queueMicrotask(() => failStart(s, 'start-failed', String(message || ejsMessageText())));
      return r;
    };
  }
  e.on('saveDatabaseLoaded', (FS) => {
    // EMU-01: GameManager registered its exit handler just before this
    // event. Drop it now, not only at start: EmulatorJS also calls it when
    // startGame() fails, and a game that starts after we gave up would wipe
    // every battery save on the next reload.
    dropExitHandler(e);
    // put the battery-save mirror back before the core reads it at power-on
    // (a save restored from a backup wins once, even over a newer copy)
    const restored = !!(s.sramMirror && s.sramMirror.restored);
    let written = [];
    try { written = restoreSaveFiles(FS, s.sramMirror, { stem: s.rom.saveStem, force: restored }); } catch { /* keep EmulatorJS's copy */ }
    if (restored) {
      const { restored: _flag, ...mirror } = s.sramMirror;
      s.sramMirror = mirror;
      s.restoredPaths = written; // saved under another name: re-homed at start
      idbSet(romKeys.sram(s.rom.id), mirror).catch(() => {});
    }
  });
  const el = getGameElement();
  if (el && typeof MutationObserver === 'function') {
    s.observer = new MutationObserver(() => reportProgress(s, onProgress));
    s.observer.observe(el, { childList: true, subtree: true, characterData: true });
  }
  armStall(s);
  reportProgress(s, onProgress);
  checkFailure(s);
}

// Load and start a game. Resolves once it runs; rejects with an
// EmulatorError (code: reload-required | no-player | needs-system |
// loader-failed | start-failed | timeout) whose message is ready to show.
// A second game needs a page reload: use ejectAndReload(id).
// opts: { onProgress({ phase, progress, loadedBytes, text }), core (Settings
// override, 'auto' = per-ROM core), volume (0..1, first run only) }
export function loadGame(rom, bytes, opts = {}) {
  if (session && !session.failed && rom && session.rom.id === rom.id && !session.started) return session.promise;
  if (session || ejs()) {
    return Promise.reject(new EmulatorError('reload-required', 'Switching games needs a quick reload.'));
  }
  if (!rom || !rom.id || !(bytes && bytes.length)) {
    return Promise.reject(new EmulatorError('start-failed', 'This game’s data is missing. Import the ROM again.'));
  }
  const el = getGameElement();
  if (!el) return Promise.reject(new EmulatorError('no-player', 'The game screen isn’t ready yet.'));
  const known = resolveCore(rom, opts.core);
  const system = known || detectCore(bytes, rom.fileName || rom.name);
  if (!system) return Promise.reject(new EmulatorError('needs-system', 'Choose which system this game is for.'));
  // v1 zips have no core on record: remember what the archive holds
  if (!known) updateRom(rom.id, { core: system }).catch(() => {});

  const s = {
    rom,
    system,
    injected: false,
    started: false,
    settled: false,
    failed: false,
    pauseReasons: new Set(),
    resume: 'none', // 'none' | 'pending' | 'done'
    runMs: 0,
    runSince: null,
    lastAutoSave: 0,
    lastMirror: null,
    sramMirror: null,
    pendingVolume: null,
    pendingMute: null,
    saveErrorAt: {}
  };
  session = s;
  s.promise = new Promise((resolve, reject) => { s.resolve = resolve; s.reject = reject; });
  // the error event is how listeners learn about it; avoid unhandled noise
  s.promise.catch(() => {});
  boot(s, bytes, opts).catch((e) => failStart(s, 'start-failed', String((e && e.message) || e)));
  return s.promise;
}

// One running game per browser profile: two tabs playing would overwrite
// each other's battery saves (every flush syncs the whole save folder, so a
// tab with an older save undoes the other's progress). Resolves false while
// another tab or window holds the game; true without Web Locks support.
function claimGameLock(waitMs = GAME_LOCK_WAIT_MS) {
  const locks = globalThis.navigator && navigator.locks;
  if (!locks || typeof locks.request !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    let opts;
    try { opts = { signal: AbortSignal.timeout(waitMs) }; } catch { opts = { ifAvailable: true }; }
    locks.request(GAME_LOCK, opts, (lock) => {
      resolve(!!lock);
      // held for the rest of the page's life: EmulatorJS can't be torn down
      return lock ? new Promise(() => {}) : undefined;
    }).catch(() => resolve(false));
  });
}

async function boot(s, bytes, opts) {
  s.hardTimer = setTimeout(() => failStart(s, 'timeout', ejsMessageText()), HARD_TIMEOUT_MS);
  if (!(await claimGameLock())) {
    failStart(s, 'busy');
    return;
  }
  if (s.settled) return;
  // read the mirror now: EmulatorJS's mount event is synchronous
  try { s.sramMirror = (await withTimeout(idbGet(romKeys.sram(s.rom.id)), 3000)) || null; } catch { s.sramMirror = null; }
  if (s.settled) return;
  installCanvasPatch();
  installWakeLockGuard();
  configure(s, bytes, opts);
  const script = document.createElement('script');
  script.src = EJS_DATA + 'loader.js';
  script.async = true;
  script.dataset.emulingo = 'ejs-loader';
  script.onerror = () => failStart(s, 'loader-failed', 'loader.js');
  s.injected = true;
  // not inside #game: EmulatorJS empties the player element
  document.body.appendChild(script);
  s.loaderTimer = setTimeout(() => { if (!ejs()) failStart(s, 'loader-failed', 'timeout'); }, LOADER_TIMEOUT_MS);
  s.pollTimer = setInterval(() => {
    if (ejs() && !s.ready) onEjsReady(s, opts.onProgress);
    if (s.ready) reportProgress(s, opts.onProgress);
    checkFailure(s);
  }, POLL_MS);
}

function configure(s, bytes, opts) {
  const { rom } = s;
  Object.assign(window, {
    EJS_player: PLAYER,
    EJS_core: s.system,
    EJS_pathtodata: EJS_DATA,
    // a File keeps the extension (Game Gear vs Master System) and the save name
    EJS_gameUrl: new File([bytes], rom.fileName || rom.name || 'game'),
    EJS_gameName: rom.gameName || rom.title || 'game',
    EJS_startOnLoaded: true,
    EJS_volume: typeof opts.volume === 'number' ? Math.min(1, Math.max(0, opts.volume)) : 0.5,
    // its popups put white text on this colour: #15803d keeps that at 5:1 (AA)
    EJS_color: '#15803d',
    EJS_backgroundColor: '#000000',
    EJS_Buttons: { ...EJS_BUTTONS },
    // English menus without fetching a localisation file
    EJS_language: 'en-US',
    EJS_disableAutoLang: false,
    EJS_ready: () => onEjsReady(s, opts.onProgress),
    EJS_onGameStart: () => onGameStart(s),
    // route EmulatorJS's own state buttons/hotkeys to the app's slots
    EJS_onSaveState: (data) => { storeManualState(s, data && data.state).catch(() => {}); },
    EJS_onLoadState: () => { quickLoad().catch(() => {}); }
  });
}

function onGameStart(s) {
  const e = ejs();
  if (!e || s.started) return;
  // EMU-01: the exit handler would delete every battery save on reload
  dropExitHandler(e);
  if (s.failed) {
    // It started after we gave up (timeout). The player is looking at the
    // error and "Try again" reloads: keep it still and silent until then.
    try { haltGame(e); } catch { /* not running after all */ }
    return;
  }
  s.started = true;
  s.runSince = now();
  s.lastMirror = (s.sramMirror && s.sramMirror.files) || null;
  keepGameFocusable();
  ensureSaveFileAtStart(s);
  enableTouchControls(e);
  applyPendingAudio(s);
  // pause() calls that came in while loading (e.g. the Play view was left)
  if (s.pauseReasons.size) {
    haltGame(e);
    stopClock(s);
  }
  startTimers(s);
  installLifecycle(s);
  watchSaveDatabase(s);
  markPlayed(s.rom.id).catch(() => {});
  settleStart(s, null);
  emit('start', { rom: s.rom, paused: !!e.paused });
}

// Fallback when the core's save path is not where the mirror was saved (the
// ROM was imported under another name, e.g. from a backup on another device,
// or a core update renamed its save folder): re-home the mirrored files there
// (with companions such as .rtc) and reboot once so the game reads them.
function ensureSaveFileAtStart(s) {
  const g = gm();
  if (!g || !s.sramMirror) return;
  try {
    const path = g.getSaveFilePath();
    if (!isSavePath(path)) return;
    // a backup's save (Replace) that the boot-time restore couldn't place
    const forced = Array.isArray(s.restoredPaths) && !s.restoredPaths.includes(path);
    s.restoredPaths = null;
    if (!forced) { try { g.FS.stat(path); return; } catch { /* missing */ } }
    const written = restoreSaveFiles(g.FS, relocateFiles(s.sramMirror, path), { force: forced });
    if (!written.includes(path)) return;
    g.loadSaveFiles();
    g.restart();
  } catch { /* the game still runs, just without the old save */ }
}

// MISS-03: iPadOS reports a desktop user agent, so EmulatorJS doesn't show
// its touch controls. Respect a choice the player made in its settings.
function enableTouchControls(e) {
  try {
    const touch = navigator.maxTouchPoints > 1 && globalThis.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (!touch || (e.settings && 'virtual-gamepad' in e.settings)) return;
    if (typeof e.changeSettingOption === 'function') e.changeSettingOption('virtual-gamepad', 'enabled', true);
    if (typeof e.toggleVirtualGamepad === 'function') e.toggleVirtualGamepad(true);
  } catch { /* cosmetic */ }
}

// ------------------------------------------------------------- run clock

function runningMs(s) {
  return s.runMs + (s.runSince ? now() - s.runSince : 0);
}

function stopClock(s) {
  if (s.runSince) { s.runMs += now() - s.runSince; s.runSince = null; }
}

function startClock(s) {
  if (!s.runSince) s.runSince = now();
}

function resetClock(s) {
  s.runMs = 0;
  s.runSince = ejs() && !ejs().paused ? now() : null;
}

// ------------------------------------------------------------- pause

// pause(true)/play(true): EmulatorJS's own play/pause buttons are hidden and
// would reappear if it updated them
function haltGame(e) {
  if (typeof e.pause === 'function') e.pause(true);
  else { gm().toggleMainLoop(0); e.paused = true; }
}

function runGame(e) {
  if (typeof e.play === 'function') e.play(true);
  else { gm().toggleMainLoop(1); e.paused = false; }
}

// Reasons stack: pause('view') when leaving the Play view, pause('user') for
// the Pause button. resume('view') does not undo a user pause (MISS-02).
// While the game is still loading the reasons are kept and applied at start,
// so a game never starts playing behind another view. Returns false when
// there is no game, or (resume) when another reason still holds it.
export function pause(reason = 'user') {
  const s = session;
  if (!s || s.failed) return false;
  s.pauseReasons.add(reason);
  if (!isStarted()) return true;
  const e = ejs();
  if (!e.paused) {
    haltGame(e);
    stopClock(s);
    flushSram();
    emit('paused', { reason });
  }
  return true;
}

export function resume(reason = 'user') {
  const s = session;
  if (!s || s.failed) return false;
  s.pauseReasons.delete(reason);
  if (s.pauseReasons.size) return false;
  if (!isStarted()) return true;
  const e = ejs();
  if (e.paused) {
    runGame(e);
    startClock(s);
    emit('resumed', { reason });
  }
  return true;
}

// ------------------------------------------------------------- battery saves

// Resolves true when the mirror is up to date, false when the write failed.
function writeMirror(s, files) {
  if (!files || sameFiles(files, s.lastMirror)) return Promise.resolve(true);
  s.lastMirror = files;
  return idbSet(romKeys.sram(s.rom.id), { v: 1, files, t: now() }).then(
    () => { emit('saved', { slot: 'sram', t: now() }); return true; },
    (err) => { s.lastMirror = null; reportSaveError('sram', err); return false; }
  );
}

// Write battery RAM to the save folder and mirror it. Returns the mirror
// write (a Promise) or null when there is nothing to flush.
function flushSram() {
  const s = session;
  const g = gm();
  if (!s || !s.started || !g || storageErased()) return null;
  try { g.saveSaveFiles(); } catch { return null; }
  let files = null;
  try { files = readSaveFiles(g.FS, g.getSaveFilePath()); } catch { files = null; }
  return writeMirror(s, files);
}

function syncSaveFolder(g, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    try {
      g.FS.syncfs(false, (err) => { clearTimeout(t); resolve(!err); });
    } catch { clearTimeout(t); resolve(false); }
  });
}

// Flush battery saves to EmulatorJS's storage and the mirror; resolves when
// both writes are done (true) or failed (false).
export async function flushSaves() {
  const g = gm();
  if (!isStarted() || !g || storageErased()) return false;
  const mirror = flushSram();
  const [m, f] = await Promise.all([mirror || Promise.resolve(true), syncSaveFolder(g)]);
  return m !== false && f;
}

// A full disk would otherwise report again on every 10 s flush.
const SAVE_ERROR_REPEAT_MS = 60_000;
function reportSaveError(slot, err) {
  if (session) {
    const last = session.saveErrorAt[slot] || 0;
    if (now() - last < SAVE_ERROR_REPEAT_MS) return;
    session.saveErrorAt[slot] = now();
  }
  emit('error', {
    phase: 'save',
    code: err && err.name === 'QuotaExceededError' ? 'storage-full' : 'save-failed',
    slot,
    message: err && err.name === 'QuotaExceededError'
      ? 'Your device is out of storage space, so progress can’t be saved.'
      : 'Couldn’t save your progress.'
  });
}

// ------------------------------------------------------------- save states

function requireStarted() {
  if (!isStarted()) throw new EmulatorError('not-started', 'Start a game first.');
  return gm();
}

function captureState(g) {
  if (typeof g.supportsStates === 'function' && !g.supportsStates()) {
    throw new EmulatorError('no-states', 'This system doesn’t support saving at any point. Use the game’s own save menu.');
  }
  try { return g.getState(); } catch (e) {
    throw new EmulatorError('save-failed', 'Couldn’t save your progress.', String(e && e.message || e));
  }
}

// Like GameManager.loadState (which also ignores the core's result code),
// minus its unlink after 5 s: RetroArch reads the file on its next frame, and
// while the game is paused that can be much later (measured: a load made
// while paused was lost). The file stays in memory until the next load.
function applyState(g, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try { g.FS.unlink('/game.state'); } catch { /* none */ }
  g.FS.writeFile('/game.state', data);
  if (typeof g.clearEJSResetTimer === 'function') g.clearEJSResetTimer();
  g.functions.loadState('game.state', 0);
}

function saveMeta() {
  const e = ejs();
  let core = null;
  try { core = e.getCore(); } catch { /* unknown */ }
  return { t: now(), core, ejs: EJS_VERSION };
}

async function storeManualState(s, state) {
  if (!state) return null;
  const meta = saveMeta();
  try {
    await idbSet(romKeys.state(s.rom.id, 'manual'), state instanceof Uint8Array ? state : new Uint8Array(state));
  } catch (err) {
    reportSaveError('manual', err);
    throw new EmulatorError(err && err.name === 'QuotaExceededError' ? 'storage-full' : 'save-failed',
      err && err.name === 'QuotaExceededError' ? 'Your device is out of storage space.' : 'Couldn’t save your progress.');
  }
  updateRom(s.rom.id, { saves: { manual: meta } }).catch(() => {});
  emit('saved', { slot: 'manual', t: meta.t });
  return { savedAt: meta.t };
}

// Quick save to the manual slot. Resolves { savedAt }.
export async function quickSave() {
  const g = requireStarted();
  if (storageErased()) throw new EmulatorError('erased', 'Your data was erased. Reload the page to save again.');
  return storeManualState(session, captureState(g));
}

// A state only loads into the core that made it, and the core ignores a
// failed load: check the core recorded at save time (EMU-23) instead of
// reporting success while nothing happened. Old states without a record pass.
async function checkStateCore(s, slot) {
  let meta = null;
  try { meta = ((await getRom(s.rom.id)) || {}).saves; } catch { return; }
  const saved = meta && meta[slot] && meta[slot].core;
  let current = null;
  try { current = ejs().getCore(); } catch { return; }
  if (saved && current && saved !== current) {
    throw new EmulatorError('incompatible-state', 'This save was made with a different emulator, so it can’t be loaded here.', saved + ' → ' + current);
  }
}

async function loadSlot(slot) {
  const g = requireStarted();
  const s = session;
  let bytes;
  try { bytes = await idbGet(romKeys.state(s.rom.id, slot)); } catch {
    throw new EmulatorError('load-failed', 'Couldn’t read the saved game.');
  }
  if (!bytes) return false;
  await checkStateCore(s, slot);
  try { applyState(g, bytes); } catch (e) {
    throw new EmulatorError('load-failed', 'Couldn’t load the saved game.', String(e && e.message || e));
  }
  s.resume = 'done';
  emit('loaded', { slot });
  return true;
}

// Quick load from the manual slot: true when loaded, false when empty.
export function quickLoad() {
  return loadSlot('manual');
}

function canAutoSave(s) {
  const e = ejs();
  return !!(s && s.started && !s.failed && e && !e.failedToStart && s.resume !== 'pending' &&
    runningMs(s) >= AUTOSAVE_MIN_RUN_MS);
}

// Autosave slot. Skipped (resolves false) until the game has run 30 s and
// while a "Resume where you left off?" question is open.
export async function autoSave() {
  const s = session;
  const g = gm();
  if (!canAutoSave(s) || !g || storageErased()) return false;
  let state;
  try { state = captureState(g); } catch { return false; }
  const meta = saveMeta();
  try {
    await idbSet(romKeys.state(s.rom.id, 'auto'), state);
  } catch (err) {
    reportSaveError('auto', err);
    return false;
  }
  s.lastAutoSave = meta.t;
  updateRom(s.rom.id, { saves: { auto: meta } }).catch(() => {});
  emit('saved', { slot: 'auto', t: meta.t });
  return true;
}

// Whether the autosave slot holds a state. Asking about the running game
// opens the resume question: autosave then waits for resumeAutoSave() or
// dismissResume() (quickLoad() and restart() also settle it).
export async function hasAutoSave(romId) {
  const key = romKeys.state(romId, 'auto');
  let has = false;
  try { has = (await idbKeys(key)).includes(key); } catch { has = false; }
  if (has && session && session.rom.id === romId && session.resume === 'none') session.resume = 'pending';
  return has;
}

// Load the autosave of the running game: true when loaded, false when empty.
export async function resumeAutoSave() {
  const ok = await loadSlot('auto');
  session.resume = 'done';
  // give the restored game the same 30 s grace before autosaving over it
  if (ok) resetClock(session);
  return ok;
}

// "Start fresh": autosave may overwrite the old slot from now on.
export function dismissResume() {
  if (session) session.resume = 'done';
}

export function restart() {
  const g = requireStarted();
  try { g.restart(); } catch (e) {
    throw new EmulatorError('restart-failed', 'Couldn’t restart the game.', String(e && e.message || e));
  }
  session.resume = 'done';
  // a rebooted game gets the same 30 s grace before autosave overwrites the
  // slot with its title screen
  resetClock(session);
  emit('restarted', {});
  return true;
}

// ------------------------------------------------------------- timers & page lifecycle

function startTimers(s) {
  s.sramTimer = setInterval(() => { if (!isPaused()) flushSram(); }, SRAM_FLUSH_MS);
  s.autoTimer = setInterval(() => { if (!isPaused()) autoSave().catch(() => {}); }, AUTOSAVE_MS);
}

function stopTimers(s) {
  clearInterval(s.sramTimer);
  clearInterval(s.autoTimer);
}

// Erase everything (in this tab or another) froze storage until the page
// reloads. Saving now would bring deleted games back: EmulatorJS persists
// /data/saves on every write, so its own save timer stops too.
function storageErased() {
  const s = session;
  if (!isFrozen() && !(s && s.savesDbGone)) return false;
  if (s && !s.savingStopped) {
    s.savingStopped = true;
    stopTimers(s);
    const e = ejs();
    if (e && e.saveSaveInterval) { clearInterval(e.saveSaveInterval); e.saveSaveInterval = null; }
  }
  return true;
}

// EmulatorJS keeps its save database open for good, which would block
// Erase everything (in this tab or another) from deleting it: let go when
// asked (versionchange), and stop saving into a database that is going away.
function watchSaveDatabase(s) {
  let dbs = null;
  try { dbs = gm().FS.filesystems.IDBFS.dbs; } catch { return; }
  for (const db of Object.values(dbs || {})) {
    if (!db || typeof db.addEventListener !== 'function') continue;
    db.addEventListener('versionchange', () => {
      // stays cached, closed: a later sync fails instead of recreating the database
      try { db.close(); } catch { /* already closed */ }
      s.savesDbGone = true;
      storageErased();
    });
  }
}

function saveOnLeave() {
  const s = session;
  if (!s || !s.started || storageErased()) return;
  flushSram();
  if (now() - s.lastAutoSave > HIDDEN_AUTOSAVE_GAP_MS) autoSave().catch(() => {});
}

function installLifecycle(s) {
  s.onVisibility = () => { if (document.visibilityState === 'hidden') saveOnLeave(); };
  s.onPageHide = () => saveOnLeave();
  document.addEventListener('visibilitychange', s.onVisibility);
  window.addEventListener('pagehide', s.onPageHide);
}

// ------------------------------------------------------------- eject

// Resolves with the promise's value, or undefined after `ms` (never rejects
// with a timeout: callers treat both as "carry on").
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export function setAutostart(id) {
  try {
    if (id) sessionStorage.setItem(AUTOSTART_KEY, id);
    else sessionStorage.removeItem(AUTOSTART_KEY);
  } catch { /* private mode: the library shows instead */ }
}

// The ROM id to start right after a reload (set by ejectAndReload), once.
export function consumeAutostart() {
  try {
    const id = sessionStorage.getItem(AUTOSTART_KEY);
    sessionStorage.removeItem(AUTOSTART_KEY);
    return id || null;
  } catch { return null; }
}

// Save everything, then reload the page (EmulatorJS can't be torn down).
// With an id, that game starts right after the reload. Never resolves.
let ejecting = null;
export function ejectAndReload(autostartId = null) {
  // double clicks: one save, one reload (the latest choice of game wins)
  setAutostart(autostartId);
  if (!ejecting) ejecting = saveAndReload();
  return ejecting;
}

async function saveAndReload() {
  const s = session;
  if (s) {
    stopTimers(s);
    if (s.started) {
      // never let a slow or full disk block the reload (EMU-05)
      await withTimeout(Promise.allSettled([flushSaves(), autoSave()]), EJECT_SAVE_BUDGET_MS);
    }
  }
  reloadPage();
  return new Promise(() => {});
}

// ------------------------------------------------------------- audio, fullscreen, layout

function applyPendingAudio(s) {
  if (s.pendingVolume != null) setVolume(s.pendingVolume);
  if (s.pendingMute != null) mute(s.pendingMute);
  s.pendingVolume = null;
  s.pendingMute = null;
}

export function setVolume(v) {
  const vol = Math.min(1, Math.max(0, Number(v) || 0));
  const e = ejs();
  if (!isStarted()) {
    if (session) session.pendingVolume = vol;
    return vol;
  }
  e.volume = vol;
  e.muted = vol === 0;
  e.setVolume(vol);
  return vol;
}

// Before start these report what will be applied at start.
export function getVolume() {
  if (session && session.pendingVolume != null) return session.pendingVolume;
  const e = ejs();
  return e && typeof e.volume === 'number' ? e.volume : 0.5;
}

export function isMuted() {
  if (session && session.pendingMute != null) return session.pendingMute;
  const e = ejs();
  return !!(e && e.muted);
}

export function mute(on = true) {
  const e = ejs();
  if (!isStarted()) {
    if (session) session.pendingMute = !!on;
    return !!on;
  }
  if (on) {
    e.muted = true;
    e.setVolume(0);
  } else {
    e.muted = false;
    if (!e.volume) e.volume = 0.5;
    e.setVolume(e.volume);
  }
  return !!on;
}

// EmulatorJS keys its layout classes off the player size; call when the
// Play view becomes visible again (MISS-01) or the stage size changes.
export function handleResize() {
  const e = ejs();
  try { if (e && typeof e.handleResize === 'function') e.handleResize(); } catch { /* not ready */ }
}

export function focusGame() {
  const el = getGameElement();
  if (el) el.focus({ preventScroll: true });
}

function stageElement() {
  const el = getGameElement();
  return el ? el.closest('[data-stage], .stage') || el : null;
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

export function canFullscreen() {
  const el = stageElement() || document.documentElement;
  const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? false;
  return !!(enabled && (el.requestFullscreen || el.webkitRequestFullscreen));
}

export function isFullscreen() {
  return !!fullscreenElement();
}

// Fullscreen the stage (game plus Emulingo's overlays), not just the canvas.
// Resolves true when fullscreen afterwards.
export async function toggleFullscreen(target = null) {
  try {
    if (fullscreenElement()) {
      await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
    } else {
      const el = target || stageElement();
      if (!el) return false;
      const request = el.requestFullscreen || el.webkitRequestFullscreen;
      if (!request) return false;
      await request.call(el);
    }
  } catch { /* denied or unsupported */ }
  setTimeout(handleResize, 50);
  return isFullscreen();
}

// ------------------------------------------------------------- test hooks

export const __testing = {
  reset() {
    if (session) { stopTimers(session); clearStartTimers(session); }
    if (session && session.onVisibility) document.removeEventListener('visibilitychange', session.onVisibility);
    if (session && session.onPageHide) window.removeEventListener('pagehide', session.onPageHide);
    session = null;
    ejecting = null;
    listeners.clear();
    videoDimsBroken = false;
    reloadPage = () => location.reload();
  },
  setReload(fn) { reloadPage = fn; },
  session: () => session
};
