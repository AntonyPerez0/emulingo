// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const kv = vi.hoisted(() => {
  const map = new Map();
  const state = { failSet: null, records: {} };
  return {
    map,
    state,
    api: {
      idbGet: vi.fn(async (k) => map.get(k)),
      idbSet: vi.fn(async (k, v) => {
        if (state.failSet && state.failSet(k)) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        map.set(k, v);
      }),
      idbDel: vi.fn(async (k) => { map.delete(k); }),
      idbKeys: vi.fn(async (prefix = '') => [...map.keys()].filter((k) => String(k).startsWith(prefix))),
      idbClear: vi.fn(async () => map.clear()),
      idbGetAll: vi.fn(async (store) => state.records[store] || []),
      closeDb: vi.fn()
    }
  };
});
vi.mock('../../src/core/idb.js', () => kv.api);
// Erase everything freezes storage for the rest of the page's life
const storage = vi.hoisted(() => ({ frozen: false }));
vi.mock('../../src/core/localStorage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isFrozen: () => storage.frozen
}));

// keep the real getContext out of jsdom (it logs "not implemented")
const getContextSpy = vi.fn(() => null);
HTMLCanvasElement.prototype.getContext = getContextSpy;

const emu = await import('../../src/core/emulator.js');
const { makeZip } = await import('../e2e-emu/fixtures.mjs');
const { EJS_DATA, EJS_BUTTONS, EmulatorError, __testing } = emu;

const ROM = {
  id: 'rom-0123456789abcdef',
  name: 'Test Game.gb',
  title: 'Test Game',
  ext: 'gb',
  core: 'gb',
  fileName: 'Test Game-012345.gb',
  gameName: 'Test Game-012345',
  saveStem: 'Test Game-012345'
};
const BYTES = new Uint8Array(32768).fill(7);
const SAVE_DIR = '/data/saves/Gambatte';
const SAVE_PATH = SAVE_DIR + '/Test Game-012345.srm';

function makeFS() {
  const files = new Map();
  const dirs = new Set(['/']);
  const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  return {
    files,
    dirs,
    stat(p) {
      if (files.has(p)) return { mode: 0o100644, mtime: new Date(files.get(p).mtime) };
      if (dirs.has(p)) return { mode: 0o040755, mtime: new Date(0) };
      throw new Error('ENOENT');
    },
    isDir: (mode) => (mode & 0o170000) === 0o040000,
    mkdir(p) { if (dirs.has(p)) throw new Error('EEXIST'); dirs.add(p); },
    writeFile(p, d) { files.set(p, { data: new Uint8Array(d), mtime: Date.now() }); },
    readFile(p) { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p).data; },
    readdir(d) {
      return ['.', '..', ...[...files.keys(), ...dirs].filter((p) => p !== d && parent(p) === d).map((p) => p.split('/').pop())];
    },
    unlink(p) { if (!files.delete(p)) throw new Error('ENOENT'); },
    utime(p, a, m) { files.get(p).mtime = m; },
    syncfs: vi.fn((populate, cb) => cb(null))
  };
}

function makeFake() {
  const FS = makeFS();
  const sram = { data: new Uint8Array(16).fill(1) };
  const gm = {
    FS,
    functions: {
      getVideoDimensions: vi.fn((t) => ({ width: 160, height: 144, aspect: 160 / 144 })[t]),
      loadState: vi.fn(() => 1)
    },
    saveSaveFiles: vi.fn(() => { FS.dirs.add('/data'); FS.dirs.add('/data/saves'); FS.dirs.add(SAVE_DIR); FS.writeFile(SAVE_PATH, sram.data); }),
    getSaveFilePath: () => SAVE_PATH,
    loadSaveFiles: vi.fn(),
    restart: vi.fn(),
    toggleMainLoop: vi.fn(),
    supportsStates: () => true,
    getState: vi.fn(() => new Uint8Array([9, 9, 9])),
    clearEJSResetTimer: vi.fn()
  };
  const e = {
    functions: {},
    started: false,
    paused: true,
    failedToStart: false,
    volume: 0.5,
    muted: false,
    settings: {},
    isMobile: false,
    canvas: document.createElement('canvas'),
    textElem: null,
    on(ev, fn) { (this.functions[ev] ||= []).push(fn); },
    callEvent(ev, d) { const l = this.functions[ev] || []; l.forEach((f) => f(d)); return l.length; },
    startGameError(msg) { this.textElem.textContent = msg; this.textElem.className = 'ejs_error_text'; this.failedToStart = true; },
    pause: vi.fn(function () { this.paused = true; }),
    play: vi.fn(function () { this.paused = false; }),
    setVolume: vi.fn(),
    handleResize: vi.fn(),
    changeSettingOption: vi.fn(),
    toggleVirtualGamepad: vi.fn(),
    getCore: () => 'gambatte'
  };
  return { e, gm, FS, sram };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitForLoader() {
  await vi.waitFor(() => {
    if (!document.querySelector('script[data-emulingo="ejs-loader"]')) throw new Error('no loader yet');
  });
  return document.querySelector('script[data-emulingo="ejs-loader"]');
}

// What EmulatorJS's loader.js + constructor do, minus the emulation.
function construct(fake) {
  const { e } = fake;
  window.EJS_emulator = e;
  e.on('ready', window.EJS_ready);
  e.on('start', window.EJS_onGameStart);
  e.on('saveState', window.EJS_onSaveState);
  e.on('loadState', window.EJS_onLoadState);
  const game = document.querySelector('#game');
  game.setAttribute('tabindex', '-1');
  const t = document.createElement('div');
  t.className = 'ejs_loading_text';
  t.textContent = 'Loading...';
  game.appendChild(t);
  e.textElem = t;
  // GameManager's destructive exit handler
  fake.exitSpy = vi.fn();
  e.on('exit', fake.exitSpy);
  window.EJS_ready();
}

function mountFs(fake) {
  fake.e.gameManager = fake.gm;
  fake.e.callEvent('saveDatabaseLoaded', fake.FS);
}

function start(fake) {
  fake.e.started = true;
  fake.e.paused = false;
  fake.e.canvas.classList.add('ejs_canvas');
  document.querySelector('#game').appendChild(fake.e.canvas);
  fake.e.callEvent('start');
}

async function bootGame(fake = makeFake(), rom = ROM, opts = {}) {
  const p = emu.loadGame(rom, BYTES, opts);
  await waitForLoader();
  construct(fake);
  mountFs(fake);
  start(fake);
  await p;
  return fake;
}

beforeEach(() => {
  __testing.reset();
  kv.map.clear();
  kv.state.failSet = null;
  kv.state.records = {};
  storage.frozen = false;
  vi.clearAllMocks();
  document.body.innerHTML = '<div class="stage" data-stage><div id="game" role="application" aria-label="Game screen"></div></div>';
  for (const k of Object.keys(window)) if (k.startsWith('EJS_')) delete window[k];
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  __testing.reset();
});

describe('loadGame configuration', () => {
  it('configures EmulatorJS 4.2.3 for the ROM and loads it from the pinned CDN', async () => {
    const p = emu.loadGame(ROM, BYTES, { volume: 0.7 });
    const script = await waitForLoader();
    expect(script.src).toBe('https://cdn.emulatorjs.org/4.2.3/data/loader.js');
    expect(EJS_DATA).toBe('https://cdn.emulatorjs.org/4.2.3/data/');
    expect(script.parentElement).toBe(document.body);
    expect(window.EJS_player).toBe('#game');
    expect(window.EJS_core).toBe('gb');
    expect(window.EJS_pathtodata).toBe(EJS_DATA);
    expect(window.EJS_gameUrl).toBeInstanceOf(File);
    expect(window.EJS_gameUrl.name).toBe('Test Game-012345.gb');
    expect(window.EJS_gameUrl.size).toBe(BYTES.length);
    expect(window.EJS_gameName).toBe('Test Game-012345');
    expect(window.EJS_volume).toBe(0.7);
    expect('EJS_Volume' in window).toBe(false);
    expect(window.EJS_color).toBe('#15803d'); // white text on it stays AA
    expect(window.EJS_backgroundColor).toBe('#000000');
    expect(window.EJS_startOnLoaded).toBe(true);
    expect(window.EJS_Buttons).toEqual({ ...EJS_BUTTONS });
    for (const k of ['exitEmulation', 'cacheManager', 'netplay', 'saveState', 'loadState', 'quickSave', 'quickLoad']) {
      expect(window.EJS_Buttons[k]).toBe(false);
    }
    expect(typeof window.EJS_onGameStart).toBe('function');
    expect(typeof window.EJS_onSaveState).toBe('function');
    expect(typeof window.EJS_onLoadState).toBe('function');
    expect(window.__emulingoRomBytes).toBeUndefined();
    p.catch(() => {});
  });

  it('honours a Settings core override and detects the core of v1 zips', async () => {
    emu.loadGame(ROM, BYTES, { core: 'gba' }).catch(() => {});
    await waitForLoader();
    expect(window.EJS_core).toBe('gba');
  });

  it('asks for a system when nothing identifies it', async () => {
    await expect(emu.loadGame({ ...ROM, core: null, ext: '7z', fileName: 'x.7z' }, BYTES)).rejects.toMatchObject({ code: 'needs-system' });
  });

  it('scopes preserveDrawingBuffer to the EmulatorJS canvas', async () => {
    emu.loadGame(ROM, BYTES).catch(() => {});
    await waitForLoader();
    const ejsCanvas = document.createElement('canvas');
    ejsCanvas.classList.add('ejs_canvas');
    ejsCanvas.getContext('webgl2', { alpha: false });
    expect(getContextSpy).toHaveBeenLastCalledWith('webgl2', { alpha: false, preserveDrawingBuffer: true });
    document.createElement('canvas').getContext('webgl', { alpha: false });
    expect(getContextSpy).toHaveBeenLastCalledWith('webgl', { alpha: false });
    document.createElement('canvas').getContext('2d');
    expect(getContextSpy).toHaveBeenLastCalledWith('2d', undefined);
  });
});

describe('start and failure', () => {
  it('resolves on the game start event, not on ready', async () => {
    const fake = makeFake();
    const events = [];
    emu.onEvent((type) => events.push(type));
    let resolved = false;
    const p = emu.loadGame(ROM, BYTES).then(() => { resolved = true; });
    await waitForLoader();
    construct(fake);
    await flush();
    expect(resolved).toBe(false);
    expect(emu.isStarted()).toBe(false);
    expect(document.querySelector('#game').getAttribute('tabindex')).toBe('0');
    mountFs(fake);
    start(fake);
    await p;
    expect(resolved).toBe(true);
    expect(emu.isStarted()).toBe(true);
    expect(emu.isPlaying()).toBe(true);
    expect(events).toContain('start');
    // EMU-01: the exit handler that wipes /data/saves is gone
    expect(fake.e.functions.exit).toEqual([]);
    fake.e.callEvent('exit');
    expect(fake.exitSpy).not.toHaveBeenCalled();
    expect(emu.getCanvas()).toBe(fake.e.canvas);
    expect(emu.getGameElement().id).toBe('game');
    expect(emu.getVideoDims()).toEqual({ w: 160, h: 144, aspect: 160 / 144 });
  });

  it('rejects with the EmulatorJS error text when the core fails', async () => {
    const fake = makeFake();
    const errors = [];
    emu.onEvent((type, d) => { if (type === 'error') errors.push(d); });
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    fake.e.startGameError('Error downloading core (gambatte-wasm.data)');
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(EmulatorError);
    expect(err.code).toBe('start-failed');
    expect(err.message).toBe('Couldn’t download the emulator. Check your internet connection and try again.');
    expect(err.detail).toBe('Error downloading core (gambatte-wasm.data)');
    expect(errors[0]).toMatchObject({ phase: 'start', code: 'start-failed' });
  });

  it('notices failures that happen before it can hook in', async () => {
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    window.EJS_emulator = fake.e;
    fake.e.failedToStart = true;
    fake.e.textElem = Object.assign(document.createElement('div'), { textContent: 'Outdated graphics driver' });
    await expect(p).rejects.toMatchObject({ code: 'start-failed', message: 'This browser’s graphics support is too old for this system.' });
  });

  it('reports a loader that cannot be downloaded', async () => {
    const p = emu.loadGame(ROM, BYTES);
    const script = await waitForLoader();
    script.onerror(new Event('error'));
    await expect(p).rejects.toMatchObject({ code: 'loader-failed' });
  });

  it('reports progress and only times out when progress stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const progress = [];
    const p = emu.loadGame(ROM, BYTES, { onProgress: (x) => progress.push(x) });
    let settled = null;
    p.then(() => { settled = 'ok'; }, (e) => { settled = e; });
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => document.querySelector('script[data-emulingo="ejs-loader"]') || Promise.reject(new Error('x')));
    construct(fake);
    // a slow core download: progress every 60 s for 5 minutes
    for (let i = 1; i <= 5; i++) {
      fake.e.textElem.textContent = `Download Game Core ${i * 15}%`;
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(settled).toBeNull();
    expect(progress.some((x) => x.phase === 'download' && x.progress === 0.45)).toBe(true);
    await vi.advanceTimersByTimeAsync(91_000);
    expect(settled).toBeInstanceOf(EmulatorError);
    expect(settled.code).toBe('timeout');
  });

  it('runs one game per page', async () => {
    const p1 = emu.loadGame(ROM, BYTES);
    const p2 = emu.loadGame(ROM, BYTES);
    expect(p2).toBe(p1);
    await expect(emu.loadGame({ ...ROM, id: 'rom-other' }, BYTES)).rejects.toMatchObject({ code: 'reload-required' });
    p1.catch(() => {});
  });

  it('drops EmulatorJS’s exit handler as soon as the save folder mounts', async () => {
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    expect(fake.e.functions.exit).toHaveLength(1);
    mountFs(fake);
    // EmulatorJS calls 'exit' when startGame() throws: nothing may unmount the saves
    expect(fake.e.functions.exit).toEqual([]);
    fake.e.callEvent('exit');
    expect(fake.exitSpy).not.toHaveBeenCalled();
    p.catch(() => {});
  });

  it('keeps a game that starts after a timeout still and unreported', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const events = [];
    emu.onEvent((type) => events.push(type));
    const p = emu.loadGame(ROM, BYTES);
    let err = null;
    p.catch((e) => { err = e; });
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    await vi.advanceTimersByTimeAsync(91_000);
    expect(err).toMatchObject({ code: 'timeout' });
    mountFs(fake);
    start(fake);
    expect(fake.e.pause).toHaveBeenCalledWith(true);
    expect(fake.e.paused).toBe(true);
    expect(fake.e.functions.exit).toEqual([]);
    expect(emu.isStarted()).toBe(false);
    expect(events).not.toContain('start');
    expect(emu.pause('view')).toBe(false);
    await expect(emu.loadGame(ROM, BYTES)).rejects.toMatchObject({ code: 'reload-required' });
  });

  it('rejects instead of hanging when booting throws', async () => {
    const spy = vi.spyOn(document.body, 'appendChild').mockImplementationOnce(() => { throw new Error('blocked by policy'); });
    try {
      await expect(emu.loadGame(ROM, BYTES)).rejects.toMatchObject({ code: 'start-failed', detail: 'blocked by policy' });
    } finally {
      spy.mockRestore();
    }
  });

  it('remembers the core it found in a v1 zip', async () => {
    const zip = makeZip([{ name: 'readme.txt', data: new Uint8Array(4) }, { name: 'Game.gba', data: new Uint8Array(64).fill(3) }]);
    const v1zip = { ...ROM, core: null, ext: 'zip', fileName: 'Game.zip', name: 'Game.zip' };
    kv.map.set('roms:index', [{ id: ROM.id, name: 'Game.zip', fileName: 'Game.zip', gameName: 'Game', saveStem: 'Game', v1: true }]);
    const p = emu.loadGame(v1zip, zip);
    await waitForLoader();
    expect(window.EJS_core).toBe('gba');
    await vi.waitFor(() => { if (kv.map.get('roms:index')[0].core !== 'gba') throw new Error('not yet'); });
    p.catch(() => {});
  });

  it('refuses a second instance even after start', async () => {
    await bootGame();
    await expect(emu.loadGame(ROM, BYTES)).rejects.toMatchObject({ code: 'reload-required' });
    expect(emu.hasInstance()).toBe(true);
  });
});

describe('battery saves', () => {
  it('restores the mirror before boot when EmulatorJS lost its copy', async () => {
    kv.map.set('sram:' + ROM.id, { v: 1, files: { [SAVE_PATH]: { data: new Uint8Array([42, 43]), mtime: 1000 } } });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    mountFs(fake);
    expect(Array.from(fake.FS.readFile(SAVE_PATH))).toEqual([42, 43]);
    expect(fake.FS.files.get(SAVE_PATH).mtime).toBe(1000);
    start(fake);
    await p;
    expect(fake.gm.restart).not.toHaveBeenCalled();
  });

  it('keeps a newer EmulatorJS copy', async () => {
    kv.map.set('sram:' + ROM.id, { v: 1, files: { [SAVE_PATH]: { data: new Uint8Array([1]), mtime: 1000 } } });
    const fake = makeFake();
    fake.FS.dirs.add(SAVE_DIR);
    fake.FS.files.set(SAVE_PATH, { data: new Uint8Array([2]), mtime: 5000 });
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    mountFs(fake);
    expect(Array.from(fake.FS.readFile(SAVE_PATH))).toEqual([2]);
    start(fake);
    await p;
  });

  it('falls back to the core’s save path when the folder changed', async () => {
    kv.map.set('sram:' + ROM.id, { v: 1, files: { '/data/saves/OldCoreName/Test Game-012345.srm': { data: new Uint8Array([5]), mtime: 1 } } });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    mountFs(fake);
    // the mount-time restore wrote the old folder, which the core no longer reads
    expect(fake.FS.files.has('/data/saves/OldCoreName/Test Game-012345.srm')).toBe(true);
    expect(fake.FS.files.has(SAVE_PATH)).toBe(false);
    start(fake);
    await p;
    expect(Array.from(fake.FS.readFile(SAVE_PATH))).toEqual([5]);
    expect(fake.gm.loadSaveFiles).toHaveBeenCalled();
    expect(fake.gm.restart).toHaveBeenCalled();
  });

  it('re-homes a mirror saved under another file name, with its clock file', async () => {
    // e.g. a backup restored on a device where the ROM file has another name
    const old = '/data/saves/Gambatte/Old Name-aaaaaa';
    kv.map.set('sram:' + ROM.id, { v: 1, files: {
      [old + '.srm']: { data: new Uint8Array([7, 7]), mtime: 1000 },
      [old + '.rtc']: { data: new Uint8Array([1]), mtime: 1000 }
    } });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    mountFs(fake);
    // nothing written under the old name: it would only be a stray file
    expect([...fake.FS.files.keys()]).toEqual([]);
    start(fake);
    await p;
    expect(Array.from(fake.FS.readFile(SAVE_PATH))).toEqual([7, 7]);
    expect(Array.from(fake.FS.readFile(SAVE_DIR + '/Test Game-012345.rtc'))).toEqual([1]);
    expect(fake.FS.files.has(old + '.srm')).toBe(false);
    expect(fake.gm.loadSaveFiles).toHaveBeenCalled();
    expect(fake.gm.restart).toHaveBeenCalledTimes(1);
  });

  it('lets a save restored from a backup (Replace) beat a newer EmulatorJS copy, once', async () => {
    kv.map.set('sram:' + ROM.id, { v: 1, restored: true, files: { [SAVE_PATH]: { data: new Uint8Array([1]), mtime: 1000 } } });
    const fake = makeFake();
    fake.FS.dirs.add(SAVE_DIR);
    fake.FS.files.set(SAVE_PATH, { data: new Uint8Array([2]), mtime: 5000 });
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    mountFs(fake);
    expect(Array.from(fake.FS.readFile(SAVE_PATH))).toEqual([1]);
    start(fake);
    await p;
    expect(fake.gm.restart).not.toHaveBeenCalled();
    await flush();
    // the next start treats it like any other mirror again
    expect(kv.map.get('sram:' + ROM.id).restored).toBeUndefined();
  });

  it('re-homes a restored save made under another file name over the existing one', async () => {
    const old = '/data/saves/Gambatte/Old Name-aaaaaa.srm';
    kv.map.set('sram:' + ROM.id, { v: 1, restored: true, files: { [old]: { data: new Uint8Array([7]), mtime: 1000 } } });
    const fake = makeFake();
    fake.FS.dirs.add(SAVE_DIR);
    fake.FS.files.set(SAVE_PATH, { data: new Uint8Array([2]), mtime: 5000 });
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    expect(Array.from(fake.FS.readFile(SAVE_PATH))).toEqual([7]);
    expect(fake.gm.restart).toHaveBeenCalledTimes(1);
  });

  it('flushes every 10 s and mirrors only changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    const sramWrites = () => kv.api.idbSet.mock.calls.filter(([k]) => k === 'sram:' + ROM.id).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.gm.saveSaveFiles).toHaveBeenCalledTimes(1);
    expect(sramWrites()).toBe(1);
    expect(Array.from(kv.map.get('sram:' + ROM.id).files[SAVE_PATH].data)).toEqual(Array.from(fake.sram.data));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sramWrites()).toBe(1);
    fake.sram.data = new Uint8Array(16).fill(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sramWrites()).toBe(2);
  });

  it('flushes when the tab is hidden and before eject', async () => {
    const fake = await bootGame();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    expect(fake.gm.saveSaveFiles).toHaveBeenCalledTimes(1);
    expect(await emu.flushSaves()).toBe(true);
    expect(fake.FS.syncfs).toHaveBeenCalledWith(false, expect.any(Function));
  });
});

describe('one game per browser', () => {
  const withLocks = (request) => Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  afterEach(() => { delete navigator.locks; });

  it('refuses to start while another tab or window runs a game', async () => {
    const request = vi.fn(() => Promise.reject(new DOMException('Timed out', 'TimeoutError')));
    withLocks(request);
    await expect(emu.loadGame(ROM, BYTES)).rejects.toMatchObject({ code: 'busy', message: expect.stringMatching(/another Emulingo tab/u) });
    expect(request).toHaveBeenCalledWith('emulingo:game', expect.any(Object), expect.any(Function));
    expect(document.querySelector('script[data-emulingo="ejs-loader"]')).toBeNull();
  });

  it('holds the lock for as long as the page runs the game', async () => {
    let released = false;
    const request = vi.fn((name, opts, cb) => {
      const held = Promise.resolve(cb({ name }));
      held.then(() => { released = true; });
      return held;
    });
    withLocks(request);
    await bootGame();
    await flush();
    expect(emu.isStarted()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(released).toBe(false);
  });
});

describe('after Erase everything', () => {
  it('lets go of EmulatorJS’s save database when another tab deletes it, and stops saving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const savesDb = new EventTarget();
    savesDb.close = vi.fn();
    fake.FS.filesystems = { IDBFS: { dbs: { '/data/saves': savesDb } } };
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    savesDb.dispatchEvent(new Event('versionchange'));
    expect(savesDb.close).toHaveBeenCalled();
    fake.gm.saveSaveFiles.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event('pagehide'));
    expect(fake.gm.saveSaveFiles).not.toHaveBeenCalled();
  });

  it('stops every save (ours and EmulatorJS’s own timer) so deleted data stays deleted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    await vi.advanceTimersByTimeAsync(31_000); // past the autosave grace
    fake.gm.saveSaveFiles.mockClear();
    kv.api.idbSet.mockClear();
    fake.e.saveSaveInterval = setInterval(() => fake.gm.saveSaveFiles(), 300_000);
    storage.frozen = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.e.saveSaveInterval).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    emu.pause('user');
    expect(await emu.flushSaves()).toBe(false);
    expect(await emu.autoSave()).toBe(false);
    await expect(emu.quickSave()).rejects.toMatchObject({ code: 'erased' });
    emu.resume('user');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.gm.saveSaveFiles).not.toHaveBeenCalled();
    expect(kv.api.idbSet).not.toHaveBeenCalled();
  });
});

describe('pause and resume', () => {
  it('stacks pause reasons so leaving the view never undoes a user pause', async () => {
    const fake = await bootGame();
    const events = [];
    emu.onEvent((type, d) => events.push([type, d.reason]));
    expect(emu.pause('user')).toBe(true);
    expect(fake.e.pause).toHaveBeenCalledWith(true);
    expect(emu.isPaused()).toBe(true);
    expect(emu.isUserPaused()).toBe(true);
    emu.pause('view');
    expect(emu.resume('view')).toBe(false);
    expect(emu.isPaused()).toBe(true);
    expect(emu.resume('user')).toBe(true);
    expect(fake.e.play).toHaveBeenCalledWith(true);
    expect(emu.isPaused()).toBe(false);
    expect(events).toEqual([['paused', 'user'], ['resumed', 'user']]);
  });

  it('applies a pause made while the game was loading', async () => {
    const fake = makeFake();
    const events = [];
    emu.onEvent((type, d) => events.push([type, d.paused]));
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    expect(emu.pause('view')).toBe(true);
    expect(emu.isPaused()).toBe(false);
    mountFs(fake);
    start(fake);
    await p;
    expect(fake.e.pause).toHaveBeenCalledWith(true);
    expect(emu.isPaused()).toBe(true);
    expect(emu.isPlaying()).toBe(false);
    expect(events).toContainEqual(['start', true]);
    expect(emu.resume('view')).toBe(true);
    expect(emu.isPlaying()).toBe(true);
  });

  it('a resume while loading cancels the pending pause', async () => {
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    emu.pause('view');
    expect(emu.resume('view')).toBe(true);
    mountFs(fake);
    start(fake);
    await p;
    expect(fake.e.pause).not.toHaveBeenCalled();
    expect(emu.isPlaying()).toBe(true);
  });

  it('falls back to toggleMainLoop', async () => {
    const fake = makeFake();
    delete fake.e.pause;
    delete fake.e.play;
    await bootGame(fake);
    emu.pause();
    expect(fake.gm.toggleMainLoop).toHaveBeenCalledWith(0);
    emu.resume();
    expect(fake.gm.toggleMainLoop).toHaveBeenCalledWith(1);
  });
});

describe('save states', () => {
  it('quick save and quick load use the manual slot', async () => {
    const fake = await bootGame();
    expect(await emu.quickLoad()).toBe(false);
    const saved = [];
    emu.onEvent((type, d) => { if (type === 'saved') saved.push(d.slot); });
    const res = await emu.quickSave();
    expect(res.savedAt).toBeGreaterThan(0);
    expect(Array.from(kv.map.get(`state:${ROM.id}:manual`))).toEqual([9, 9, 9]);
    expect(saved).toEqual(['manual']);
    expect(await emu.quickLoad()).toBe(true);
    expect(fake.gm.functions.loadState).toHaveBeenCalledWith('game.state', 0);
    expect(Array.from(fake.FS.readFile('/game.state'))).toEqual([9, 9, 9]);
  });

  it('refuses a state made by another core instead of pretending it loaded', async () => {
    kv.map.set('roms:index', [{ ...ROM, saves: { manual: { t: 1, core: 'mgba', ejs: '4.2.3' }, auto: { t: 1, core: 'gambatte', ejs: '4.2.3' } } }]);
    kv.map.set(`state:${ROM.id}:manual`, new Uint8Array([1]));
    kv.map.set(`state:${ROM.id}:auto`, new Uint8Array([2]));
    const fake = await bootGame();
    await expect(emu.quickLoad()).rejects.toMatchObject({ code: 'incompatible-state', detail: 'mgba → gambatte' });
    expect(fake.gm.functions.loadState).not.toHaveBeenCalled();
    // same core, or no record (v1 states): loads
    expect(await emu.resumeAutoSave()).toBe(true);
    kv.map.set('roms:index', [{ ...ROM, saves: {} }]);
    expect(await emu.quickLoad()).toBe(true);
  });

  it('routes EmulatorJS’s own save state button to the manual slot', async () => {
    const fake = await bootGame();
    expect(fake.e.callEvent('saveState', { state: new Uint8Array([4, 4]) })).toBe(1);
    await flush();
    expect(Array.from(kv.map.get(`state:${ROM.id}:manual`))).toEqual([4, 4]);
  });

  it('reports states as unsupported for cores without them', async () => {
    const fake = makeFake();
    fake.gm.supportsStates = () => false;
    await bootGame(fake);
    await expect(emu.quickSave()).rejects.toMatchObject({ code: 'no-states' });
  });

  it('surfaces a full disk', async () => {
    await bootGame();
    kv.state.failSet = (k) => k.startsWith('state:');
    const errors = [];
    emu.onEvent((type, d) => { if (type === 'error') errors.push(d); });
    await expect(emu.quickSave()).rejects.toMatchObject({ code: 'storage-full' });
    expect(errors[0]).toMatchObject({ phase: 'save', code: 'storage-full' });
  });

  it('needs a running game', async () => {
    await expect(emu.quickSave()).rejects.toMatchObject({ code: 'not-started' });
    expect(() => emu.restart()).toThrow(EmulatorError);
  });

  it('autosaves only after 30 s of play and never while resume is undecided', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    kv.map.set(`state:${ROM.id}:auto`, new Uint8Array([1, 1]));
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    expect(await emu.hasAutoSave(ROM.id)).toBe(true);
    expect(await emu.autoSave()).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // the old session is still there: the question is open
    expect(Array.from(kv.map.get(`state:${ROM.id}:auto`))).toEqual([1, 1]);
    emu.dismissResume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Array.from(kv.map.get(`state:${ROM.id}:auto`))).toEqual([9, 9, 9]);
  });

  it('does not count paused time towards the 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    await vi.advanceTimersByTimeAsync(20_000);
    emu.pause('view');
    await vi.advanceTimersByTimeAsync(120_000);
    emu.resume('view');
    expect(await emu.autoSave()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await emu.autoSave()).toBe(true);
  });

  it('resumeAutoSave loads the autosave slot', async () => {
    kv.map.set(`state:${ROM.id}:auto`, new Uint8Array([3, 2, 1]));
    const fake = await bootGame();
    expect(await emu.hasAutoSave(ROM.id)).toBe(true);
    expect(await emu.hasAutoSave('rom-none')).toBe(false);
    expect(await emu.resumeAutoSave()).toBe(true);
    expect(Array.from(fake.FS.readFile('/game.state'))).toEqual([3, 2, 1]);
    expect(__testing.session().resume).toBe('done');
  });

  it('restart uses the game manager', async () => {
    const fake = await bootGame();
    expect(emu.restart()).toBe(true);
    expect(fake.gm.restart).toHaveBeenCalled();
  });

  it('keeps the state file until the core reads it, even while paused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    kv.map.set(`state:${ROM.id}:manual`, new Uint8Array([5, 6]));
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    emu.pause('user');
    expect(await emu.quickLoad()).toBe(true);
    // RetroArch loads on its next frame, which only comes after resume
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Array.from(fake.FS.readFile('/game.state'))).toEqual([5, 6]);
  });

  it('gives a restarted game the 30 s autosave grace again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    await vi.advanceTimersByTimeAsync(45_000);
    emu.restart();
    expect(await emu.autoSave()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await emu.autoSave()).toBe(true);
  });
});

describe('eject', () => {
  it('saves, remembers the next game and reloads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    await vi.advanceTimersByTimeAsync(31_000);
    const reload = vi.fn();
    __testing.setReload(reload);
    emu.ejectAndReload('rom-next');
    await vi.advanceTimersByTimeAsync(100);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(kv.map.has(`state:${ROM.id}:auto`)).toBe(true);
    expect(fake.gm.saveSaveFiles).toHaveBeenCalled();
    expect(emu.consumeAutostart()).toBe('rom-next');
    expect(emu.consumeAutostart()).toBeNull();
  });

  it('saves and reloads once when eject is pressed twice', async () => {
    const fake = await bootGame();
    const reload = vi.fn();
    __testing.setReload(reload);
    const a = emu.ejectAndReload('rom-a');
    const b = emu.ejectAndReload('rom-b');
    expect(b).toBe(a);
    await vi.waitFor(() => { if (!reload.mock.calls.length) throw new Error('not yet'); });
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fake.gm.saveSaveFiles).toHaveBeenCalledTimes(1);
    expect(emu.consumeAutostart()).toBe('rom-b');
  });

  it('reloads even when storage hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await vi.advanceTimersByTimeAsync(10);
    construct(fake);
    mountFs(fake);
    start(fake);
    await p;
    await vi.advanceTimersByTimeAsync(31_000);
    kv.api.idbSet.mockImplementation(() => new Promise(() => {}));
    fake.FS.syncfs.mockImplementation(() => {});
    const reload = vi.fn();
    __testing.setReload(reload);
    emu.ejectAndReload(null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(emu.consumeAutostart()).toBeNull();
  });
});

describe('audio, touch and layout', () => {
  it('applies volume and mute chosen before start', async () => {
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    emu.setVolume(0.3);
    emu.mute(true);
    expect(fake.e.setVolume).not.toHaveBeenCalled();
    mountFs(fake);
    start(fake);
    await p;
    expect(fake.e.setVolume).toHaveBeenNthCalledWith(1, 0.3);
    expect(fake.e.setVolume).toHaveBeenNthCalledWith(2, 0);
    expect(emu.isMuted()).toBe(true);
    emu.mute(false);
    expect(fake.e.setVolume).toHaveBeenLastCalledWith(0.3);
    expect(emu.isMuted()).toBe(false);
  });

  it('turns on touch controls on touch-first devices without a saved choice', async () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    window.matchMedia = vi.fn(() => ({ matches: true }));
    try {
      const fake = await bootGame();
      expect(fake.e.changeSettingOption).toHaveBeenCalledWith('virtual-gamepad', 'enabled', true);
      __testing.reset();
      document.body.innerHTML = '<div id="game"></div>';
      for (const k of Object.keys(window)) if (k.startsWith('EJS_')) delete window[k];
      const fake2 = makeFake();
      fake2.e.settings = { 'virtual-gamepad': 'disabled' };
      await bootGame(fake2);
      expect(fake2.e.changeSettingOption).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
      delete window.matchMedia;
    }
  });

  it('passes resize through and exposes the key map', async () => {
    expect(emu.getKeyMap()).toEqual(emu.DEFAULT_KEYS);
    const fake = await bootGame();
    emu.handleResize();
    expect(fake.e.handleResize).toHaveBeenCalled();
    // a Game Boy has no shoulder buttons
    expect(emu.getKeyMap()).toEqual(emu.DEFAULT_KEYS.filter((k) => k.button !== 'L' && k.button !== 'R'));
    const arrows = { 4: { value: 'up arrow' }, 5: { value: 'down arrow' }, 6: { value: 'left arrow' }, 7: { value: 'right arrow' } };
    fake.e.controls = { 0: { 8: { value: 'k' }, 0: { value: 'j' }, 3: { value: 'enter' }, 2: { value: 'shift' }, 10: { value: 'q' }, ...arrows } };
    expect(emu.getKeyMap()).toEqual([
      { button: 'A', key: 'K' }, { button: 'B', key: 'J' }, { button: 'Start', key: 'Enter' },
      { button: 'Select', key: 'Shift' }, { button: 'D-pad', key: 'Arrow keys' }
    ]);
    fake.e.controls[0] = { ...fake.e.controls[0], 4: { value: 'w' }, 5: { value: 's' }, 6: { value: 'a' }, 7: { value: 'd' } };
    expect(emu.getKeyMap().find((k) => k.button === 'D-pad').key).toBe('W A S D');
  });

  it('lists shoulder buttons for systems that have them', async () => {
    const fake = makeFake();
    await bootGame(fake, { ...ROM, core: 'gba', ext: 'gba' });
    fake.e.controls = { 0: { 8: { value: 'z' }, 0: { value: 'x' }, 10: { value: 'q' }, 11: { value: 'e' } } };
    expect(emu.getKeyMap().map((k) => k.button)).toEqual(['A', 'B', 'L', 'R']);
  });

  it('names the game element for assistive tech if the view did not', async () => {
    document.body.innerHTML = '<div id="game"></div>';
    await bootGame();
    const el = document.querySelector('#game');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('role')).toBe('application');
    expect(el.getAttribute('aria-label')).toBe('Game screen');
  });

  it('reports pending volume and mute before start', async () => {
    const fake = makeFake();
    const p = emu.loadGame(ROM, BYTES);
    await waitForLoader();
    construct(fake);
    emu.setVolume(0.2);
    emu.mute(true);
    expect(emu.getVolume()).toBe(0.2);
    expect(emu.isMuted()).toBe(true);
    mountFs(fake);
    start(fake);
    await p;
    expect(emu.getVolume()).toBe(0.2);
    expect(emu.isMuted()).toBe(true);
  });

  it('parses EmulatorJS progress text', () => {
    expect(emu.parseProgress('Download Game Core 45%')).toMatchObject({ phase: 'download', progress: 0.45 });
    expect(emu.parseProgress('Download Game Core 2.50MB')).toMatchObject({ phase: 'download', progress: null, loadedBytes: 2621440 });
    expect(emu.parseProgress('Decompress Game Core 10%')).toMatchObject({ phase: 'unpack', progress: 0.1 });
    expect(emu.parseProgress('Download Game Data')).toMatchObject({ phase: 'prepare' });
    expect(emu.parseProgress('Loading...')).toMatchObject({ phase: 'loading' });
  });
});
