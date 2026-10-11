#!/usr/bin/env node
// End-to-end checks for the Play view with the REAL emulator (EmulatorJS
// 4.2.3, gambatte core served from bench/.cache/emulatorjs) and the
// homebrew test ROM from bench/e2e/make-gb-rom.mjs (8 pages of dialog: 2
// English, 6 German), in headless Chromium against the live working tree.
//
//   node tests/e2e-play/play.e2e.mjs [--only flow,states,shots] [--shots DIR] [--port N] [--headed]
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const ONLY = new Set(String(arg('--only', 'flow,states,shots')).split(','));
const SHOTS = arg('--shots', path.join(os.tmpdir(), 'emulingo-e2e-play'));
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

async function axeScan(page, label) {
  if (!AXE) return;
  await page.evaluate(AXE);
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

async function newContext(browser, router, { viewport, colorScheme = 'dark', mobile = false, settings } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme,
    serviceWorkers: 'block',
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile
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
    errors.push(`${label} console.error: ${t}`);
  });
  return errors;
}

async function openPlay(page, base) {
  await page.goto(`${base}#/play`);
  await page.waitForSelector('section[data-view="play"]:not([hidden]) h1', { timeout: 30000 });
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
    { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true }
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

// ---- main -------------------------------------------------------------------------------------------

async function main() {
  await setupEmulatorJs();
  const romDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emulingo-play-rom-'));
  const { romPath } = writeAll(romDir);
  const { server, base } = await startVite();
  log('vite', base);
  const router = createCdnRouter({ repoRoot: ROOT, viteOrigin: base.replace(/\/$/, ''), emulatorjsDataDir: EJS_DIR });
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  const browser = await chromium.launch({ headless: !HEADED, proxy });
  try {
    if (ONLY.has('flow')) await flow(browser, router, base, romPath);
    if (ONLY.has('states')) await states(browser, router, base, romPath);
    if (ONLY.has('shots')) await shots(browser, router, base, romPath);
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
