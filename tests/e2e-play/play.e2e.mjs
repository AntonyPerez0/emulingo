#!/usr/bin/env node
// End-to-end checks for the Play view with the REAL emulator (EmulatorJS
// 4.2.3, gambatte core served from bench/.cache/emulatorjs) and the
// homebrew test ROM from bench/e2e/make-gb-rom.mjs (8 pages of dialog: 2
// English, 6 German), in headless Chromium against the live working tree.
//
//   node tests/e2e-play/play.e2e.mjs [--only flow,states,shots,phone] [--shots DIR] [--port N] [--headed]
//
// flow:  onboarding through the UI, ROM upload via "Choose ROM file", wait
//        for the game, press A ('z') through every page and check: the
//        dialog shown equals the ROM text (a continued sentence shows as
//        one transcript), a translation is shown, no duplicate history
//        entries, status chip states, long tasks while reading vs a
//        control window, and the keyboard paths (Esc leaves the game, Tab
//        reaches Translate now, word buttons, popover open/close + focus).
//        Also: quick save/load, pause, the text-area editor, eject and
//        "Resume where you left off?". axe (zero violations) runs in:
//        onboarding, library, running, popover open, text area, resume
//        (EmulatorJS's own markup inside #game is reported separately).
// states: loading and error stages, reflow at 320 px and 640×400 (200 %).
// shots: 1440×900 and 390×844 in dark and light (onboarding, library, running).
// phone: the phone layouts (html[data-handheld]) with EmulatorJS's on-screen
//        pad (Android UA, touch): picture, caption, pad and toolbar geometry
//        at every listed phone size held upright and sideways, rotation
//        round trips, a tap on the moved A key, the caption's button and G,
//        More, the text-area editor, Resume, fullscreen, safe areas, a GBA
//        game with L/R (tests/e2e-play/make-gba-rom.mjs), axe, desktop and
//        tablet invariants, and fps at 4× CPU throttling (report only).
//
// Translation uses the real Google endpoint through $HTTPS_PROXY. axe-core
// comes from node_modules/axe-core or $AXE_PATH. Starts Vite (no HMR) on
// the first free port from 5420. Prints PASS/FAIL lines; exits 1 on failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createCdnRouter } from '../../bench/lib/routes.mjs';
import { setup as setupEmulatorJs, EJS_DIR } from '../../bench/e2e/setup.mjs';
import { writeAll, PAGES } from '../../bench/e2e/make-gb-rom.mjs';
import { writeGbaRom } from './make-gba-rom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const ONLY = new Set(String(arg('--only', 'flow,states,shots,phone')).split(','));
const SHOTS = arg('--shots', path.join(os.tmpdir(), 'spritespeak-e2e-play'));
const HEADED = argv.includes('--headed');
const PORTS = arg('--port') ? [Number(arg('--port'))] : [5420, 5421, 5422, 5423, 5424, 5425, 5426, 5427];
const PAGE_TIMEOUT = Number(arg('--page-timeout', 45)) * 1000;
const FIRST_TIMEOUT = Number(arg('--first-timeout', 150)) * 1000;

fs.mkdirSync(SHOTS, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- results ----------------------------------------------------------------------

const results = [];
function check(name, ok, info) {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ` :: ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
  return !!ok;
}

// ---- axe ------------------------------------------------------------------------------

function loadAxe() {
  const candidates = [process.env.AXE_PATH];
  try { candidates.push(createRequire(import.meta.url).resolve('axe-core/axe.min.js')); } catch { /* not installed */ }
  for (const p of candidates) if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  console.warn('WARN axe-core not found (npm i -D axe-core, or set AXE_PATH): accessibility scans skipped');
  return null;
}
const AXE = loadAxe();

// Entrance animations (a prompt or menu fading in) finish first: axe would
// measure a half-transparent text's contrast. (Spinners loop: not waited for.)
const settleAnimations = (page) => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations()
    .filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {}))),
  new Promise((r) => setTimeout(r, 2000))
]));

async function axeScan(page, label) {
  if (!AXE) return;
  await page.evaluate(AXE);
  await settleAnimations(page);
  const run = (opts) => page.evaluate(async (o) => {
    const r = await window.axe.run(o.context, { resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
  }, opts);
  const app = await run({ context: { exclude: [['#game']] } });
  check(`axe: ${label}`, app.length === 0, app.length ? app : undefined);
  const ejs = await page.evaluate(() => !!document.querySelector('#game *'));
  if (ejs) {
    const inGame = await run({ context: { include: [['#game']] } });
    if (inGame.length) console.log(`INFO axe inside #game (EmulatorJS markup, not ours) ${label}: ${JSON.stringify(inGame.map((v) => v.id))}`);
  }
}

// ---- server ------------------------------------------------------------------------------

async function startVite() {
  const { createServer } = await import('vite');
  for (const port of PORTS) {
    try {
      const server = await createServer({
        root: ROOT,
        configFile: path.join(ROOT, 'vite.config.js'),
        logLevel: 'warn',
        clearScreen: false,
        // other agents edit src/ concurrently: no reloads mid-run
        server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
        optimizeDeps: { include: ['nspell'] }
      });
      await server.listen();
      return { server, base: `http://127.0.0.1:${port}/` };
    } catch (e) {
      if (!/in use|EADDRINUSE/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error(`No free port in ${PORTS.join(', ')}`);
}

// ---- expected transcripts ------------------------------------------------------------------

const TERMINAL = /[.!?…]["'”’)]*$/u;
// What the dialog card should show after each page: a page that continues an
// unfinished sentence joins the previous page's transcript.
function expectedTranscripts() {
  const out = [];
  let cur = '';
  for (const [l1, l2] of PAGES) {
    const page = `${l1} ${l2}`;
    cur = cur && !TERMINAL.test(cur) ? `${cur} ${page}` : page;
    out.push(cur);
  }
  return out;
}

const norm = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---- page helpers ------------------------------------------------------------------------------

// EmulatorJS shows its on-screen pad only to a mobile user agent with touch.
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function newContext(browser, router, { viewport, colorScheme = 'dark', mobile = false, settings, userAgent, dpr } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme,
    serviceWorkers: 'block',
    deviceScaleFactor: dpr || (mobile ? 2 : 1),
    isMobile: mobile,
    hasTouch: mobile,
    ...(userAgent ? { userAgent } : {})
  });
  await router.install(context);
  if (settings) {
    await context.addInitScript((s) => {
      try { if (!localStorage.getItem('emulingo:settings')) localStorage.setItem('emulingo:settings', JSON.stringify(s)); } catch { /* ignore */ }
    }, { settingsVersion: 2, ...settings });
  }
  // long tasks, from the start
  await context.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) });
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* unsupported */ }
  });
  return context;
}

function watchErrors(page, label, errors = []) {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // onnxruntime's initializer notes and EmulatorJS's wake-lock refusal are not app errors
    if (/Removing initializer|Wake Lock|wakeLock|favicon/i.test(t)) return;
    // ("Failed to load resource" names no resource: add where it came from)
    const url = (m.location() && m.location().url) || '';
    errors.push(`${label} console.error: ${t}${url && !t.includes(url) ? ` (${url})` : ''}`);
  });
  return errors;
}

async function openPlay(page, base) {
  await page.goto(`${base}#/play`);
  // the view's own heading: the router's loading placeholder has an h1 too
  await page.waitForSelector('section[data-view="play"]:not([hidden]) [data-play-title]', { timeout: 30000 });
  await page.waitForTimeout(300);
}

async function loadRom(page, romPath) {
  await page.setInputFiles('section[data-view="play"] [data-rom-input]', romPath);
  await page.waitForSelector('.stage[data-state="running"]', { timeout: 120000 });
}

const liveDialog = (page) => page.evaluate(() => {
  const orig = document.querySelector('.live .part--dialog .part__orig');
  const trans = document.querySelector('.live .part--dialog .part__trans');
  return {
    text: orig ? orig.textContent.replace(/\s+/g, ' ').trim() : '',
    lang: orig ? orig.getAttribute('lang') : null,
    // final translations only (not pending, failed or "updating…" after the text grew)
    translation: trans && !trans.matches('.part__trans--pending, .part__trans--error, .part__trans--updating') ? trans.textContent.replace(/\s+/g, ' ').trim() : '',
    transLang: trans ? trans.getAttribute('lang') : null,
    queued: !!document.querySelector('[data-action="show-queued"]')
  };
});

// A held press (the ROM polls the pad once per frame; a 1 ms tap can be missed)
async function pressA(page) {
  await page.focus('#game');
  await page.keyboard.down('z');
  await sleep(150);
  await page.keyboard.up('z');
}

async function waitForDialog(page, expected, timeout) {
  const want = norm(expected);
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = await liveDialog(page);
    // (the pointer is parked outside the panel, so a queued line means focus was inside)
    if (last.queued) await page.evaluate(() => document.querySelector('[data-action="show-queued"]')?.click());
    if (norm(last.text) === want && last.translation) return { ok: true, ...last };
    await sleep(250);
  }
  return { ok: false, ...last };
}

// ---- flow ----------------------------------------------------------------------------------------

async function flow(browser, router, base, romPath) {
  const context = await newContext(browser, router, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page, 'flow');
  await openPlay(page, base);

  // chip states over the whole run
  await page.evaluate(() => {
    window.__chipStates = [];
    const tick = () => {
      const c = document.querySelector('.live .status-chip');
      if (c) {
        const s = c.dataset.state;
        if (window.__chipStates[window.__chipStates.length - 1] !== s) window.__chipStates.push(s);
      }
    };
    setInterval(tick, 100);
  });

  // onboarding through the UI
  check('onboarding card shown on first run', await page.isVisible('.onboarding'));
  if (AXE) await axeScan(page, 'onboarding');
  await page.click('.onboarding [data-quick="de"]');
  const target = await page.$eval('.onboarding select[id$="-target"]', (s) => s.value);
  check('Translate into defaults to a language other than the game’s', target && target !== 'de', target);
  await page.click('.onboarding button[type="submit"]');
  await page.waitForSelector('.onboarding', { state: 'detached', timeout: 5000 });
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('emulingo:settings') || '{}'));
  check('languages saved and onboarding marked done', settings.source === 'de' && settings.onboarded === true, settings);
  check('focus moves to "Choose ROM file" after setup', await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'choose-rom'));
  if (AXE) await axeScan(page, 'library (empty)');

  // load the ROM through the visible chooser's input
  const tLoad = Date.now();
  await loadRom(page, romPath);
  log(`game running after ${Date.now() - tLoad} ms`);
  check('library hidden while the game runs', await page.isHidden('[data-library]'));
  check('#game is a labelled application', await page.evaluate(() => {
    const g = document.getElementById('game');
    return g.getAttribute('role') === 'application' && /Game screen/.test(g.getAttribute('aria-label')) && g.getAttribute('aria-describedby') === 'play-key-hint' && g.tabIndex === 0;
  }));
  check('toolbar enabled after start', await page.evaluate(() => !document.querySelector('.tb[aria-disabled="true"]')));

  // pages
  const expected = expectedTranscripts();
  // park the pointer outside the live panel (hovering it holds new lines back on purpose)
  await page.mouse.move(2, 2);
  await page.focus('#game');
  const pageResults = [];
  let readingStart = null;
  for (let i = 0; i < PAGES.length; i++) {
    if (i > 0) await pressA(page);
    const r = await waitForDialog(page, expected[i], i === 0 ? FIRST_TIMEOUT : PAGE_TIMEOUT);
    if (i === 0) readingStart = await page.evaluate(() => performance.now());
    pageResults.push({ page: i, ...r });
    check(`page ${i}: dialog shows “${expected[i]}”`, r.ok && r.lang === 'de', r.ok ? undefined : { shown: r.text, translation: r.translation });
    if (r.ok) check(`page ${i}: translation shown (lang=${r.transLang})`, !!r.translation && r.transLang === 'en', r.translation);
    // stay a little so re-reads would show up as duplicates
    await sleep(1500);
  }
  const readingEnd = await page.evaluate(() => performance.now());

  // history
  const hist = await page.evaluate(async () => {
    const h = await import('/src/core/history.js');
    return h.list().map((c) => ({ id: c.id, text: c.dialog ? c.dialog.text : (c.others || []).map((o) => o.text).join(' | ') }));
  });
  const texts = hist.map((h) => h.text);
  const dupes = texts.filter((t, i) => texts.findIndex((x) => x === t) !== i);
  const distinctExpected = new Set(expected.filter((e, i) => i === expected.length - 1 || !norm(expected[i + 1]).startsWith(norm(e))).map(norm));
  check('history: zero duplicate entries', dupes.length === 0, { entries: texts.length, dupes });
  check(`history: one entry per transcript (${distinctExpected.size})`, texts.length === distinctExpected.size, texts);
  const recentRows = await page.$$eval('.recent-item', (els) => els.length);
  check('recent lines list matches history', recentRows === Math.min(texts.length, 20), recentRows);

  // long tasks while reading vs a control window with auto-translate off
  // (first prove the observer sees a deliberate 150 ms task)
  await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 150) { /* busy */ } });
  await sleep(200);
  check('long-task observer works', await page.evaluate(() => window.__longTasks.some((t) => t.ms >= 140)));
  const lt = await page.evaluate(([a, b]) => window.__longTasks.filter((t) => t.start >= a && t.start <= b && t.ms > 100), [readingStart, readingEnd]);
  const span = readingEnd - readingStart;
  await page.evaluate(async () => { const { store } = await import('/src/core/store.js'); store.set('ocrPaused', true); });
  await page.focus('#game');
  const c0 = await page.evaluate(() => performance.now());
  for (let k = 0; k < 4; k++) { await pressA(page); await sleep(Math.min(span / 4, 6000)); }
  const c1 = await page.evaluate(() => performance.now());
  const ltControl = await page.evaluate(([a, b]) => window.__longTasks.filter((t) => t.start >= a && t.start <= b && t.ms > 100), [c0, c1]);
  const rate = (n, ms) => Math.round((n / (ms / 60000)) * 10) / 10;
  const readRate = rate(lt.length, span);
  const ctrlRate = rate(ltControl.length, c1 - c0);
  check('no main-thread long tasks > 100 ms from OCR (reading vs control, per minute)', readRate <= ctrlRate + 2,
    { reading: { count: lt.length, perMin: readRate, worst: Math.max(0, ...lt.map((t) => t.ms)) }, control: { count: ltControl.length, perMin: ctrlRate } });
  await page.evaluate(async () => { const { store } = await import('/src/core/store.js'); store.set('ocrPaused', false); });

  const chipStates = await page.evaluate(() => window.__chipStates);
  const allowed = new Set(['off', 'setup', 'watching', 'reading', 'translating', 'paused']);
  check('status chip: only expected states, never an error', chipStates.every((s) => allowed.has(s)) && chipStates.includes('watching'), chipStates.slice(0, 40));

  // keyboard: Esc leaves the game for Translate now
  await page.focus('#game');
  await page.keyboard.press('Escape');
  check('Esc in the game moves focus to Translate now', await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'translate-now'));
  // Tab from the game reaches the toolbar
  await page.focus('#game');
  await page.keyboard.press('Tab');
  check('Tab from the game reaches Translate now', await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'translate-now'));
  // Translate now from the keyboard (T in the game keeps the game focused)
  await page.focus('#game');
  await page.keyboard.press('t');
  await sleep(1500);
  check('T in the game translates without leaving the game', await page.evaluate(() => document.activeElement && document.activeElement.id === 'game'));

  // word buttons are reachable with Tab, then arrows; Enter opens the popover
  await page.focus('[data-action="translate-now"]');
  let onWord = false;
  for (let k = 0; k < 40 && !onWord; k++) {
    await page.keyboard.press('Tab');
    onWord = await page.evaluate(() => !!(document.activeElement && document.activeElement.classList.contains('word')));
  }
  check('word buttons reachable with Tab', onWord);
  if (onWord) {
    const first = await page.evaluate(() => document.activeElement.textContent);
    await page.keyboard.press('ArrowRight');
    const second = await page.evaluate(() => document.activeElement.textContent);
    check('arrow keys move between words', first !== second, { first, second });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.wordpop:not([hidden])', { timeout: 5000 });
    const pop = await page.evaluate(() => ({
      focusInside: document.querySelector('.wordpop').contains(document.activeElement),
      expanded: document.querySelector('.word[aria-expanded="true"]') !== null,
      term: document.querySelector('.wordpop__term').textContent,
      lang: document.querySelector('.wordpop__term').getAttribute('lang')
    }));
    check('popover opens with focus inside, word marked expanded', pop.focusInside && pop.expanded && pop.lang === 'de', pop);
    await page.waitForFunction(() => document.querySelector('.wordpop__trans') || document.querySelector('.wordpop__error'), null, { timeout: 15000 }).catch(() => {});
    if (AXE) await axeScan(page, 'running, word popover open');
    await page.keyboard.press('Escape');
    const closed = await page.evaluate((w) => ({
      hidden: document.querySelector('.wordpop').hidden,
      backOnWord: document.activeElement.classList.contains('word') && document.activeElement.textContent === w
    }), second);
    check('Escape closes the popover and returns focus to the word', closed.hidden && closed.backOnWord, closed);
  }
  if (AXE) await axeScan(page, 'running');

  await page.screenshot({ path: path.join(SHOTS, 'flow-desktop-running.png') });

  // toolbar: quick save / load give feedback, pause toggles, pointer clicks hand the keys back to the game
  const toastText = () => page.evaluate(() => Array.from(document.querySelectorAll('.toast:not([data-leaving]) .toast__message')).map((t) => t.textContent.trim()).join(' | '));
  await page.click('.tb[data-action="quick-save"]');
  await page.waitForFunction(() => /Game saved at/.test(document.querySelector('#toast-region')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('Quick save confirms with the time', /Game saved at/.test(await toastText()), await toastText());
  check('pointer click returns focus to the game', await page.evaluate(() => document.activeElement && document.activeElement.id === 'game'));
  await page.click('.tb[data-action="quick-load"]');
  await page.waitForFunction(() => /Loaded your quick save/.test(document.querySelector('#toast-region')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('Quick load confirms', /Loaded your quick save/.test(await toastText()), await toastText());
  await page.click('.tb[data-action="pause"]');
  const paused = await page.evaluate(() => ({ label: document.querySelector('.tb[data-action="pause"] .tb__label').textContent, chip: document.querySelector('.live .status-chip').dataset.state }));
  await sleep(400);
  const chipPaused = await page.evaluate(() => document.querySelector('.live .status-chip').dataset.state);
  check('Pause: button becomes Resume and live translation pauses', paused.label === 'Resume' && chipPaused === 'paused', { ...paused, chipPaused });
  await page.click('.tb[data-action="pause"]');
  await sleep(400);
  check('Resume: watching again', await page.evaluate(() => document.querySelector('.tb[data-action="pause"] .tb__label').textContent === 'Pause'));

  // text area editor: keyboard alternative, save, persisted per ROM
  await page.focus('.tb[data-action="zone"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-zone-rect]', { timeout: 3000 });
  const zoneOpen = await page.evaluate(() => ({
    focus: document.activeElement && document.activeElement.hasAttribute('data-zone-rect'),
    expanded: document.querySelector('.tb[data-action="zone"]').getAttribute('aria-expanded'),
    chip: document.querySelector('.live .status-chip').dataset.state
  }));
  check('Text area: editor opens, focus on the area, live translation paused', zoneOpen.focus && zoneOpen.expanded === 'true' && zoneOpen.chip === 'paused', zoneOpen);
  await sleep(400); // let the editor's entrance animation finish
  if (AXE) await axeScan(page, 'text area editor open');
  await page.screenshot({ path: path.join(SHOTS, 'flow-desktop-zone.png') });
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
  await sleep(300);
  const zoneSaved = await page.evaluate(async () => {
    const idb = await import('/src/core/idb.js');
    const keys = await idb.idbKeys('zone:');
    return { keys, z: keys.length ? await idb.idbGet(keys[0]) : null, label: document.querySelector('.tb[data-action="zone"] .tb__label').textContent, focus: document.activeElement && document.activeElement.dataset.action };
  });
  check('Text area: saved per game, toolbar shows a custom area, focus back on the button', zoneSaved.keys.length === 1 && zoneSaved.z && Math.abs(zoneSaved.z.y - 0.63) < 0.001 && /custom/.test(zoneSaved.label) && zoneSaved.focus === 'zone', zoneSaved);
  // the live text keeps coming with a custom area
  await pressA(page);
  const zoneRead = await waitForDialog(page, expectedTranscripts()[4], PAGE_TIMEOUT).catch(() => ({ ok: false }));
  check('Text area: text inside the area is still read', zoneRead.ok, zoneRead.ok ? undefined : zoneRead);
  await page.click('.tb[data-action="zone"]');
  await page.click('[data-action="zone-auto"]');
  await sleep(300);
  check('Text area: "Use automatic detection" clears it', (await page.evaluate(async () => (await (await import('/src/core/idb.js')).idbKeys('zone:')).length)) === 0);

  // eject (More menu) saves and reloads; playing again offers to resume
  await page.click('#play-more');
  await page.click('[role="menuitem"][data-action="eject"]');
  await page.waitForSelector('.rom-card', { timeout: 30000 });
  check('Eject returns to the library', await page.isVisible('.rom-card'));
  await page.click('.rom-card [data-action="play"]');
  await page.waitForSelector('.stage[data-state="running"]', { timeout: 60000 });
  const resume = await page.waitForSelector('[data-resume]:not([hidden])', { timeout: 15000 }).then(() => true, () => false);
  check('“Resume where you left off?” after playing again', resume);
  if (resume) {
    if (AXE) await axeScan(page, 'resume prompt');
    await page.screenshot({ path: path.join(SHOTS, 'flow-desktop-resume.png') });
    await page.focus('#game');
    await page.keyboard.press('Tab');
    check('Tab from the game reaches Resume first', await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'resume-yes'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Back where you left off/.test(document.querySelector('#toast-region')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check('Resume restores the autosave', /Back where you left off/.test(await toastText()), await toastText());
  }
  check('flow: no page errors', errors.length === 0, errors.slice(0, 10));
  check('flow: no error toast', !(await page.$('.toast--error')));
  await context.close();
  return pageResults;
}

// ---- loading, error and reflow ---------------------------------------------------------------------

async function states(browser, router, base, romPath) {
  const settings = { source: 'de', target: 'en', onboarded: true };

  // loading: hold the core download for a moment
  let context = await newContext(browser, router, { viewport: { width: 1440, height: 900 }, settings });
  await context.route(/cdn\.emulatorjs\.org\/.*\/cores\//, async (route) => { await sleep(4000); route.fallback(); });
  let page = await context.newPage();
  await openPlay(page, base);
  await page.setInputFiles('[data-rom-input]', romPath);
  await page.waitForSelector('.stage[data-state="loading"]', { timeout: 10000 });
  await sleep(1500);
  const loading = await page.evaluate(() => ({
    title: document.querySelector('.stage__title')?.textContent,
    progress: !!document.querySelector('.stage__overlay progress'),
    toolbarDisabled: !!document.querySelector('.tb[data-action="translate-now"][aria-disabled="true"]'),
    h1: document.activeElement && document.activeElement.tagName
  }));
  check('loading: stage shows progress, toolbar disabled, focus on the heading', /Starting/.test(loading.title || '') && loading.progress && loading.toolbarDisabled && loading.h1 === 'H1', loading);
  await page.screenshot({ path: path.join(SHOTS, 'state-desktop-loading.png') });
  if (AXE) await axeScan(page, 'loading');
  await page.waitForSelector('.stage[data-state="running"]', { timeout: 60000 });
  await context.close();

  // error: the emulator can't be downloaded
  context = await newContext(browser, router, { viewport: { width: 1440, height: 900 }, settings });
  await context.route(/cdn\.emulatorjs\.org\//, (route) => route.fulfill({ status: 404, body: '' }));
  page = await context.newPage();
  const errors = watchErrors(page, 'error-state');
  const isExpected404 = (e) => /Failed to load resource.*404/.test(e);
  await openPlay(page, base);
  await page.setInputFiles('[data-rom-input]', romPath);
  await page.waitForSelector('.stage[data-state="error"]', { timeout: 90000 });
  const err = await page.evaluate(() => ({
    title: document.querySelector('.stage__title')?.textContent,
    text: document.querySelector('.stage__panel--error .stage__text')?.textContent,
    focus: document.activeElement && document.activeElement.dataset.action,
    choose: !!document.querySelector('[data-action="stage-choose"]')
  }));
  check('error: explains the problem, offers Try again and Choose another game', err.title === 'Couldn’t start the game' && !!err.text && err.choose && err.focus === 'stage-retry', err);
  await page.screenshot({ path: path.join(SHOTS, 'state-desktop-error.png') });
  if (AXE) await axeScan(page, 'error');
  const unexpected = errors.filter((e) => !isExpected404(e));
  check('error: no page errors (besides the blocked downloads)', unexpected.length === 0, unexpected.slice(0, 5));
  await context.close();

  // reflow: 320 px wide and a 200 % zoomed laptop (640×400)
  for (const vp of [{ width: 320, height: 640 }, { width: 640, height: 400 }]) {
    context = await newContext(browser, router, { viewport: vp, settings });
    page = await context.newPage();
    await openPlay(page, base);
    await loadRom(page, romPath);
    await sleep(1000);
    const m = await page.evaluate(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect();
      const live = document.querySelector('.live').getBoundingClientRect();
      return {
        noHScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        stageH: Math.round(stage.height),
        stageW: Math.round(stage.width),
        pageScrolls: document.documentElement.scrollHeight > innerHeight,
        liveReachable: live.height > 0
      };
    });
    check(`reflow ${vp.width}×${vp.height}: no sideways scroll, game visible, page scrolls to the translation`, m.noHScroll && m.stageH >= 140 && m.liveReachable, m);
    await page.screenshot({ path: path.join(SHOTS, `state-reflow-${vp.width}x${vp.height}.png`), fullPage: true });
    await context.close();
  }
}

// ---- screenshots ----------------------------------------------------------------------------------

async function shots(browser, router, base, romPath) {
  const variants = [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true, userAgent: PHONE_UA }
  ];
  for (const v of variants) {
    for (const scheme of ['dark', 'light']) {
      const label = `${v.name}-${scheme}`;
      // onboarding (fresh profile)
      let context = await newContext(browser, router, { ...v, colorScheme: scheme });
      let page = await context.newPage();
      const errors = watchErrors(page, label);
      await openPlay(page, base);
      await page.screenshot({ path: path.join(SHOTS, `${label}-onboarding.png`), fullPage: true });
      const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      check(`${label}: no horizontal scrolling (onboarding)`, noScroll);
      await context.close();

      // library + running, set up already
      context = await newContext(browser, router, { ...v, colorScheme: scheme, settings: { source: 'de', target: 'en', onboarded: true } });
      page = await context.newPage();
      watchErrors(page, label, errors);
      await openPlay(page, base);
      await page.screenshot({ path: path.join(SHOTS, `${label}-library-empty.png`), fullPage: true });
      await loadRom(page, romPath);
      const r = await waitForDialog(page, 'Hello there! Welcome to the', FIRST_TIMEOUT);
      if (!r.ok) console.log(`INFO ${label}: first line not read in time (${JSON.stringify(r)})`);
      await sleep(500);
      await page.screenshot({ path: path.join(SHOTS, `${label}-running.png`) });
      await page.screenshot({ path: path.join(SHOTS, `${label}-running-full.png`), fullPage: true });
      const fits = await page.evaluate(() => {
        const stage = document.querySelector('.stage').getBoundingClientRect();
        const tb = document.querySelector('.play-toolbar').getBoundingClientRect();
        return { stageBottom: Math.round(stage.bottom), toolbarBottom: Math.round(tb.bottom), vh: innerHeight, stageW: Math.round(stage.width), stageH: Math.round(stage.height) };
      });
      if (v.name === 'desktop') check(`${label}: game and toolbar fit in the viewport`, fits.toolbarBottom <= fits.vh, fits);
      check(`${label}: no horizontal scrolling (running)`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      check(`${label}: no error toast while playing`, !(await page.$('.toast--error')));
      // the library after a reload, with the ROM in it
      await page.reload();
      await page.waitForSelector('.rom-card', { timeout: 20000 });
      await page.screenshot({ path: path.join(SHOTS, `${label}-library.png`), fullPage: true });
      if (AXE && scheme === 'light' && v.name === 'desktop') await axeScan(page, 'library with a game (light)');
      check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 6));
      await context.close();
    }
  }
}

// ---- phones ------------------------------------------------------------------------------

// The phone-layout acceptance sizes, [width, height, picture width, picture height]
// (Game Boy unless noted; ±3 px).
const PHONE_PORTRAIT = [[430, 932, 398, 358], [412, 915, 380, 342], [390, 844, 358, 322], [412, 780, 377, 339], [360, 740, 328, 295],
  [375, 667, 327, 294], [390, 664, 324, 291], [360, 640, 297, 267], [320, 568, 288, 259], [375, 553, 296, 266]];
const PHONE_LANDSCAPE = [[932, 430, 420, 378], [915, 412, 400, 360], [915, 356, 338, 304], [844, 390, 376, 338], [740, 360, 342, 308],
  [667, 375, 359, 323], [640, 360, 340, 306], [568, 320, 268, 241]];
const PHONE_GBA = [[390, 844, 358, 239], [915, 412, 540, 360], [667, 375, 367, 245], [568, 320, 268, 179]];

// Everything the layout checks need, in viewport px: the picture found by
// scanning the canvas for drawn (non-transparent) pixels, the pad's keys,
// the caption, the toolbar's visible buttons and the fold.
function measurePhone() {
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const q = (s) => document.querySelector(s);
  const vw = innerWidth;
  const vh = innerHeight;
  const c = q('#game canvas');
  let picture = null;
  if (c && c.width > 2) {
    const cr = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = c.width;
    t.height = c.height;
    const ctx = t.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, t.width, t.height).data;
    let l = t.width, r = -1, top = t.height, b = -1;
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) {
        if (d[(y * t.width + x) * 4 + 3]) { if (x < l) l = x; if (x > r) r = x; if (y < top) top = y; if (y > b) b = y; }
      }
    }
    if (r >= 0) {
      const sx = cr.width / t.width;
      const sy = cr.height / t.height;
      picture = { x: Math.round(cr.x + l * sx), y: Math.round(cr.y + top * sy), w: Math.round((r - l + 1) * sx), h: Math.round((b - top + 1) * sy) };
    }
  }
  const shown = (e) => { const b = e.getBoundingClientRect(); if (!b.width || !b.height) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
  const pad = q('#game .ejs_virtualGamepad_parent');
  const padOn = !!pad && pad.style.display !== 'none' && getComputedStyle(pad).display !== 'none';
  const name = (e) => (e.classList.contains('ejs_dpad_main') ? 'D-pad' : (e.textContent || '').trim());
  const keys = padOn ? [...pad.querySelectorAll('.ejs_virtualGamepad_button, .ejs_dpad_main')].filter(shown).map((e) => ({ n: name(e), ...R(e) })) : [];
  const area = (a, b) => (a && b ? Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) : 0);
  const gap = (a, b) => Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w), Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  const cap = q('.caption');
  const caption = cap && shown(cap) ? R(cap) : null;
  const captionText = caption ? R(q('.caption__text')) : null;
  const tools = [...document.querySelectorAll('.play-toolbar .tb, .play-toolbar [data-menu-trigger]')].filter(shown).map((e) => ({ n: e.dataset.action || e.id, ...R(e) }));
  const nav = q('.app-nav');
  const navH = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().height : 0;
  const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
  const insets = { top: px('--safe-top'), right: px('--safe-right'), bottom: px('--safe-bottom'), left: px('--safe-left') };
  const outside = (r) => r.x < insets.left - 1 || r.y < insets.top - 1 || r.x + r.w > vw - insets.right + 1 || r.y + r.h > vh - insets.bottom + 1;
  const pairs = [];
  keys.forEach((a, i) => keys.slice(i + 1).forEach((b) => { if (area(a, b)) pairs.push(`${a.n}+${b.n}`); }));
  const lr = keys.filter((k) => k.n === 'L' || k.n === 'R');
  const core = keys.filter((k) => ['D-pad', 'A', 'B'].includes(k.n));
  const stage = R(q('.stage'));
  const text = q('[data-caption-text]');
  return {
    mode: document.documentElement.dataset.handheld || null,
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vw, vh, fold: vh - navH - insets.bottom, insets,
    stage, game: R(q('section.game')), canvas: c ? R(c) : null, backing: c ? [c.width, c.height] : null, picture,
    caption, captionText, captionState: cap && cap.dataset.state, captionLang: text && text.getAttribute('lang'),
    captionString: text ? text.textContent.replace(/\s+/g, ' ').trim() : '',
    toolbar: R(q('.play-toolbar')), tools: tools.map((t) => t.n), toolRects: tools,
    keys: keys.map((k) => k.n),
    keysOverPicture: keys.filter((k) => area(k, picture)).map((k) => k.n),
    keysOverCaption: keys.filter((k) => area(k, caption)).map((k) => k.n),
    keysOverTools: keys.filter((k) => tools.some((t) => area(k, t))).map((k) => k.n),
    keyPairs: pairs,
    keysOutside: keys.filter(outside).map((k) => k.n),
    toolsOutside: tools.filter(outside).map((t) => t.n),
    toolsOverCaptionText: tools.filter((t) => area(t, captionText)).map((t) => t.n),
    captionOverPicture: area(caption, picture),
    toolGap: tools.length && keys.length ? Math.min(...tools.flatMap((t) => keys.map((k) => gap(t, k)))) : null,
    lrGap: lr.length && core.length ? Math.min(...lr.flatMap((a) => core.map((b) => gap(a, b)))) : null,
    lr: lr.length,
    shoulders: !!q('.stage.stage--shoulders'),
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : null
  };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sameRect = (a, b, tol = 1) => (!a && !b) || (!!a && !!b && near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.w, b.w, tol) && near(a.h, b.h, tol));
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function phoneSize(page, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await frames(page);
  await sleep(700);
}

// A phone moves between two sizes of one orientation only through a
// rotation (the layout puts the game in view on rotation, not on resizes).
async function rotateTo(page, w, h) {
  const cur = page.viewportSize();
  if ((cur.width > cur.height) === (w > h) && w > h) await phoneSize(page, 412, 915);
  await phoneSize(page, w, h);
}

// The translation on show in the card (the caption shows the same line)
const panelTranslation = (page) => page.evaluate(() => {
  const t = document.querySelector('.live .part--dialog .part__trans');
  return t && !t.matches('.part__trans--pending, .part__trans--error') ? (t.childNodes[0] ? t.childNodes[0].textContent : t.textContent).replace(/\s+/g, ' ').trim() : '';
});

async function captionMatchesPanel(page, timeout = 10000) {
  const end = Date.now() + timeout;
  let last = {};
  while (Date.now() < end) {
    const m = await page.evaluate(measurePhone);
    const p = await panelTranslation(page);
    last = { caption: m.captionString, panel: p, lang: m.captionLang };
    if (p && norm(p) === norm(m.captionString) && m.captionLang === 'en') return { ok: true, ...last };
    await sleep(250);
  }
  return { ok: false, ...last };
}

// The checks every phone size gets; returns the measurements.
async function checkPhoneSize(page, [w, h, pw, ph], { label = '', captionText = true } = {}) {
  const tag = `phone ${label}${w}×${h}`;
  const m = await page.evaluate(measurePhone);
  const landscape = w > h;
  check(`${tag}: layout ${landscape ? 'landscape' : 'portrait'}, no sideways scroll`, m.mode === (landscape ? 'landscape' : 'portrait') && !m.hScroll, { mode: m.mode, hScroll: m.hScroll });
  check(`${tag}: no pad key over the picture, the caption, the toolbar or another key; all on screen`,
    m.keys.length >= 5 && !m.keysOverPicture.length && !m.keysOverCaption.length && !m.keysOverTools.length && !m.keyPairs.length && !m.keysOutside.length,
    { keys: m.keys.length, overPicture: m.keysOverPicture, overCaption: m.keysOverCaption, overTools: m.keysOverTools, pairs: m.keyPairs, outside: m.keysOutside });
  const c = m.caption;
  const p = m.picture;
  check(`${tag}: caption under the picture, on screen, above the fold`,
    !!c && !!p && c.x >= 0 && c.y >= 0 && c.x + c.w <= w && c.y + c.h <= h && c.y >= p.y + p.h - 1 && m.captionOverPicture === 0 && c.y + c.h <= m.fold,
    { caption: c, picture: p, fold: m.fold });
  check(`${tag}: the canvas is the picture (no letterbox for the OCR)`, !!p && sameRect(m.canvas, p, 2), { canvas: m.canvas, picture: p, backing: m.backing });
  check(`${tag}: picture ${pw}×${ph}`, !!p && near(p.w, pw, 3) && near(p.h, ph, 3), p);
  if (captionText) {
    const t = await captionMatchesPanel(page);
    check(`${tag}: caption shows the card's translation (lang=en)`, t.ok, t);
  }
  if (landscape) {
    const row = m.stage && c ? { top: m.stage.y + m.stage.h - c.h, bottom: m.stage.y + m.stage.h } : null;
    check(`${tag}: four toolbar buttons in the caption row's corners, clear of the text and ≥ 8 px from the pad`,
      m.tools.join(',') === 'translate-now,pause,auto-translate,play-more' && !!row && m.toolRects.every((t) => t.y >= row.top - 1 && t.y + t.h <= row.bottom + 1) &&
      !m.toolsOverCaptionText.length && m.toolGap >= 8 && !m.toolsOutside.length,
      { tools: m.tools, row, overText: m.toolsOverCaptionText, gap: m.toolGap, outside: m.toolsOutside });
    check(`${tag}: the game fills the screen (stage top 0)`, !!m.stage && near(m.stage.y, m.insets.top, 1) && !!m.game && near(m.game.h, h, 1), { stage: m.stage, game: m.game });
  }
  return m;
}

// A touch on an element where it is (page.tap() first scrolls it "into
// view", which moves the full-screen game a few px). Held for `ms`: a 0 ms
// tap can fall between two of the emulator's frames, and the game polls
// its pad once per frame.
async function holdTouch(page, selector, ms = 150) {
  const r = await page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, selector);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await sleep(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const touch = (page, selector) => holdTouch(page, selector, 40);

// The translation service through the test proxy can drop a request
// (CORS-less 429, tunnel errors): the app retries, it is not an app error.
// Only errors that name a translation endpoint count as such.
const NETWORK_FLAKE = /translate\.googleapis\.com|clients5\.google\.com|api\.mymemory\.translated\.net/;
function appErrors(errors) {
  const dropped = errors.filter((e) => NETWORK_FLAKE.test(e));
  if (dropped.length) console.log(`INFO ${dropped.length} translation request(s) failed in the network (not counted as app errors)`);
  return errors.filter((e) => !NETWORK_FLAKE.test(e));
}

// The colour on screen at (x, y) in CSS px (decoded from a screenshot).
async function screenPixel(page, x, y) {
  const buf = await page.screenshot();
  return page.evaluate(async ({ b64, x, y }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const k = img.width / innerWidth;
    return [...ctx.getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data.slice(0, 3)];
  }, { b64: buf.toString('base64'), x, y });
}
const isFocusBlue = ([r, g, b]) => Math.abs(r - 147) < 24 && Math.abs(g - 197) < 24 && Math.abs(b - 253) < 24; // #93c5fd
const stageTop = (page) => page.evaluate(() => Math.round(document.querySelector('.stage').getBoundingClientRect().top));
const focusId = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.dataset.action || a.className) : null; });

const fps = (page, ms) => page.evaluate(async (dur) => {
  const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
  if (!gm) return null;
  const f0 = gm.getFrameNum();
  const a = performance.now();
  await new Promise((r) => setTimeout(r, dur));
  return Math.round((((gm.getFrameNum() - f0) * 1000) / (performance.now() - a)) * 10) / 10;
}, ms);

async function phone(browser, router, base, romPath, gbaPath) {
  const settings = { source: 'de', target: 'en', onboarded: true };
  let context = await newContext(browser, router, { viewport: { width: 412, height: 915 }, mobile: true, userAgent: PHONE_UA, settings });
  let page = await context.newPage();
  const errors = watchErrors(page, 'phone');
  await openPlay(page, base);
  await loadRom(page, romPath);
  const first = await waitForDialog(page, 'Hello there! Welcome to the', FIRST_TIMEOUT);
  check('phone: the game runs and its first line is translated', first.ok, first.ok ? undefined : first);
  await page.waitForFunction(() => document.documentElement.dataset.handheld === 'portrait', null, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.activeElement && document.activeElement.blur());

  // every size, upright then sideways
  const seen = {};
  for (const size of [...PHONE_PORTRAIT, ...PHONE_LANDSCAPE]) {
    await rotateTo(page, size[0], size[1]);
    seen[`${size[0]}x${size[1]}`] = await checkPhoneSize(page, size);
    await page.screenshot({ path: path.join(SHOTS, `phone-${size[0]}x${size[1]}.png`) });
  }

  // sideways with page zoom (Chrome's Accessibility zoom: 915×412 at 200 %
  // and 844×390 at 200 %): too small for the bars, today's layout reflows
  for (const [w, h] of [[457, 206], [422, 195]]) {
    await rotateTo(page, w, h);
    const z = await page.evaluate(() => ({ mode: document.documentElement.dataset.handheld || null, sw: document.documentElement.scrollWidth, vw: innerWidth }));
    check(`phone ${w}×${h} (zoomed): regular layout, no sideways scroll`, !z.mode && z.sw <= z.vw, z);
  }

  // More upright on a short phone: on screen above the tab bar, scrolling if it must
  await rotateTo(page, 320, 568);
  await page.evaluate(() => document.querySelector('.play-toolbar').scrollIntoView({ block: 'end', behavior: 'instant' }));
  await sleep(200);
  await touch(page, '#play-more');
  await sleep(300);
  const pmenu = await page.evaluate(() => {
    const list = document.getElementById('play-more-menu');
    const r = list.getBoundingClientRect();
    const nav = document.querySelector('.app-nav');
    const fold = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight;
    return { open: !list.hidden, rect: [Math.round(r.top), Math.round(r.bottom)], fold: Math.round(fold), scrolls: list.scrollHeight > list.clientHeight + 1 };
  });
  check('phone 320×568: More opens on screen above the tab bar (scrolling within it)', pmenu.open && pmenu.rect[0] >= 0 && pmenu.rect[1] <= pmenu.fold, pmenu);
  await page.keyboard.press('Escape');
  await sleep(200);

  // rotation round trips mid-game: each return looks exactly as before
  const keyRects = (m) => ({ picture: m.picture, caption: m.caption, toolbar: m.toolbar, stage: m.stage });
  for (const [w, h] of [[412, 915], [915, 412], [412, 915], [844, 390], [390, 844]]) {
    await phoneSize(page, w, h);
    const m = await page.evaluate(measurePhone);
    const before = seen[`${w}x${h}`];
    if (before) {
      const a = keyRects(before);
      const b = keyRects(m);
      check(`phone rotation: back at ${w}×${h} as before`, Object.keys(a).every((k) => sameRect(a[k], b[k], 1)) && m.mode === before.mode, { before: a, after: b });
    }
  }

  // sideways: the moved A key plays the game, and the caption follows
  await rotateTo(page, 915, 412);
  const before = await page.evaluate(measurePhone);
  await holdTouch(page, '#game .ejs_virtualGamepad_button.b_a');
  const next = await waitForDialog(page, expectedTranscripts()[1], PAGE_TIMEOUT);
  const capNext = await captionMatchesPanel(page);
  check('phone landscape: a touch on the moved A key turns the page', next.ok, next.ok ? undefined : next);
  check('phone landscape: the caption follows the new line', capNext.ok && capNext.caption !== before.captionString, { before: before.captionString, ...capNext });

  // the caption's button opens the card; G goes back to the game
  await touch(page, '.caption__open');
  await sleep(500);
  const opened = await page.evaluate(() => ({
    liveTop: Math.round(document.querySelector('.live').getBoundingClientRect().top),
    focus: !!(document.activeElement && (document.activeElement.matches('.live .capture') || document.activeElement.id === 'play-live-title'))
  }));
  check('phone landscape: the caption’s button shows Live translation, focused', opened.liveTop >= 0 && opened.liveTop <= 8 && opened.focus, opened);
  await page.keyboard.press('g');
  await sleep(400);
  const back = await page.evaluate(() => ({ stageTop: Math.round(document.querySelector('.stage').getBoundingClientRect().top), focus: document.activeElement && document.activeElement.id }));
  check('phone landscape: G brings the game back (stage top 0, focus on the game)', back.stageTop === 0 && back.focus === 'game', back);
  // the ring around the focused game shows (over the game's own layers), on the screen's edge
  const ring = await screenPixel(page, 1, 206);
  check('phone landscape: the focused game has a visible ring', isFocusBlue(ring), { pixel: ring });
  // Tab leaves for the caption's button (then the toolbar), Shift+Tab comes back: the game stays put
  await page.keyboard.press('Tab');
  await sleep(300);
  const tab1 = { focus: await focusId(page), stageTop: await stageTop(page) };
  await page.keyboard.press('Tab');
  await sleep(300);
  const tab2 = { focus: await focusId(page), stageTop: await stageTop(page) };
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await sleep(300);
  const tab3 = { focus: await focusId(page), stageTop: await stageTop(page) };
  check('phone landscape: Tab from the game reaches the caption’s button, then Translate now; Shift+Tab returns; the game never moves',
    tab1.focus === 'caption__open' && tab2.focus === 'translate-now' && tab3.focus === 'game' && [tab1, tab2, tab3].every((t) => t.stageTop === 0), { tab1, tab2, tab3 });

  // More opens upwards, all on screen, with the controls moved into it
  await touch(page, '#play-more');
  await sleep(300);
  const menu = await page.evaluate(() => {
    const list = document.getElementById('play-more-menu');
    const r = list.getBoundingClientRect();
    const items = [...list.querySelectorAll('[role="menuitem"]')].filter((i) => !i.hidden).map((i) => i.textContent.trim());
    return { open: !list.hidden, inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], items };
  });
  const wanted = ['Fullscreen', 'Text area', 'Quick save', 'Quick load', 'Mute'];
  check('phone landscape: More opens on screen with Fullscreen, Text area, saves and Mute', menu.open && menu.inView && wanted.every((x) => menu.items.some((i) => i.startsWith(x))), menu);
  await page.screenshot({ path: path.join(SHOTS, 'phone-915x412-more.png') });
  if (AXE) {
    await page.evaluate(AXE);
    await settleAnimations(page);
    const v = await page.evaluate(async () => {
      const r = await window.axe.run({ include: [['section.game']], exclude: [['#game']] }, { resultTypes: ['violations'] });
      return r.violations.map((x) => ({ id: x.id, nodes: x.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
    });
    check('axe: phone 915×412 with More open, game section', v.length === 0, v.length ? v : undefined);
  }
  await page.keyboard.press('Escape');
  await sleep(200);
  check('phone landscape: Escape closes More, focus back on it, the game stays put', await page.evaluate(() => document.getElementById('play-more-menu').hidden && document.activeElement && document.activeElement.id === 'play-more') && (await stageTop(page)) === 0, { stageTop: await stageTop(page) });

  // a toast (Quick save) sits over the top of the picture, clear of the toolbar and the pad
  await touch(page, '#play-more');
  await sleep(200);
  await touch(page, '#play-more-quick-save');
  await page.waitForSelector('.toast', { timeout: 10000 }).catch(() => {});
  await sleep(300);
  const toastAt = await page.evaluate(() => {
    const t = document.querySelector('.toast');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    const hit = (el) => { const b = el.getBoundingClientRect(); return Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left)) * Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top)) > 0; };
    const covered = [...document.querySelectorAll('.play-toolbar .tb, #play-more, #game .ejs_virtualGamepad_button, #game .ejs_dpad_main')].filter((e) => e.offsetParent !== null && hit(e)).map((e) => e.dataset.action || e.id || e.textContent.trim());
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], covered, stageTop: Math.round(document.querySelector('.stage').getBoundingClientRect().top) };
  });
  check('phone landscape: a toast covers no toolbar button or pad key, and the game stays put', !!toastAt && !toastAt.covered.length && toastAt.stageTop === 0, toastAt);
  await page.evaluate(() => { for (const b of document.querySelectorAll('.toast [data-action="dismiss"], .toast button')) b.click(); });

  // the text-area editor uses the regular layout, and the game comes back after
  await touch(page, '#play-more');
  await sleep(200);
  await touch(page, '#play-more-zone');
  await sleep(600);
  const zone = await page.evaluate(() => {
    const p = document.getElementById('play-zone-editor');
    const r = p.getBoundingClientRect();
    return { mode: document.documentElement.dataset.handheld || null, shown: !p.hidden, inView: r.top < innerHeight && r.bottom > 0 };
  });
  check('phone landscape: Text area opens the editor in the regular layout', !zone.mode && zone.shown && zone.inView, zone);
  await page.screenshot({ path: path.join(SHOTS, 'phone-915x412-zone.png') });
  await page.tap('[data-action="zone-cancel"]');
  await sleep(600);
  const zoneBack = await page.evaluate(() => ({ mode: document.documentElement.dataset.handheld, stageTop: Math.round(document.querySelector('.stage').getBoundingClientRect().top), focus: document.activeElement && document.activeElement.id }));
  check('phone landscape: Cancel brings the game screen back, focus on More', zoneBack.mode === 'landscape' && zoneBack.stageTop === 0 && zoneBack.focus === 'play-more', zoneBack);

  // fullscreen, sideways and upright (and a near-square foldable's inner screen)
  for (const [w, h] of [[915, 412], [412, 915], [701, 841]]) {
    await rotateTo(page, w, h);
    if (!(await page.evaluate(() => document.fullscreenEnabled))) { console.log(`INFO phone ${w}×${h}: fullscreen not available here, skipped`); continue; }
    // (in More, unless the toolbar has room for the button)
    if (await page.evaluate(() => document.getElementById('play-more-fullscreen').hidden)) {
      await touch(page, '.tb[data-action="fullscreen"]');
    } else {
      await touch(page, '#play-more');
      await sleep(200);
      await touch(page, '#play-more-fullscreen');
    }
    await sleep(900);
    const fs1 = await page.evaluate(() => !!document.fullscreenElement);
    if (!fs1) { console.log(`INFO phone ${w}×${h}: the browser refused fullscreen, skipped`); continue; }
    await frames(page);
    const m = await page.evaluate(measurePhone);
    const inFs = await page.evaluate(() => document.fullscreenElement.contains(document.querySelector('.caption')));
    check(`phone ${w}×${h} fullscreen: caption on screen inside the fullscreen stage, no key over the picture or caption`,
      inFs && !!m.caption && m.caption.y >= 0 && m.caption.y + m.caption.h <= m.vh && !m.keysOverPicture.length && !m.keysOverCaption.length,
      { inFs, caption: m.caption, picture: m.picture, overPicture: m.keysOverPicture, overCaption: m.keysOverCaption });
    const fsTools = m.toolRects.filter((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= m.vw && t.y + t.h <= m.vh).map((t) => t.n);
    check(`phone ${w}×${h} fullscreen: the toolbar comes along (Translate now, Pause, Auto-translate, More on screen)`,
      ['translate-now', 'pause', 'auto-translate', 'play-more'].every((n) => fsTools.includes(n)) && !m.keysOverTools.length, { tools: fsTools, overTools: m.keysOverTools });
    await page.screenshot({ path: path.join(SHOTS, `phone-${w}x${h}-fullscreen.png`) });
    await touch(page, '.caption__open');
    await sleep(900);
    const out = await page.evaluate(() => ({ fs: !!document.fullscreenElement, focus: !!(document.activeElement && document.activeElement.closest('.live')) }));
    check(`phone ${w}×${h} fullscreen: the caption's button leaves fullscreen for Live translation`, !out.fs && out.focus, out);
    await page.keyboard.press('g');
    await sleep(300);
  }

  // safe areas (notches, home indicator): every key and button inside them
  const insetCases = [
    { size: [844, 390], css: '--safe-left:47px;--safe-right:47px;--safe-bottom:21px', pic: [352, 317] },
    { size: [932, 430], css: '--safe-left:59px;--safe-right:59px;--safe-bottom:21px', pic: [397, 357] },
    { size: [390, 844], css: '--safe-top:47px;--safe-bottom:34px', pic: [336, 302], toolbarBottom: 762 }
  ];
  for (const ic of insetCases) {
    const [w, h] = ic.size;
    await rotateTo(page, w, h);
    await page.evaluate((css) => {
      const st = document.createElement('style');
      st.id = 'e2e-insets';
      st.textContent = `html:root { ${css} }`;
      document.head.appendChild(st);
    }, ic.css);
    await frames(page);
    await sleep(700);
    await page.evaluate(() => { if (document.documentElement.dataset.handheld === 'landscape') document.querySelector('section.game').scrollIntoView({ block: 'start' }); });
    await sleep(300);
    const m = await page.evaluate(measurePhone);
    const p = m.picture;
    check(`phone ${w}×${h} with insets (${ic.css}): picture ${ic.pic.join('×')}, keys and buttons inside the safe area`,
      !!p && near(p.w, ic.pic[0], 3) && near(p.h, ic.pic[1], 3) && !m.keysOutside.length && !m.toolsOutside.length && !m.keysOverPicture.length && !m.keysOverCaption.length &&
      (!ic.toolbarBottom || m.toolbar.y + m.toolbar.h <= ic.toolbarBottom),
      { picture: p, insets: m.insets, keysOutside: m.keysOutside, toolsOutside: m.toolsOutside, toolbar: m.toolbar });
    await page.screenshot({ path: path.join(SHOTS, `phone-${w}x${h}-insets.png`) });
    await page.evaluate(() => document.getElementById('e2e-insets').remove());
  }

  // axe on the game section (EmulatorJS's own markup aside), both themes
  if (AXE) {
    await page.evaluate(AXE);
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [w, h] of [[390, 844], [915, 412]]) {
        await rotateTo(page, w, h);
        await sleep(400);
        await settleAnimations(page);
        const v = await page.evaluate(async () => {
          const r = await window.axe.run({ include: [['section.game']], exclude: [['#game']] }, { resultTypes: ['violations'] });
          return r.violations.map((x) => ({ id: x.id, nodes: x.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
        });
        check(`axe: phone ${w}×${h} ${scheme}, game section`, v.length === 0, v.length ? v : undefined);
        await page.screenshot({ path: path.join(SHOTS, `phone-${w}x${h}-${scheme}.png`) });
      }
    }
    await page.emulateMedia({ colorScheme: 'dark' });
  }

  // frames per second at 4× CPU throttling (report only)
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const setAuto = (on) => page.evaluate(async (v) => { const { store } = await import('/src/core/store.js'); store.set('ocrPaused', !v); }, on);
  for (const [w, h] of [[412, 915], [915, 412]]) {
    await rotateTo(page, w, h);
    await setAuto(true);
    await sleep(1500);
    const on = await fps(page, 10000);
    await setAuto(false);
    await sleep(1500);
    const off = await fps(page, 10000);
    await setAuto(true);
    console.log(`INFO phone ${w}×${h} at 4× CPU: ${on} fps with live translation, ${off} fps without`);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();

  // "Resume where you left off?" floats over the picture, sideways
  await rotateTo(page, 915, 412);
  await touch(page, '#play-more');
  await sleep(200);
  await touch(page, '[role="menuitem"][data-action="eject"]');
  await page.waitForSelector('.rom-card', { timeout: 30000 });
  await page.tap('.rom-card [data-action="play"]');
  await page.waitForSelector('.stage[data-state="running"]', { timeout: 60000 });
  const resumeShown = await page.waitForSelector('[data-resume]:not([hidden])', { timeout: 15000 }).then(() => true, () => false);
  await page.waitForFunction(() => document.documentElement.dataset.handheld === 'landscape', null, { timeout: 10000 }).catch(() => {});
  await sleep(800);
  if (check('phone landscape: “Resume where you left off?” after playing again', resumeShown)) {
    const r = await page.evaluate(() => {
      const box = document.querySelector('[data-resume]').getBoundingClientRect();
      const c = document.querySelector('.ejs_canvas_parent').getBoundingClientRect();
      const btn = document.querySelector('[data-action="resume-yes"]').getBoundingClientRect();
      const hit = document.elementFromPoint(btn.x + btn.width / 2, btn.y + btn.height / 2);
      return { box: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)], picture: [Math.round(c.left), Math.round(c.right)], vh: innerHeight, hit: !!(hit && hit.closest('[data-action="resume-yes"]')) };
    });
    check('phone landscape: the resume question floats over the picture, on screen, and takes taps', r.box[1] >= 0 && r.box[3] <= r.vh && r.box[0] >= r.picture[0] - 1 && r.box[2] <= r.picture[1] + 1 && r.hit, r);
    await page.screenshot({ path: path.join(SHOTS, 'phone-915x412-resume.png') });
    // upright it floats over the top of the picture too, its buttons above the tab bar
    for (const [w, h] of [[375, 667], [320, 568], [412, 915]]) {
      await rotateTo(page, w, h);
      const u = await page.evaluate(() => {
        const nav = document.querySelector('.app-nav');
        const fold = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight;
        const pic = document.querySelector('.ejs_canvas_parent').getBoundingClientRect();
        const tb = document.querySelector('.play-toolbar').getBoundingClientRect();
        const btns = [...document.querySelectorAll('[data-resume] button')].map((b) => {
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), hit: !!(hit && b.contains(hit)) };
        });
        return { fold: Math.round(fold), btns, picture: [Math.round(pic.top), Math.round(pic.bottom)], toolbarBottom: Math.round(tb.bottom) };
      });
      check(`phone ${w}×${h}: the resume question floats over the picture, its buttons on screen above the tab bar and taking taps`,
        u.btns.length === 2 && u.btns.every((b) => b.top >= 0 && b.bottom <= u.fold && b.hit) && u.btns.every((b) => b.top >= u.picture[0] && b.bottom <= u.picture[1]), u);
      await page.screenshot({ path: path.join(SHOTS, `phone-${w}x${h}-resume.png`) });
    }
    await rotateTo(page, 915, 412);
    await touch(page, '[data-action="resume-no"]');
    await sleep(300);
    check('phone landscape: Start fresh answers it', await page.isHidden('[data-resume]'));
  }
  const phoneErrors = appErrors(errors);
  check('phone: no page errors', phoneErrors.length === 0, phoneErrors.slice(0, 8));
  await context.close();

  // a GBA game: L and R get their own place
  context = await newContext(browser, router, { viewport: { width: 390, height: 844 }, mobile: true, userAgent: PHONE_UA, settings });
  page = await context.newPage();
  const gbaErrors = watchErrors(page, 'phone-gba');
  await openPlay(page, base);
  await loadRom(page, gbaPath);
  await page.waitForFunction(() => document.documentElement.dataset.handheld === 'portrait', null, { timeout: 15000 }).catch(() => {});
  await sleep(1000);
  for (const size of PHONE_GBA) {
    await rotateTo(page, size[0], size[1]);
    const m = await checkPhoneSize(page, size, { label: 'GBA ', captionText: false });
    check(`phone GBA ${size[0]}×${size[1]}: L and R shown, ≥ 8 px from the D-pad and A/B`, m.shoulders && m.lr === 2 && m.lrGap >= 8, { shoulders: m.shoulders, lr: m.lr, gap: m.lrGap });
    await page.screenshot({ path: path.join(SHOTS, `phone-gba-${size[0]}x${size[1]}.png`) });
  }
  check('phone GBA: no page errors', appErrors(gbaErrors).length === 0, appErrors(gbaErrors).slice(0, 6));
  await context.close();

  // desktops (no pad) and tablets keep today's layout; tablets upright get the caption
  context = await newContext(browser, router, { viewport: { width: 1440, height: 900 }, settings });
  page = await context.newPage();
  await openPlay(page, base);
  await loadRom(page, romPath);
  await sleep(1500);
  for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768]]) {
    await phoneSize(page, w, h);
    const d = await page.evaluate(() => {
      const tb = document.querySelector('.play-toolbar').getBoundingClientRect();
      const shown = [...document.querySelectorAll('.play-toolbar .tb, #play-more')].filter((b) => !b.hidden && b.offsetParent !== null).length;
      return { mode: document.documentElement.dataset.handheld || null, caption: getComputedStyle(document.querySelector('.caption')).display, toolbarBottom: Math.round(tb.bottom), vh: innerHeight, shown, zoneItemHidden: document.getElementById('play-more-zone').hidden };
    });
    check(`desktop ${w}×${h}: regular layout, no caption, game and toolbar fit`, !d.mode && d.caption === 'none' && d.toolbarBottom <= d.vh && (w !== 1440 || (d.shown === 9 && d.zoneItemHidden)), d);
  }
  await context.close();
  for (const [w, h] of [[1024, 768], [768, 1024]]) {
    context = await newContext(browser, router, { viewport: { width: w, height: h }, mobile: true, userAgent: TABLET_UA, dpr: 1, settings });
    page = await context.newPage();
    await openPlay(page, base);
    await loadRom(page, romPath);
    await sleep(2500);
    const t = await page.evaluate(() => {
      const c = document.querySelector('.caption');
      return { mode: document.documentElement.dataset.handheld || null, docked: document.querySelector('.stage').classList.contains('stage--dock'), caption: getComputedStyle(c).display, captionTop: Math.round(c.getBoundingClientRect().top) };
    });
    if (w > h) check(`tablet ${w}×${h} (touch): regular layout, no caption`, !t.mode && t.caption === 'none', t);
    else check(`tablet ${w}×${h} (touch): upright layout, caption by y=720`, t.mode === 'portrait' && t.caption !== 'none' && t.captionTop <= 720, t);
    await page.screenshot({ path: path.join(SHOTS, `tablet-${w}x${h}.png`) });
    await context.close();
  }
}

// ---- main -------------------------------------------------------------------------------------------

async function main() {
  await setupEmulatorJs();
  const romDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritespeak-play-rom-'));
  const { romPath } = writeAll(romDir);
  const gbaPath = writeGbaRom(path.join(romDir, 'spritespeak-layout-test.gba'));
  const { server, base } = await startVite();
  log('vite', base);
  const router = createCdnRouter({ repoRoot: ROOT, viteOrigin: base.replace(/\/$/, ''), emulatorjsDataDir: EJS_DIR });
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  const browser = await chromium.launch({ headless: !HEADED, proxy });
  try {
    if (ONLY.has('flow')) await flow(browser, router, base, romPath);
    if (ONLY.has('states')) await states(browser, router, base, romPath);
    if (ONLY.has('shots')) await shots(browser, router, base, romPath);
    if (ONLY.has('phone')) await phone(browser, router, base, romPath, gbaPath);
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(romDir, { recursive: true, force: true });
  }
  if (router.stats.missing.length) console.log('INFO CDN requests without a local copy:', [...new Set(router.stats.missing)].slice(0, 10));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
