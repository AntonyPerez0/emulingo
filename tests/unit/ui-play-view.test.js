// @vitest-environment jsdom
// The Play view wired together (src/ui/views/play/index.js), with the
// emulator, the ROM store and the OCR session replaced by fakes.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
afterAll(() => wait(150));

const RECORD = { id: 'rom-abc', name: 'Pokemon Red.gb', title: 'Pokémon Red', core: 'gb', added: 1, saves: {} };
const N64_RECORD = { id: 'rom-n64', name: 'Mario 64.z64', title: 'Mario 64', core: 'n64', added: 1, saves: {} };

// ---- fakes ---------------------------------------------------------------------------

const emu = vi.hoisted(() => ({
  listeners: new Set(),
  calls: [],
  autostart: null,
  autoSave: false,
  startGate: null,
  fullscreen: true,
  record: null
}));

vi.mock('../../src/core/emulator.js', () => {
  const keys = Object.freeze([
    { button: 'A', key: 'Z' }, { button: 'B', key: 'X' }, { button: 'Start', key: 'Enter' },
    { button: 'Select', key: 'V' }, { button: 'D-pad', key: 'Arrow keys' }
  ]);
  const log = (name) => (...args) => { emu.calls.push([name, ...args]); return true; };
  return {
    DEFAULT_KEYS: keys,
    onEvent: (fn) => { emu.listeners.add(fn); return () => emu.listeners.delete(fn); },
    hasInstance: () => false,
    consumeAutostart: () => { const id = emu.autostart; emu.autostart = null; return id; },
    loadGame: (...args) => { emu.calls.push(['loadGame', args[0].id]); return emu.startGate || Promise.resolve(); },
    pause: log('pause'),
    resume: log('resume'),
    isUserPaused: () => false,
    isMuted: () => false,
    isFullscreen: () => false,
    getVideoDims: () => ({ w: 160, h: 144 }),
    getGameElement: () => document.getElementById('game'),
    getKeyMap: () => keys,
    focusGame: () => { const g = document.getElementById('game'); if (g) g.focus(); },
    handleResize: () => {},
    hasAutoSave: async () => emu.autoSave,
    resumeAutoSave: async () => true,
    dismissResume: log('dismissResume'),
    quickSave: async () => ({ savedAt: Date.now() }),
    quickLoad: async () => true,
    restart: log('restart'),
    mute: (on) => on,
    toggleFullscreen: async (target) => { emu.calls.push(['toggleFullscreen', target]); return false; },
    canFullscreen: () => emu.fullscreen,
    ejectAndReload: (id) => { emu.calls.push(['ejectAndReload', id]); return new Promise(() => {}); }
  };
});

vi.mock('../../src/core/rom.js', () => {
  const SYSTEMS = [
    { core: 'gb', name: 'Game Boy and Game Boy Color', short: 'Game Boy', exts: ['gb', 'gbc'], aspect: 10 / 9 },
    { core: 'n64', name: 'Nintendo 64', short: 'N64', exts: ['z64'], aspect: 4 / 3 }
  ];
  const rec = () => emu.record || RECORD;
  return {
    SYSTEMS,
    systemFor: (core) => SYSTEMS.find((s) => s.core === core) || null,
    resolveCore: (r) => (r && r.core) || 'gb',
    listRoms: async () => [rec()],
    getRom: async (id) => (id === rec().id ? { ...rec() } : null),
    getRomBytes: async () => new Uint8Array([1, 2, 3]),
    updateRom: async () => true,
    sweepOrphans: async () => 0,
    acceptAttr: () => '.gb,.gbc,.gba',
    importRomFile: async () => { throw new Error('not in this test'); },
    deleteRom: async () => true
  };
});

vi.mock('../../src/ui/views/play/session.js', () => ({
  createOcrSession: (opts) => {
    if (emu.sessionFails) throw new Error('no WebAssembly');
    emu.session = opts;
    return {
    scanner: { getState: () => ({ stats: {}, status: { state: 'watching' } }) },
    start() {}, pause() {}, resume() {}, setZone() {}, dismissHint() {}, dispose() {},
    scanNow: async () => null,
    retry: async () => false
    };
  }
}));

// ---- harness ---------------------------------------------------------------------------

let store;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = await import('../../src/core/db.js');
  await db.initDb();
  ({ store } = await import('../../src/core/store.js'));
});

// A fresh copy of the view (it keeps module state), with fresh data modules
// that the test then talks to.
async function mountView({ show = true } = {}) {
  vi.resetModules();
  await (await import('../../src/core/db.js')).initDb();
  ({ store } = await import('../../src/core/store.js'));
  document.body.innerHTML = `<div id="sr-status"></div><div id="sr-alert"></div>
    <main id="main"><section data-view="play"></section></main>`;
  document.body.dataset.view = 'play';
  const section = document.querySelector('section[data-view="play"]');
  const view = (await import('../../src/ui/views/play/index.js')).default;
  view.mount(section);
  if (show) view.show({});
  await wait(30);
  return { view, section };
}

const emit = (type, detail) => { for (const fn of emu.listeners) fn(type, detail); };
const srText = () => `${document.getElementById('sr-status').textContent} ${document.getElementById('sr-alert').textContent}`;

function fileDrag(type, target) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: [], dropEffect: 'copy' } });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  emu.listeners.clear();
  emu.calls.length = 0;
  emu.autostart = null;
  emu.autoSave = false;
  emu.startGate = null;
  emu.fullscreen = true;
  emu.record = null;
  emu.sessionFails = false;
  delete window.matchMedia;
  delete document.documentElement.dataset.handheld;
  store.set('source', 'de');
  store.set('target', 'en');
  store.set('onboarded', true);
  store.set('shortcuts', true);
});

describe('Play view', () => {
  it('saves the languages picked on the setup card when a game starts, without sending focus back to the library', async () => {
    store.set('onboarded', false);
    const { section } = await mountView();
    expect(section.querySelector('.onboarding')).not.toBe(null);
    section.querySelector('.onboarding [data-quick="fr"]').click();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(150);
    expect(store.get('source')).toBe('fr');
    expect(store.get('onboarded')).toBe(true);
    expect(section.querySelector('.onboarding')).toBe(null);
    // the starting game owns focus and the announcement
    expect(document.activeElement.tagName).toBe('H1');
    expect(srText()).not.toContain('Now load a game');
    expect(srText()).toContain('Starting Pokémon Red');
  });

  it('keeps focus on the page when the setup card is saved during a game', async () => {
    store.set('onboarded', false);
    store.set('source', null);
    const { section } = await mountView();
    // no game language yet: the game starts and the card stays
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(50);
    expect(section.querySelector('.stage').dataset.state).toBe('running');
    expect(section.querySelector('.onboarding')).not.toBe(null);
    section.querySelector('.onboarding [data-quick="de"]').click();
    const submit = section.querySelector('.onboarding button[type="submit"]');
    submit.focus();
    submit.click();
    expect(section.querySelector('.onboarding')).toBe(null);
    expect(document.activeElement.dataset.action).toBe('translate-now');
  });

  it('keeps the toolbar and its More items inert until the game runs (Eject excepted)', async () => {
    let release;
    emu.startGate = new Promise((r) => { release = r; });
    const { section } = await mountView();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(30);
    const restart = section.querySelector('[role="menuitem"][data-action="restart"]');
    const eject = section.querySelector('[role="menuitem"][data-action="eject"]');
    expect(section.querySelector('.tb[data-action="translate-now"]').getAttribute('aria-disabled')).toBe('true');
    expect(restart.getAttribute('aria-disabled')).toBe('true');
    expect(eject.hasAttribute('aria-disabled')).toBe(false);
    restart.click();
    await wait(10);
    expect(document.querySelector('dialog[open]')).toBe(null);
    release();
    await wait(30);
    expect(restart.hasAttribute('aria-disabled')).toBe(false);
    expect(section.querySelector('.tb[data-action="translate-now"]').hasAttribute('aria-disabled')).toBe(false);
  });

  it('offers Fullscreen only where the browser can do it (not on iPhone Safari)', async () => {
    let { section } = await mountView();
    expect(section.querySelector('.tb[data-action="fullscreen"]')).not.toBe(null);
    expect(section.querySelector('#play-more-fullscreen')).not.toBe(null);
    emu.fullscreen = false;
    ({ section } = await mountView());
    expect(section.querySelector('[data-action="fullscreen"]')).toBe(null);
    // the rest of the toolbar is untouched
    expect(section.querySelector('.tb[data-action="mute"]')).not.toBe(null);
  });

  it('switches the game language before the target, so the misread line is not re-translated first', async () => {
    store.set('source', 'de');
    store.set('target', 'en');
    const { section } = await mountView();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(50);
    const changes = [];
    const off = store.subscribe((key, value) => changes.push([key, value]));
    emu.session.onStatus({ state: 'watching', message: '', hint: { type: 'language-mismatch', detected: 'en', expected: 'de' } });
    section.querySelector('[data-action="hint-switch"]').click();
    off();
    expect(changes[0]).toEqual(['source', 'en']);
    expect(changes[1][0]).toBe('target');
    expect(store.get('target')).not.toBe('en');
  });

  it('labels the game screen once it runs', async () => {
    const { section } = await mountView();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(50);
    const g = document.getElementById('game');
    expect(g.getAttribute('role')).toBe('application');
    expect(g.getAttribute('aria-label')).toBe('Game screen: Pokémon Red');
    expect(g.getAttribute('aria-describedby')).toBe('play-key-hint');
    expect(section.querySelector('#play-key-hint').textContent).toContain('Z = A');
  });

  it('pauses a game that autostarts while another view is showing', async () => {
    emu.autostart = RECORD.id;
    await mountView({ show: false });
    await wait(30);
    expect(emu.calls.some((c) => c[0] === 'loadGame')).toBe(true);
    expect(emu.calls).toContainEqual(['pause', 'view']);
  });

  it('drops the resume question once a quick load or restart has answered it', async () => {
    emu.autoSave = true;
    const { section } = await mountView();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(50);
    const resume = section.querySelector('[data-resume]');
    expect(resume.hidden).toBe(false);
    resume.querySelector('[data-action="resume-yes"]').focus();
    emit('loaded', { slot: 'manual' });
    expect(resume.hidden).toBe(true);
    expect(document.activeElement.dataset.action).toBe('translate-now');
  });

  it('stops a file dropped outside the drop zone from leaving the page', async () => {
    const { section } = await mountView();
    const outside = fileDrag('dragover', section.querySelector('.library__head'));
    expect(outside.defaultPrevented).toBe(true);
    expect(outside.dataTransfer.dropEffect).toBe('none');
    // the drop zone itself still accepts files
    const inside = fileDrag('dragover', section.querySelector('[data-dropzone] .dropzone__text'));
    expect(inside.defaultPrevented).toBe(true);
    expect(inside.dataTransfer.dropEffect).toBe('copy');
  });

  it('skips to the live translation without changing the URL', async () => {
    const { section } = await mountView();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(50);
    const before = location.hash;
    section.querySelector('.play-skip').click();
    expect(document.activeElement.id).toBe('play-live-title');
    expect(location.hash).toBe(before);
  });

  it('hides key hints when single-key shortcuts are off', async () => {
    const { section } = await mountView();
    const tn = section.querySelector('.tb[data-action="translate-now"]');
    expect(tn.getAttribute('aria-keyshortcuts')).toBe('t');
    store.set('shortcuts', false);
    expect(section.querySelector('.play').classList.contains('play--no-shortcuts')).toBe(true);
    expect(tn.hasAttribute('aria-keyshortcuts')).toBe(false);
    store.set('shortcuts', true);
    expect(tn.getAttribute('aria-keyshortcuts')).toBe('t');
  });
});

// ---- phones ---------------------------------------------------------------------------

// A phone held sideways: only the landscape query matches. rotate() fires
// the queries' change events, as a rotation does.
const mqListeners = new Set();
function sideways() {
  mqListeners.clear();
  window.matchMedia = (q) => ({
    media: q,
    matches: /orientation: landscape/.test(q),
    addEventListener(type, fn) { mqListeners.add(fn); },
    removeEventListener(type, fn) { mqListeners.delete(fn); }
  });
}
const rotate = () => { for (const fn of mqListeners) fn({ type: 'change' }); };

// EmulatorJS's on-screen pad (what syncTouchDock looks for), shown
function addPad() {
  const pad = document.createElement('div');
  pad.className = 'ejs_virtualGamepad_parent';
  pad.innerHTML = '<div class="ejs_virtualGamepad_top"></div><div class="ejs_virtualGamepad_bottom"></div><div class="ejs_virtualGamepad_left"><div class="ejs_dpad_main"></div></div><div class="ejs_virtualGamepad_right"><div class="b_b"></div><div class="b_a"></div></div>';
  document.getElementById('game').appendChild(pad);
  return pad;
}

// Boxes for the pad (jsdom lays nothing out): `shown` false is a hidden view.
function layOutPad(pad, shown) {
  const box = (left, width) => () => (shown
    ? { left, right: left + width, width, top: 0, bottom: 50, height: 50, x: left, y: 0 }
    : { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0 });
  pad.getBoundingClientRect = box(0, 900);
  pad.querySelector('.ejs_virtualGamepad_left').getBoundingClientRect = box(50, 125);
  pad.querySelector('.ejs_dpad_main').getBoundingClientRect = box(50, 125);
  pad.querySelector('.ejs_virtualGamepad_right').getBoundingClientRect = box(700, 130);
  pad.querySelector('.b_b').getBoundingClientRect = box(710, 50);
  pad.querySelector('.b_a').getBoundingClientRect = box(781, 50);
}

const frames = () => wait(60);
const handheld = () => document.documentElement.dataset.handheld;

describe('Play view on phones', () => {
  it('puts the caption in the stage, after the text-area overlay', async () => {
    const { section } = await mountView();
    const caption = section.querySelector('.stage > [data-caption]');
    expect(caption).not.toBe(null);
    expect(caption.previousElementSibling.matches('[data-zone-overlay]')).toBe(true);
    expect(caption.querySelector('.caption__open').getAttribute('aria-label')).toBe('Open Live translation');
    // outside the game's role=application
    expect(caption.closest('#game')).toBe(null);
  });

  it('switches to the sideways layout once the pad shows, and back for the text-area editor and when hidden', async () => {
    sideways();
    const { view, section } = await mountView();
    addPad();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(700); // (syncTouchDock runs a frame and 600 ms after the start)
    const gameSection = section.querySelector('section.game');
    const toolbar = section.querySelector('[data-toolbar]');
    expect(handheld()).toBe('landscape');
    expect(gameSection.classList.contains('theme-dark')).toBe(true);
    expect(toolbar.classList.contains('play-toolbar--corners')).toBe(true);

    section.querySelector('[role="menuitem"][data-action="zone"]').click();
    await frames();
    expect(section.querySelector('[data-zone-panel]').hidden).toBe(false);
    expect(handheld()).toBe(undefined);
    expect(gameSection.classList.contains('theme-dark')).toBe(false);
    expect(toolbar.classList.contains('play-toolbar--corners')).toBe(false);

    section.querySelector('[data-zone-panel] [data-action="zone-cancel"]').click();
    await frames();
    expect(handheld()).toBe('landscape');
    expect(gameSection.classList.contains('theme-dark')).toBe(true);
    expect(toolbar.classList.contains('play-toolbar--corners')).toBe(true);

    view.hide();
    expect(handheld()).toBe(undefined);
    expect(gameSection.classList.contains('theme-dark')).toBe(false);
    expect(toolbar.classList.contains('play-toolbar--corners')).toBe(false);
  });

  it('keeps the regular layout for N64 (stick and C buttons)', async () => {
    sideways();
    emu.record = N64_RECORD;
    const { section } = await mountView();
    addPad();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(700);
    expect(section.querySelector('.stage').classList.contains('stage--dock')).toBe(true);
    expect(handheld()).toBe(undefined);
  });

  it('works without matchMedia (no phone layout)', async () => {
    const { section } = await mountView();
    addPad();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(700);
    expect(section.querySelector('.stage').dataset.state).toBe('running');
    expect(handheld()).toBe(undefined);
  });

  it('keeps the pad’s measurements while the view is hidden, and measures again when shown', async () => {
    sideways();
    const { view, section } = await mountView();
    const pad = addPad();
    layOutPad(pad, true);
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(700);
    const play = section.querySelector('.play');
    expect(play.style.getPropertyValue('--pad-r-w')).toBe('121px');
    expect(play.style.getPropertyValue('--pad-r-shift')).toBe('6px');
    view.hide();
    layOutPad(pad, false);
    rotate();
    await wait(350);
    expect(play.style.getPropertyValue('--pad-r-w')).toBe('121px');
    layOutPad(pad, true);
    pad.querySelector('.b_b').getBoundingClientRect = () => ({ left: 640, right: 690, width: 50, top: 0, bottom: 50, height: 50, x: 640, y: 0 });
    view.show({});
    await frames();
    expect(play.style.getPropertyValue('--pad-r-w')).toBe('191px');
  });

  it('takes the game section into fullscreen on a phone, so the toolbar comes along', async () => {
    sideways();
    const { section } = await mountView();
    addPad();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(700);
    expect(handheld()).toBe('landscape');
    section.querySelector('[role="menuitem"][data-action="fullscreen"]').click();
    await frames();
    const call = emu.calls.find((c) => c[0] === 'toggleFullscreen');
    expect(call[1]).toBe(section.querySelector('section.game'));
  });

  it('marks the page while the player reads the translation (no snapping back to the game)', async () => {
    const { section } = await mountView();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(50);
    const root = document.documentElement;
    section.querySelector('.play-skip').click();
    expect(document.activeElement.id).toBe('play-live-title');
    expect(root.classList.contains('play-reading')).toBe(true);
    section.querySelector('.tb[data-action="translate-now"]').focus();
    expect(root.classList.contains('play-reading')).toBe(false);
  });

  it('tells the caption too when live translation can’t start in this browser', async () => {
    emu.sessionFails = true;
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    const { section } = await mountView();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(50);
    expect(section.querySelector('.stage').dataset.state).toBe('running');
    expect(section.querySelector('[data-caption-text]').textContent).toBe('Live translation isn’t available in this browser.');
  });

  it('feeds the caption the newest line and the scanner status', async () => {
    const { section } = await mountView();
    section.querySelector('.rom-card [data-action="play"]').click();
    await wait(50);
    const text = () => section.querySelector('[data-caption-text]').textContent;
    emu.session.onStatus({ state: 'setup', progress: 0.5 });
    expect(text()).toBe('Getting text recognition ready…');
    emu.session.onCapture({ id: 'c1', time: 1, src: 'de', tgt: 'en', dialog: { text: 'Hallo', translation: '', status: 'pending' }, others: [] });
    expect(text()).toBe('Translating…');
    emu.session.onUpdate({ id: 'c1', time: 1, src: 'de', tgt: 'en', dialog: { text: 'Hallo', translation: 'Hello', status: 'done' }, others: [] });
    expect(text()).toBe('Hello');
    expect(section.querySelector('[data-caption-text]').getAttribute('lang')).toBe('en');
    store.set('target', 'fr');
    expect(section.querySelector('[data-caption-tag]').textContent).toBe('FR');
    // Auto-translate off: the game moves on unread, the line goes
    store.set('ocrPaused', true);
    expect(text()).toBe('Auto-translate is off. Use Translate now to read the screen.');
    store.set('ocrPaused', false);
    expect(text()).toBe('Hello');
  });
});
