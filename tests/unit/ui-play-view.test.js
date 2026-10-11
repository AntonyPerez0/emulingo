// @vitest-environment jsdom
// The Play view wired together (src/ui/views/play/index.js), with the
// emulator, the ROM store and the OCR session replaced by fakes.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
afterAll(() => wait(150));

const RECORD = { id: 'rom-abc', name: 'Pokemon Red.gb', title: 'Pokémon Red', core: 'gb', added: 1, saves: {} };

// ---- fakes ---------------------------------------------------------------------------

const emu = vi.hoisted(() => ({
  listeners: new Set(),
  calls: [],
  autostart: null,
  autoSave: false,
  startGate: null
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
    toggleFullscreen: async () => false,
    ejectAndReload: (id) => { emu.calls.push(['ejectAndReload', id]); return new Promise(() => {}); }
  };
});

vi.mock('../../src/core/rom.js', () => {
  const SYSTEMS = [{ core: 'gb', name: 'Game Boy and Game Boy Color', short: 'Game Boy', exts: ['gb', 'gbc'], aspect: 10 / 9 }];
  return {
    SYSTEMS,
    systemFor: (core) => SYSTEMS.find((s) => s.core === core) || null,
    resolveCore: (r) => (r && r.core) || 'gb',
    listRoms: async () => [RECORD],
    getRom: async (id) => (id === RECORD.id ? { ...RECORD } : null),
    getRomBytes: async () => new Uint8Array([1, 2, 3]),
    updateRom: async () => true,
    sweepOrphans: async () => 0,
    acceptAttr: () => '.gb,.gbc,.gba',
    importRomFile: async () => { throw new Error('not in this test'); },
    deleteRom: async () => true
  };
});

vi.mock('../../src/ui/views/play/session.js', () => ({
  createOcrSession: () => ({
    scanner: { getState: () => ({ stats: {}, status: { state: 'watching' } }) },
    start() {}, pause() {}, resume() {}, setZone() {}, dismissHint() {}, dispose() {},
    scanNow: async () => null,
    retry: async () => false
  })
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
