// Play view: first-run language setup, the game library, the emulator stage
// with its toolbar, the live translation card, word look-ups, recent lines
// and the text-area editor. This module owns the game session (one per
// page: EmulatorJS can't be torn down, so switching games reloads) and
// wires the parts together; each part lives in its own module.
//
// Phones: while EmulatorJS shows its on-screen pad, html[data-handheld]
// switches the stage to a phone layout (play.css): upright, the picture,
// a translation caption and the pad are stacked; sideways, the game fills
// the screen with the pad in the side bars and the toolbar in the corners.
import '../../../styles/views/play.css';
import { html, render } from '../../dom.js';
import { icon } from '../../icons.js';
import { announce, registerShortcut, installEmulatorFocusRelease, showShortcutHelp, focusHeading, shortcutsEnabled } from '../../a11y.js';
import { toast } from '../../toast.js';
import { confirmDialog } from '../../dialog.js';
import { setBusy } from '../../components.js';
import { formatRelative } from '../../format.js';
import { store } from '../../../core/store.js';
import { langName, suggestTarget } from '../../../core/language.js';
import * as emu from '../../../core/emulator.js';
import * as rom from '../../../core/rom.js';
import * as srs from '../../../core/srs.js';
import * as tts from '../../../core/tts.js';
import { idbGet, idbSet, idbDel } from '../../../core/idb.js';
import { createOnboarding } from './onboarding.js';
import { createLibrary, askSystem } from './library.js';
import { createStage, aspectOf } from './stage.js';
import { createToolbar, BEFORE_START } from './toolbar.js';
import { createLivePanel } from './livepanel.js';
import { createWordPopover } from './wordpop.js';
import { createRecentLines } from './history.js';
import { createZoneEditor, isZone, clampZone } from './zone.js';
import { createOcrSession } from './session.js';
import { createCaption } from './caption.js';
import { keyHintText, clockTime, handheldMode, padClusterMetrics } from './model.js';

// Toolbar actions after which a mouse user wants to keep playing with the
// keyboard: focus goes back to the game (event.detail > 0 = pointer click).
const REFOCUS_AFTER = new Set(['translate-now', 'pause', 'quick-save', 'quick-load', 'auto-translate', 'mute', 'fullscreen', 'restart']);
const DEBUG = typeof location !== 'undefined' && /[?&]debug=1\b/.test(location.search);

// The phone layouts follow these (jsdom and old browsers have no matchMedia).
const mq = (q) => (typeof matchMedia === 'function'
  ? matchMedia(q)
  : { matches: false, addEventListener() {}, removeEventListener() {} });
// (sideways from 560 x 240 up: smaller is a zoomed page, whose regular
// layout reflows; two pad bars beside the picture would not fit it)
const LANDSCAPE_MQ = mq('(orientation: landscape) and (min-width: 560px) and (min-height: 240px) and (max-height: 500px)');
const PORTRAIT_MQ = mq('(orientation: portrait) and (max-width: 959.98px)');
// (short phones upright: the header scrolls away and the page snaps to the game)
const SHORT_MQ = mq('(orientation: portrait) and (max-height: 719.98px)');

const ui = {};
const game = { rom: null, phase: 'idle', zone: null };
let ocr = null;
let visible = false;
let releaseFocus = null;
let translating = false;
let lastStatusState = 'off';
let announcedReady = false;

// ---- markup -------------------------------------------------------------------

function skeleton() {
  return html`<div class="page play" data-phase="idle">
    <div class="page-header play__header">
      <div class="page-header__text">
        <h1 tabindex="-1" class="play__title" data-play-title>Play</h1>
        <p class="page-header__subtitle play__subtitle" data-play-subtitle>Play a game you own and learn its language as you go.</p>
      </div>
    </div>
    <div class="play__onboarding" data-onboarding hidden></div>
    <section class="library" data-library></section>
    <div class="play-layout" data-session hidden>
      <a class="play-skip" href="#play-live-title">Skip to live translation</a>
      <div class="play-main">
        <section class="game" aria-labelledby="play-game-heading">
          <h2 class="visually-hidden" id="play-game-heading" data-game-heading>Game</h2>
          <div class="stage" data-stage data-state="idle">
            <div id="game"></div>
            <div class="stage__overlay" data-stage-overlay hidden></div>
            <div class="zone-overlay" data-zone-overlay hidden></div>
            <div class="caption" data-caption data-state="empty"></div>
          </div>
          <div class="play-controls" data-controls>
            <div class="resume" data-resume hidden></div>
            <div class="play-toolbar" data-toolbar role="group" aria-label="Game controls"></div>
          </div>
          <p class="key-hint" id="play-key-hint" data-key-hint>${keyHintText(emu.DEFAULT_KEYS.filter((k) => k.button !== 'L' && k.button !== 'R'))}</p>
          <div class="zone-panel" id="play-zone-editor" data-zone-panel hidden></div>
        </section>
      </div>
      <div class="play-side">
        <section class="card live" data-live></section>
        <section class="card recent" data-recent></section>
        ${DEBUG ? html`<p class="play-debug text-xs text-muted" data-debug></p>` : ''}
      </div>
    </div>
    <div data-popover-host></div>
  </div>`;
}

// ---- helpers -------------------------------------------------------------------

const titleOf = (r) => (r && (r.title || r.name)) || 'your game';
const isPointer = (e) => !!(e && e.detail > 0);
const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

// Single-key shortcuts can be switched off (WCAG 2.1.4): their hints go too.
function syncShortcutHints() {
  const on = shortcutsEnabled();
  ui.page.classList.toggle('play--no-shortcuts', !on);
  for (const el of ui.page.querySelectorAll('[data-keyshortcut]')) {
    if (on) el.setAttribute('aria-keyshortcuts', el.dataset.keyshortcut);
    else el.removeAttribute('aria-keyshortcuts');
  }
}

function cardsChanged() {
  window.dispatchEvent(new Event('emulingo:cards-changed'));
}

function setPhase(phase) {
  game.phase = phase;
  ui.page.dataset.phase = phase;
  syncPlayingFlag();
  ui.caption.setPhase(phase);
  syncHandheld();
}

function syncPlayingFlag() {
  const on = visible && !!game.rom && (game.phase === 'loading' || game.phase === 'running');
  document.body.toggleAttribute('data-playing', on);
}

function setHeader(r) {
  const title = ui.page.querySelector('[data-play-title]');
  const sub = ui.page.querySelector('[data-play-subtitle]');
  if (r) {
    render(title, html`<span class="visually-hidden">Play: </span>${titleOf(r)}`);
    const sys = rom.systemFor(rom.resolveCore(r, store.get('core')));
    // one core plays both: name the console this game is for
    sub.textContent = sys && sys.core === 'gb' ? (r.ext === 'gbc' ? 'Game Boy Color' : 'Game Boy') : (sys ? sys.name : '');
    ui.page.querySelector('[data-game-heading]').textContent = `Game: ${titleOf(r)}`;
  } else {
    title.textContent = 'Play';
    sub.textContent = 'Play a game you own and learn its language as you go.';
  }
}

// ---- starting and switching games ------------------------------------------------

function showSession(on) {
  ui.session.hidden = !on;
  ui.librarySection.hidden = on;
}

// EmulatorJS can't be torn down: switching games (or trying again) saves
// and reloads the page, starting `id` afterwards.
async function switchTo(id) {
  if (ocr) ocr.pause('loading');
  const saving = game.phase === 'running';
  ui.stage.saving(saving ? 'Saving your game…' : 'Reloading…');
  announce(saving ? 'Saving your game. The page reloads in a moment.' : 'Reloading the page.');
  await emu.ejectAndReload(id || null);
}

async function startGame(record, bytes) {
  if (!record) return;
  if (game.rom) {
    if (game.rom.id === record.id) return;
    switchTo(record.id);
    return;
  }
  if (emu.hasInstance()) { switchTo(record.id); return; }
  // a language picked on the setup card counts, even without "Save languages"
  ui.onboarding.commit();
  game.rom = record;
  setPhase('loading');
  let data = bytes;
  if (!data) {
    try { data = await rom.getRomBytes(record.id); } catch { data = null; }
  }
  if (!data || !data.length) {
    game.rom = null;
    setPhase('idle');
    toast(`“${titleOf(record)}” can’t be played: its file is missing. Load the ROM file again.`, { kind: 'error' });
    return;
  }

  const system = rom.systemFor(rom.resolveCore(record, store.get('core')));
  setHeader(record);
  showSession(true);
  ui.stage.setAspect(system ? system.aspect : 10 / 9);
  ui.stage.loading({ title: `Starting ${titleOf(record)}…` });
  ui.toolbar.setEnabled(false);
  ui.live.setPhase('loading');
  focusHeading(ui.root);
  announce(`Starting ${titleOf(record)}.`);

  // OCR gets ready (model download) while the emulator core downloads. A
  // failure here must not stop the game itself.
  try {
    ocr = createOcrSession({
      onStatus: onScannerStatus,
      onCapture: (c) => { showLive(c, { isNew: true }); ui.recent.refresh(); },
      onUpdate: (c) => { showLive(c); ui.recent.refresh(); },
      onCardsAdded: (n) => ui.live.setAdded(n)
    });
    ocr.pause('loading');
    if (!visible) ocr.pause('view');
    if (document.hidden) ocr.pause('hidden');
    ocr.start();
  } catch (err) {
    console.error('[play] live translation unavailable', err);
    ocr = null;
    const status = { state: 'error', message: 'Live translation isn’t available in this browser.', detail: String((err && err.message) || err) };
    ui.live.setStatus(status);
    ui.caption.setStatus(status);
  }
  loadZone(record.id);

  try {
    const started = emu.loadGame(record, data, { onProgress: (p) => ui.stage.progress(p), core: store.get('core') });
    // started from another view (autostart): it must not play behind it
    if (!visible) emu.pause('view');
    await started;
  } catch (err) {
    onStartFailed(record, err);
    return;
  }
  onStarted(record, system).catch((err) => console.error('[play] after start', err));
}

function onStartFailed(record, err) {
  setPhase('error');
  // nothing to read: stop live translation until "Try again" reloads
  if (ocr) { ocr.dispose(); ocr = null; }
  ui.live.setPhase('error');
  const message = (err && err.message) || 'The emulator couldn’t start this game.';
  ui.stage.error({ message, detail: err && err.detail && err.detail !== message ? String(err.detail) : '' });
  // the shared live region, not role=alert on the new panel: one announcement
  announce(`Couldn’t start ${titleOf(record)}. ${message}`, { assertive: true });
  const a = document.activeElement;
  if (!a || a === document.body || ui.page.contains(a)) ui.stage.focusError();
  if (err && err.code === 'needs-system') {
    askSystem(titleOf(record)).then(async (core) => {
      if (!core) return;
      await rom.updateRom(record.id, { core }).catch(() => {});
      switchTo(record.id);
    });
  }
}

async function onStarted(record, system) {
  setPhase('running');
  ui.stage.running();
  const dims = emu.getVideoDims();
  ui.stage.setAspect(dims ? aspectOf(dims) : (system ? system.aspect : 10 / 9));

  const gameEl = emu.getGameElement();
  if (gameEl) {
    gameEl.setAttribute('role', 'application');
    gameEl.setAttribute('aria-label', `Game screen: ${titleOf(record)}`);
    gameEl.setAttribute('aria-describedby', 'play-key-hint');
    gameEl.setAttribute('aria-roledescription', 'game');
  }
  ui.keyHint.textContent = keyHintText(emu.getKeyMap());
  if (releaseFocus) releaseFocus();
  releaseFocus = installEmulatorFocusRelease({
    gameEl,
    toolbarEl: ui.controls,
    onEscape: () => ui.toolbar.focusTranslate()
  });

  ui.toolbar.setEnabled(true);
  ui.toolbar.setPaused(emu.isUserPaused());
  ui.toolbar.setMuted(emu.isMuted());
  ui.toolbar.setFullscreen(emu.isFullscreen());
  ui.toolbar.setAutoTranslate(!store.get('ocrPaused'));
  ui.toolbar.setZone({ open: false, custom: !!game.zone });
  try {
    const rec = await rom.getRom(record.id);
    const t = rec && rec.saves && rec.saves.manual && rec.saves.manual.t;
    if (t) ui.toolbar.setSavedAt(t);
    game.saves = (rec && rec.saves) || {};
  } catch { game.saves = {}; }

  ui.live.setPhase('running');
  if (ocr) ocr.resume('loading');
  if (emu.isUserPaused() && ocr) ocr.pause('emulator');
  announce(`${titleOf(record)} is running. Press Escape to leave the game${shortcutsEnabled() ? ', and T to translate the screen' : ''}.`);
  if (visible) requestAnimationFrame(() => emu.handleResize());
  // EmulatorJS flashes its pad on resize (250 ms): read it once that's over
  requestAnimationFrame(syncTouchDock);
  setTimeout(syncTouchDock, 600);

  let hasResume = false;
  try { hasResume = await emu.hasAutoSave(record.id); } catch { hasResume = false; }
  if (hasResume) showResumePrompt();
}

// On touch devices EmulatorJS draws its on-screen pad over the bottom of the
// game, where most games show their text: the stage docks it underneath
// (and on phones, html[data-handheld] moves it around the picture).
function syncTouchDock() {
  const pad = document.querySelector('#game .ejs_virtualGamepad_parent');
  const on = !!pad && pad.style.display !== 'none' && pad.style.opacity !== '0';
  ui.stage.setTouchDock(on);
  // (only while it is laid out: a hidden view keeps the last measurements)
  const metrics = on && visible ? measurePad(pad) : null;
  if (metrics) ui.stage.setPadMetrics(metrics);
  if (visible) emu.handleResize();
  syncHandheld();
}

// The D-pad and A/B clusters as laid out by EmulatorJS (L/R aside: they get
// their own place), so a wide cluster keeps to its side bar. Null while the
// pad has no box to measure.
function measurePad(pad) {
  if (!pad.getBoundingClientRect().width) return null;
  const side = (cls, exclude) => {
    const zone = pad.querySelector(`.${cls}`);
    if (!zone) return null;
    const z = zone.getBoundingClientRect();
    if (!z.width) return null;
    const items = Array.from(zone.querySelectorAll('*'))
      .filter((el) => !el.closest(exclude))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width && r.height);
    return padClusterMetrics(z, items);
  };
  return {
    left: side('ejs_virtualGamepad_left', '.b_l'),
    right: side('ejs_virtualGamepad_right', '.b_r'),
    shoulders: !!pad.querySelector('.ejs_virtualGamepad_left > .b_l, .ejs_virtualGamepad_right > .b_r')
  };
}

// ---- phone layouts -----------------------------------------------------------------

const systemCore = () => {
  if (!game.rom) return null;
  const sys = rom.systemFor(rom.resolveCore(game.rom, store.get('core')));
  return sys ? sys.core : null;
};

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

// The player is reading the translation: focus in the cards, or in a word's
// look-up opened from them.
const inReading = (el) => !!el && el.nodeType === 1 && (ui.side.contains(el) || ui.popoverHost.contains(el));
const reading = () => inReading(document.activeElement);

// html[data-handheld] is the one switch for the phone layouts (play.css,
// layout.css); the dark island and the toolbar's corners go with it (the
// island also upright in fullscreen, where the game section is on black).
let settling = null; // the mode before a change that is laid out in the next frame
function syncHandheld({ scroll = false } = {}) {
  if (!ui.stage) return;
  const root = document.documentElement;
  const prev = root.dataset.handheld || null;
  const mode = handheldMode({
    visible,
    phase: game.phase,
    docked: ui.stage.docked(),
    zoneOpen: !!(ui.zone && ui.zone.isOpen()),
    system: systemCore(),
    landscape: LANDSCAPE_MQ.matches,
    portrait: PORTRAIT_MQ.matches
  });
  if (mode) root.dataset.handheld = mode;
  else delete root.dataset.handheld;
  ui.gameSection.classList.toggle('theme-dark', mode === 'landscape' || (!!mode && fullscreenElement() === ui.gameSection));
  ui.toolbar.setCorners(mode === 'landscape');
  if (mode === prev && !scroll) return;
  // one frame per change, however many media queries a rotation fires
  if (settling) return;
  settling = { from: prev };
  requestAnimationFrame(() => {
    const { from } = settling;
    settling = null;
    const now = root.dataset.handheld || null;
    // EmulatorJS's small/big screen classes; the canvas follows its new CSS size
    if (visible && game.rom) emu.handleResize();
    if (reading()) {
      // a rotation while reading the translation: the reader keeps their place
      if (from !== now && document.activeElement && document.activeElement.scrollIntoView) {
        document.activeElement.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      }
      return;
    }
    // sideways the page was scrolled down to the game: start upright at the top
    if (from === 'landscape' && now !== 'landscape' && ui.gameSection.getBoundingClientRect().top < 0) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    bringGameIntoView();
  });
}

// (no smooth scrolling: the layout has just changed under the player)
function scrollToStart(el) {
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// Sideways, and upright on short phones, the game is one screen: put it in
// view on entering the layout, on rotation and on the way back to the game
// (`force`: the player asked for it, from wherever they were reading).
// Never while the player reads the translation otherwise, and never on
// other resizes (the URL bar coming and going) or new lines. Upright, a
// page scrolled down to the cards stays there (the URL bar coming back can
// flip a phone between short and tall): only a game at least half on
// screen is put in place.
function bringGameIntoView({ force = false } = {}) {
  const mode = document.documentElement.dataset.handheld;
  if (!mode) return;
  if (!force && reading()) return;
  if (mode === 'landscape') {
    scrollToStart(ui.gameSection);
    return;
  }
  const top = ui.gameSection.getBoundingClientRect().top;
  const near = force || top > -ui.gameSection.offsetHeight / 2;
  if (SHORT_MQ.matches) {
    if (near) scrollToStart(ui.gameSection);
    return;
  }
  // Taller upright, the header is sticky and the game sits right under it at
  // the top of the page (8 px below it on phones). A page scrolled for a
  // short screen (the URL bar hid, the screen grew) or for the text-area
  // editor would leave the game's top at or under the header.
  const header = document.querySelector('.app-header');
  const below = header ? header.getBoundingClientRect().bottom : 0;
  if (top < below + 8 && near) scrollToStart(ui.gameSection);
}

// The caption's button: the full Live translation card, on the line the
// caption shows (back from an earlier line, or a line held back while the
// card was being read), focused. Out of fullscreen first, or the card isn't
// there to see.
async function openLive() {
  if (emu.isFullscreen()) {
    ui.toolbar.setFullscreen(await emu.toggleFullscreen());
    // EmulatorJS hands focus back to the game just after fullscreen ends
    await new Promise((r) => setTimeout(r, 50));
  }
  ui.live.showLatest();
  requestAnimationFrame(() => {
    scrollToStart(ui.page.querySelector('[data-live]'));
    ui.live.focusCurrent();
  });
}

function returnToGame() {
  bringGameIntoView({ force: true });
  emu.focusGame();
}

// Every live capture goes to the card and to the caption, which always
// shows the newest one (the card may hold a line back, or show history). A
// new capture (or Translate now) is a fresh read of the screen.
function showLive(c, opts = {}) {
  ui.live.showLive(c, opts);
  ui.caption.show(ui.live.latest(), { fresh: !!opts.isNew });
}

// Plain resizes (the URL bar) never scroll; sideways, a new width (split
// screen, a foldable) lays the game screen out anew: put it back in place.
let resizeFrame = 0;
let lastWidth = typeof innerWidth === 'number' ? innerWidth : 0;
function onWindowResize() {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    const widthChanged = innerWidth !== lastWidth;
    lastWidth = innerWidth;
    syncHandheld();
    if (widthChanged && document.documentElement.dataset.handheld === 'landscape') bringGameIntoView();
  });
}

// (one rotation changes several queries: one re-measure for all of them)
let padTimer = 0;
function onOrientation() {
  syncHandheld({ scroll: true });
  // re-measure once EmulatorJS's 250 ms pad flash is over
  clearTimeout(padTimer);
  if (game.phase === 'running') padTimer = setTimeout(syncTouchDock, 300);
}

// ---- "Resume where you left off?" ------------------------------------------------

function showResumePrompt() {
  const auto = game.saves && game.saves.auto && game.saves.auto.t;
  render(ui.resume, html`<div class="resume__icon" aria-hidden="true">${icon('history', { size: 20 })}</div>
    <p class="resume__text" id="play-resume-title"><strong>Resume where you left off?</strong>
      <span class="resume__meta">${auto ? `Saved automatically ${formatRelative(auto)}.` : 'Your last session was saved automatically.'}</span></p>
    <div class="resume__actions">
      <button type="button" class="btn btn--primary btn--sm" data-action="resume-yes" aria-describedby="play-resume-title">${icon('play', { size: 16 })}<span class="btn__label">Resume</span></button>
      <button type="button" class="btn btn--sm" data-action="resume-no" aria-describedby="play-resume-title"><span class="btn__label">Start fresh</span></button>
    </div>`);
  ui.resume.setAttribute('role', 'group');
  ui.resume.setAttribute('aria-labelledby', 'play-resume-title');
  ui.resume.hidden = false;
  announce('You have a saved game. Resume where you left off? Choose Resume or Start fresh.');
}

function hideResumePrompt() {
  ui.resume.hidden = true;
  render(ui.resume, '');
}

async function answerResume(yes) {
  hideResumePrompt();
  if (!yes) {
    emu.dismissResume();
    announce('Starting fresh.');
  } else {
    try {
      const ok = await emu.resumeAutoSave();
      if (ok) toast('Back where you left off.', { kind: 'success' });
      else toast('The automatic save is gone, so the game starts fresh.', { kind: 'info' });
    } catch (err) {
      emu.dismissResume();
      toast((err && err.message) || 'Couldn’t load the automatic save.', { kind: 'error' });
    }
  }
  emu.focusGame();
}

// ---- toolbar ---------------------------------------------------------------------

async function translateNow() {
  if (!ocr || game.phase !== 'running' || translating) return;
  translating = true;
  const btn = ui.toolbar.button('translate-now');
  setBusy(btn, true, { label: 'Reading…' });
  try {
    const snap = await ocr.scanNow();
    if (snap) {
      if (ui.live.mode() === 'history') ui.live.backToLive({ focus: false });
      // the scanner's current capture is the newest one, whatever was shown
      showLive(snap, { isNew: true, force: true });
    } else {
      // without a game language nothing is read at all: say what to do
      ui.live.flashNotice(store.get('source') ? 'No text found on the screen.' : 'Choose the game’s language first, then try again.');
    }
  } catch (err) {
    console.warn('[play] translate now failed', err);
    ui.live.flashNotice('Couldn’t read the screen. Try again.');
  } finally {
    setBusy(btn, false);
    translating = false;
  }
}

function toggleAutoTranslate() {
  const paused = !store.get('ocrPaused');
  store.set('ocrPaused', paused);
  announce(paused ? 'Auto-translate is off. Use Translate now to read the screen.' : 'Auto-translate is on.');
}

function togglePause() {
  if (emu.isUserPaused()) emu.resume('user');
  else emu.pause('user');
  const paused = emu.isUserPaused();
  ui.toolbar.setPaused(paused);
  announce(paused ? 'Game paused.' : 'Game resumed.');
}

async function quickSave() {
  try {
    const { savedAt } = await emu.quickSave();
    ui.toolbar.setSavedAt(savedAt);
    toast(`Game saved at ${clockTime(savedAt)}.`, { kind: 'success' });
  } catch (err) {
    toast((err && err.message) || 'Couldn’t save your progress.', { kind: 'error' });
  }
}

async function quickLoad() {
  try {
    const ok = await emu.quickLoad();
    if (!ok) {
      toast('There’s no quick save for this game yet. Use Quick save first.', { kind: 'info' });
      return;
    }
    const rec = await rom.getRom(game.rom.id).catch(() => null);
    const t = rec && rec.saves && rec.saves.manual && rec.saves.manual.t;
    toast(t ? `Loaded your quick save from ${clockTime(t)}.` : 'Loaded your quick save.', { kind: 'success' });
  } catch (err) {
    toast((err && err.message) || 'Couldn’t load the saved game.', { kind: 'error' });
  }
}

async function restartGame(pointer) {
  const ok = await confirmDialog({
    title: 'Restart the game?',
    body: 'The game starts again from the beginning. Progress since your last save is lost.',
    confirmLabel: 'Restart',
    danger: true
  });
  if (!ok) return;
  try {
    emu.restart();
    toast('Game restarted.', { kind: 'success' });
  } catch (err) {
    toast((err && err.message) || 'Couldn’t restart the game.', { kind: 'error' });
  }
  if (pointer) emu.focusGame();
}

// EmulatorJS's key and gamepad mapping lives behind its own (hidden) control
// bar; its button still works when clicked from here.
function openGameControls() {
  const btn = Array.from(document.querySelectorAll('#game .ejs_menu_bar .ejs_menu_button'))
    .find((b) => /control settings/i.test(b.textContent || ''));
  if (!btn) {
    toast('Game control settings aren’t available for this game.', { kind: 'info' });
    return;
  }
  btn.click();
  // move keyboard users into the dialog EmulatorJS just opened
  requestAnimationFrame(() => {
    const popup = openEjsPopup();
    if (popup) labelEjsControls(popup);
    const first = popup && popup.querySelector('button, [tabindex], input, select');
    if (first) first.focus();
  });
}

// EmulatorJS's key-mapping popup ships unnamed fields (two per button), tabs
// outside a tablist and a select named only by its title: name them so screen
// readers can tell "A: keyboard key" from "A: gamepad button".
function labelEjsControls(popup) {
  const bar = popup.querySelector('.ejs_control_player_bar');
  if (bar && bar.querySelector('[role="tab"]')) {
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Player');
  }
  for (const sel of popup.querySelectorAll('select[title^="gamepad"]')) sel.setAttribute('aria-label', 'Connected gamepad');
  for (const row of popup.querySelectorAll('[data-label]')) {
    const name = row.dataset.label;
    const [pad, key] = row.querySelectorAll('input[type="text"]');
    if (pad) pad.setAttribute('aria-label', `${name}: gamepad button`);
    if (key) key.setAttribute('aria-label', `${name}: keyboard key`);
    for (const b of row.querySelectorAll('button, .ejs_control_set_button')) {
      if (/^\s*set\s*$/i.test(b.textContent || '')) b.setAttribute('aria-label', `Set ${name}`);
    }
  }
  const title = popup.querySelector('h4');
  if (title) title.setAttribute('aria-level', '2');
}

function openEjsPopup() {
  return Array.from(document.querySelectorAll('#game .ejs_popup_container')).find((p) => p.offsetParent !== null) || null;
}

// Keyboard inside EmulatorJS's own dialogs: Tab moves through them (instead
// of jumping to our toolbar) and Escape closes them, back to the More button.
function onEjsPopupKey(e) {
  const popup = openEjsPopup();
  if (!popup || !popup.contains(e.target)) return;
  if (e.key === 'Tab') {
    e.stopImmediatePropagation();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const close = Array.from(popup.querySelectorAll('button, a')).find((b) => /^close$/i.test((b.textContent || '').trim()));
    if (close) close.click();
    else popup.style.display = 'none';
    const more = document.getElementById('play-more');
    if (more) more.focus();
  }
}

function toggleZoneEditor() {
  if (ui.zone.isOpen()) ui.zone.close({ cancelled: true });
  else ui.zone.open(game.zone);
}

// On a phone the game section goes fullscreen, so the toolbar comes along
// (play.css .game:fullscreen); elsewhere the stage, as always.
const fullscreenTarget = () => (document.documentElement.dataset.handheld ? ui.gameSection : null);

async function onToolbar(action, e) {
  const pointer = isPointer(e);
  // the toolbar marks these aria-disabled until then; this is the backstop
  if (game.phase !== 'running' && !BEFORE_START.includes(action)) return;
  switch (action) {
    case 'translate-now': await translateNow(); break;
    case 'pause': togglePause(); break;
    case 'quick-save': await quickSave(); break;
    case 'quick-load': await quickLoad(); break;
    case 'zone': toggleZoneEditor(); break;
    case 'auto-translate': toggleAutoTranslate(); break;
    case 'mute': ui.toolbar.setMuted(emu.mute(!emu.isMuted())); break;
    case 'fullscreen': ui.toolbar.setFullscreen(await emu.toggleFullscreen(fullscreenTarget())); break;
    case 'restart': restartGame(pointer); return;
    case 'eject': switchTo(null); return;
    case 'return-to-game': returnToGame(); return;
    case 'game-controls': openGameControls(); return;
    case 'shortcuts': showShortcutHelp(); return;
    default: return;
  }
  if (pointer && REFOCUS_AFTER.has(action) && game.phase === 'running') emu.focusGame();
}

// ---- scanner status ----------------------------------------------------------------

function onScannerStatus(s) {
  ui.live.setStatus(s);
  ui.caption.setStatus(s);
  ui.live.setHint(s.hint || null);
  if (s.state === 'error' && lastStatusState !== 'error') announce(s.message || 'Live translation ran into a problem.');
  if (s.state === 'setup') announcedReady = false;
  if (lastStatusState === 'setup' && s.state !== 'setup' && s.state !== 'error' && !announcedReady) {
    announcedReady = true;
    announce('Text recognition is ready.');
  }
  lastStatusState = s.state;
}

async function retryErrors() {
  const c = ui.live.current();
  const mode = ui.live.mode();
  let any = false;
  if (c && ocr) {
    const keys = [];
    if (c.dialog && c.dialog.status === 'error') keys.push('dialog');
    for (const o of c.others || []) if (o.status === 'error') keys.push(o.key);
    for (const k of keys) {
      any = true;
      const res = await ocr.retry(c, k, mode);
      if (res && typeof res === 'object') ui.live.updateShown(res);
    }
  }
  if (!any) translateNow();
}

// ---- text area -----------------------------------------------------------------------

async function loadZone(romId) {
  let z = null;
  try { z = await idbGet('zone:' + romId); } catch { z = null; }
  game.zone = isZone(z) ? clampZone(z) : null;
  if (game.zone && ocr) ocr.setZone(game.zone);
  ui.toolbar.setZone({ open: false, custom: !!game.zone });
}

async function saveZone(z) {
  game.zone = z ? clampZone(z) : null;
  if (ocr) ocr.setZone(game.zone);
  const key = 'zone:' + game.rom.id;
  try {
    if (game.zone) await idbSet(key, game.zone);
    else await idbDel(key);
  } catch {
    toast('The text area works for now but couldn’t be saved for next time.', { kind: 'warning' });
  }
}

// ---- learning actions ------------------------------------------------------------------

function addToDeck(c) {
  if (!c || !c.dialog || !c.dialog.text) return;
  const res = srs.addCard({ text: c.dialog.text, translation: c.dialog.translation, src: c.src, tgt: c.tgt, origin: 'manual' });
  if (res.status === 'added') {
    announce('Added to your deck.');
    toast('Added to your deck.', { kind: 'success' });
    cardsChanged();
  } else if (res.status === 'duplicate') {
    announce('This line is already in your deck.');
    toast('This line is already in your deck.', { kind: 'info' });
  } else {
    toast('Couldn’t add this line to your deck.', { kind: 'error' });
  }
}

function switchLanguage(code) {
  if (!code) return;
  // source first: changing the target first would re-translate the misread
  // line into it as one more history entry before the line is read again
  const clash = store.get('target') === code;
  store.set('source', code);
  if (clash) store.set('target', suggestTarget(code));
  if (ocr) ocr.dismissHint();
  announce(`Game language changed to ${langName(code)}.`);
}

// ---- shortcuts ---------------------------------------------------------------------------

function registerShortcuts() {
  registerShortcut({
    key: 't',
    label: 'Translate now',
    scope: 'play',
    allowInGame: true,
    handler: () => {
      if (game.phase !== 'running') return false;
      translateNow();
      return true;
    }
  });
  registerShortcut({
    key: 'p',
    label: 'Turn auto-translate on or off',
    scope: 'play',
    allowInGame: true,
    handler: () => {
      if (game.phase !== 'running') return false;
      toggleAutoTranslate();
      return true;
    }
  });
  registerShortcut({
    key: 'g',
    label: 'Return to the game',
    scope: 'play',
    handler: () => {
      if (game.phase !== 'running') return false;
      returnToGame();
      return true;
    }
  });
}

// ---- events from the emulator and the page ------------------------------------------------

function onEmulatorEvent(type, detail = {}) {
  if (type === 'paused') {
    if (emu.isUserPaused() && ocr) ocr.pause('emulator');
    ui.toolbar.setPaused(emu.isUserPaused());
  } else if (type === 'resumed') {
    if (ocr) ocr.resume('emulator');
    ui.toolbar.setPaused(false);
  } else if (type === 'saved' && detail.slot === 'manual') {
    ui.toolbar.setSavedAt(detail.t);
  } else if ((type === 'loaded' || type === 'restarted') && !ui.resume.hidden) {
    // a quick load or a restart answers "Resume where you left off?" (the
    // emulator lets autosave run again), so the question would be stale
    const hadFocus = ui.resume.contains(document.activeElement);
    hideResumePrompt();
    if (hadFocus) ui.toolbar.focusTranslate();
  } else if (type === 'error' && detail.phase === 'save' && detail.slot !== 'manual') {
    // (Quick save reports its own failure: one toast per click)
    toast(detail.message || 'Couldn’t save your progress.', { kind: detail.code === 'storage-full' ? 'error' : 'warning' });
  }
}

function onVisibility() {
  if (!ocr) return;
  if (document.hidden) ocr.pause('hidden');
  else ocr.resume('hidden');
}

function onStoreChange(key, value) {
  if (key === 'ocrPaused') {
    ui.toolbar.setAutoTranslate(!value);
    ui.caption.setAutoTranslate(!value);
  } else if (key === 'shortcuts') syncShortcutHints();
  else if (key === 'target') ui.caption.setTarget(value);
}

// A file dropped anywhere but a drop zone (which accepts it first, with
// preventDefault) would make the browser open or download it, and opening
// it leaves the page and the running game.
const guardsDrops = (e) => hasFiles(e) && !e.defaultPrevented && (visible || !!game.rom);

function onPageDragOver(e) {
  if (!guardsDrops(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'none';
}

function onPageDrop(e) {
  if (!guardsDrops(e)) return;
  e.preventDefault();
  if (game.rom) toast('To play another game, eject this one first: More, then Eject game.', { kind: 'info' });
}

// ---- view contract ----------------------------------------------------------------------

async function boot() {
  const autostart = emu.consumeAutostart();
  ui.onboarding.sync();
  await ui.library.refresh();
  rom.sweepOrphans({ keep: autostart ? [autostart] : [] }).catch(() => {});
  if (!autostart) return;
  const record = await rom.getRom(autostart).catch(() => null);
  if (record) await startGame(record, null);
  else toast('That game is no longer in your library.', { kind: 'info' });
}

function mount(section) {
  ui.root = section;
  render(section, skeleton());
  const $ = (sel) => section.querySelector(sel);
  ui.page = $('.play');
  ui.session = $('[data-session]');
  ui.librarySection = $('[data-library]');
  ui.controls = $('[data-controls]');
  ui.resume = $('[data-resume]');
  ui.keyHint = $('[data-key-hint]');
  ui.gameSection = $('section.game');
  ui.side = $('.play-side');
  ui.popoverHost = $('[data-popover-host]');

  ui.onboarding = createOnboarding($('[data-onboarding]'), {
    // Saving from the card itself removes the button that had focus. (When a
    // game start saved the languages, the game's own flow moves focus.)
    onDone: (src, tgt, { fromSubmit = false } = {}) => {
      if (!fromSubmit) return;
      if (!game.rom) {
        announce('Now load a game you own.');
        ui.library.focusChooser();
      } else if (game.phase === 'running') {
        ui.toolbar.focusTranslate();
      } else {
        focusHeading(ui.root);
      }
    }
  });
  ui.library = createLibrary(ui.librarySection, {
    onPlay: (record, bytes) => startGame(record, bytes).catch((err) => console.error('[play] start failed', err))
  });
  ui.stage = createStage($('[data-stage]'), {
    onRetry: () => switchTo(game.rom ? game.rom.id : null),
    onChooseAnother: () => switchTo(null)
  });
  ui.toolbar = createToolbar($('[data-toolbar]'), { onAction: onToolbar, zoneEditorId: 'play-zone-editor' });
  ui.caption = createCaption($('[data-caption]'), { onOpen: openLive, target: store.get('target'), autoTranslate: !store.get('ocrPaused') });
  // iPhone Safari has no element fullscreen: a Fullscreen button there would do nothing
  if (!emu.canFullscreen()) ui.toolbar.remove('fullscreen');
  ui.popover = createWordPopover({
    host: $('[data-popover-host]'),
    onChange: (open) => ui.live && ui.live.setPopoverOpen(open),
    onCardsChanged: cardsChanged
  });
  ui.live = createLivePanel($('[data-live]'), {
    popover: ui.popover,
    onRetryPart: async (c, key, mode) => {
      if (!ocr) return;
      const res = await ocr.retry(c, key, mode);
      if (res && typeof res === 'object') ui.live.updateShown(res);
      if (!res) toast('Still couldn’t translate. Check your connection.', { kind: 'warning' });
    },
    onStatusRetry: retryErrors,
    onSwitchLanguage: switchLanguage,
    onDismissHint: () => ocr && ocr.dismissHint(),
    onAddToDeck: addToDeck,
    onModeChange: (mode, c) => ui.recent.setActive(mode === 'history' && c ? c.id : null)
  });
  ui.recent = createRecentLines($('[data-recent]'), {
    onOpen: (c) => ui.live.showHistory(c),
    // the earlier line on show is gone with the rest
    onCleared: () => { if (ui.live.mode() === 'history') ui.live.backToLive({ focus: false, quiet: true }); }
  });
  ui.zone = createZoneEditor({
    overlayEl: $('[data-zone-overlay]'),
    panelEl: $('[data-zone-panel]'),
    // (the phone layouts are off while editing: the editor uses the regular one)
    onOpen: () => {
      if (ocr) ocr.pause('zone');
      document.body.classList.add('play-zone-editing');
      ui.toolbar.setZone({ open: true, custom: !!game.zone });
      syncHandheld();
    },
    onClose: () => {
      if (ocr) ocr.resume('zone');
      document.body.classList.remove('play-zone-editing');
      ui.toolbar.setZone({ open: false, custom: !!game.zone });
      syncHandheld({ scroll: true });
    },
    onSave: saveZone
  });
  ui.resume.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b) answerResume(b.dataset.action === 'resume-yes');
  });

  // While the player reads the translation the page doesn't snap back to
  // the game under them (layout.css).
  section.addEventListener('focusin', (e) => document.documentElement.classList.toggle('play-reading', inReading(e.target)));
  section.addEventListener('focusout', (e) => { if (!inReading(e.relatedTarget)) document.documentElement.classList.remove('play-reading'); });

  // In-page jump without touching the URL: a plain #fragment would add a
  // history entry that the hash router then has to rewrite.
  $('.play-skip').addEventListener('click', (e) => {
    const target = section.querySelector('#play-live-title');
    if (!target) return;
    e.preventDefault();
    target.setAttribute('tabindex', '-1');
    target.focus();
  });

  registerShortcuts();
  // registered before the game starts, so it runs before the focus release
  document.addEventListener('keydown', onEjsPopupKey, true);
  emu.onEvent(onEmulatorEvent);
  document.addEventListener('visibilitychange', onVisibility);
  const onFullscreen = () => {
    ui.toolbar.setFullscreen(emu.isFullscreen());
    syncHandheld();
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);
  for (const q of [LANDSCAPE_MQ, PORTRAIT_MQ, SHORT_MQ]) q.addEventListener('change', onOrientation);
  window.addEventListener('resize', onWindowResize);
  document.addEventListener('dragover', onPageDragOver);
  document.addEventListener('drop', onPageDrop);
  tts.onSpeakingChange((on) => ui.live.setSpeaking(on));
  store.subscribe(onStoreChange);
  ui.toolbar.setAutoTranslate(!store.get('ocrPaused'));
  syncShortcutHints();

  if (DEBUG) {
    setInterval(() => {
      const el = section.querySelector('[data-debug]');
      if (!el || !ocr) return;
      const st = ocr.scanner.getState();
      el.textContent = `OCR reads ${st.stats.reads} · cache hits ${st.stats.cacheHits} · screen reads ${st.stats.screenReads || 0} · last ${Math.round(st.stats.lastReadMs)} ms · ${st.stats.engine || '—'} · ${st.status.state}`;
    }, 1000);
  }

  boot().catch((err) => console.error('[play] boot failed', err));
}

function show() {
  visible = true;
  syncPlayingFlag();
  if (game.rom) {
    emu.resume('view');
    if (ocr) ocr.resume('view');
    // the canvas collapses while the view is hidden (MISS-01); the pad is
    // measured again now that it is laid out
    requestAnimationFrame(() => {
      if (game.phase === 'running') syncTouchDock();
      else emu.handleResize();
      syncHandheld({ scroll: true });
    });
  } else {
    ui.onboarding.sync();
    if (ui.library.isLoaded()) ui.library.refresh();
  }
  ui.recent.refresh();
}

function hide() {
  visible = false;
  syncPlayingFlag();
  syncHandheld();
  document.documentElement.classList.remove('play-reading');
  if (ui.popover) ui.popover.close({ returnFocus: false });
  if (ui.zone && ui.zone.isOpen()) ui.zone.close({ cancelled: true });
  if (game.rom) emu.pause('view');
  if (ocr) ocr.pause('view');
}

export default {
  id: 'play',
  title: 'Play',
  icon: 'gamepad',
  mount,
  show,
  hide
};
