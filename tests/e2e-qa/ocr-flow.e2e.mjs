#!/usr/bin/env node
// OCR + translation end to end in the REAL app with the REAL emulator
// (EmulatorJS 4.2.3 + gambatte from bench/.cache/emulatorjs) and the
// homebrew Pokémon-style test ROM (bench/e2e/make-gb-rom.mjs), in headless
// Chromium against the live working tree. Measures what a player gets:
//
//   main      onboarding (German → English) through the UI, ROM via the
//             "Choose ROM file" button, every page with A ('z'): the dialog
//             text (continued sentences stitched), a translation, latency
//             from the key press to the translation (minus typing time),
//             long tasks while reading, status chip states, then 60 s idle
//             on the last page: zero duplicate history entries, no re-reads
//             from the blinking arrow, one card per completed sentence,
//             dictionary entries.
//   hud       the -hud ROM: the static "ROUTE 1" sign shows under "Also on
//             screen" and never causes dialog duplicates.
//   mismatch  English pages with the game language set to German: the
//             language banner appears and "Switch" works.
//   tesseract Settings ocrEngine 'tesseract': the first pages via the
//             Tesseract fallback (accuracy reported).
//   phone     390×844 at DPR 3 (touch): every page read and translated.
//
//   node tests/e2e-qa/ocr-flow.e2e.mjs [--only main,hud,mismatch,tesseract,phone]
//        [--port N] [--idle 60] [--json out.json] [--headed]
//
// Translation uses the real Google endpoint through $HTTPS_PROXY. A request
// to a translation service that the network drops (Chromium logs it as a CORS
// or net:: console error) is counted as a network drop, not a page error: the
// app retries on its own, and each page must still end with a translation.
// Starts
// Vite (no HMR, no watching) on the first free port from 5482. Prints
// PASS/FAIL lines and a measurement summary; exits 1 on failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createCdnRouter } from '../../bench/lib/routes.mjs';
import { setup as setupEmulatorJs, EJS_DIR } from '../../bench/e2e/setup.mjs';
import { writeAll, PAGES, HUD_TEXT } from '../../bench/e2e/make-gb-rom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const ONLY = new Set(String(arg('--only', 'main,hud,mismatch,tesseract,phone')).split(','));
const PORTS = arg('--port') ? [Number(arg('--port'))] : [5482, 5483, 5484, 5485, 5486, 5487];
const IDLE_S = Number(arg('--idle', 60));
const JSON_OUT = arg('--json', null);
const HEADED = argv.includes('--headed');
const FIRST_TIMEOUT = 150000;
const PAGE_TIMEOUT = 45000;
// gambatte runs the ROM at ~59.73 fps; one character every 2 frames
const FRAME_MS = 1000 / 59.7275;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const measures = {};
function check(name, ok, info) {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ` :: ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
  return !!ok;
}

// ---- expected text ----------------------------------------------------------------

const TERMINAL = /[.!?…]["'”’)]*$/u;
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
// typing time of a page (two lines; the line break costs one step)
const typingMs = (i) => (PAGES[i][0].length + PAGES[i][1].length + 1) * 2 * FRAME_MS;

function cer(want, got) {
  const a = [...String(want)], b = [...String(got)];
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return a.length ? d[a.length][b.length] / a.length : (b.length ? 1 : 0);
}
const pctl = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};

// ---- server -----------------------------------------------------------------------

async function startVite() {
  const { createServer } = await import('vite');
  for (const port of PORTS) {
    try {
      const server = await createServer({
        root: ROOT,
        configFile: path.join(ROOT, 'vite.config.js'),
        cacheDir: path.join(os.tmpdir(), `emulingo-qa-vite-${port}`),
        logLevel: 'warn',
        clearScreen: false,
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

// ---- page helpers -----------------------------------------------------------------

async function newContext(browser, router, { viewport = { width: 1440, height: 900 }, dpr = 1, mobile = false, settings } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark', serviceWorkers: 'block', deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
  await router.install(context);
  if (settings) {
    await context.addInitScript((s) => {
      try { if (!localStorage.getItem('emulingo:settings')) localStorage.setItem('emulingo:settings', JSON.stringify(s)); } catch { /* ignore */ }
    }, { settingsVersion: 2, ...settings });
  }
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

const TRANSLATION_HOSTS = /^https:\/\/(translate\.googleapis\.com|clients5\.google\.com|api\.mymemory\.translated\.net)\//;
const networkDrops = [];

// Chromium's own console line for a translation request the network dropped:
// "Access to fetch at '<url>' … blocked by CORS policy" (an error response
// without CORS headers), or "Failed to load resource: …" (net:: error or HTTP
// status) whose location is that URL. App code logging has no such location.
function isTranslationDrop(m) {
  const t = m.text();
  const at = /^Access to fetch at '([^']+)'/.exec(t);
  if (at) return TRANSLATION_HOSTS.test(at[1]);
  return /^Failed to load resource: /.test(t) && TRANSLATION_HOSTS.test(m.location()?.url || '');
}

function watchErrors(page, label, errors = []) {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (TRANSLATION_HOSTS.test(r.url())) networkDrops.push(`${label}: ${r.failure()?.errorText} ${r.url().slice(0, 120)}`);
  });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && isTranslationDrop(m)) return;
    if (m.type() === 'error' && !/Removing initializer|Wake Lock|wakeLock|favicon/i.test(t)) errors.push(`${label} console.error: ${t}`);
    // a failed translation the scanner retries by itself; recovery is checked per page
    if (m.type() === 'warning' && /^\[scanner\] translation failed TranslateError/.test(t)) return;
    if (m.type() === 'warning' && /\[scanner\]|\[play\]/.test(t)) errors.push(`${label} warn: ${t}`);
  });
  return errors;
}

// Records every change of the live card (dialog text, translation, "Also on
// screen" items, chip state) with performance.now() timestamps.
async function installRecorder(page) {
  await page.evaluate(() => {
    const ev = window.__qa = [];
    let last = '';
    const read = () => {
      const orig = document.querySelector('.live .part--dialog .part__orig');
      const trans = document.querySelector('.live .part--dialog .part__trans');
      const chip = document.querySelector('.live .status-chip');
      const text = orig ? orig.textContent.replace(/\s+/g, ' ').trim() : '';
      const tr = trans && !trans.matches('.part__trans--pending, .part__trans--error, .part__trans--updating') ? trans.textContent.replace(/\s+/g, ' ').trim() : '';
      const also = [...document.querySelectorAll('.live .capture__also .part--other .part__orig')].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
      const state = chip ? chip.dataset.state : '';
      const lang = orig ? orig.getAttribute('lang') : null;
      const key = JSON.stringify([text, tr, also, state]);
      if (key !== last) {
        last = key;
        ev.push({ t: performance.now(), text, tr, also, state, lang });
      }
    };
    const live = document.querySelector('[data-live]');
    new MutationObserver(read).observe(live, { subtree: true, childList: true, characterData: true, attributes: true });
    setInterval(read, 100);
    read();
  });
  // When the game finished typing each page: our own frame source and box
  // tracker (the app's modules) note every change of the dialog box's masked
  // hash; the last change before the text shows is the last typed glyph.
  // This keeps latency honest when a loaded machine slows the emulator.
  await page.evaluate(async () => {
    const emu = await import('/src/core/emulator.js');
    const { createFrameSource } = await import('/src/core/ocr/capture.js');
    const { createContainerTracker } = await import('/src/core/ocr/containers.js');
    const src = createFrameSource({ getCanvas: emu.getCanvas, getVideoDims: emu.getVideoDims });
    const tracker = createContainerTracker({});
    const changes = window.__boxChanges = [];
    const dbg = window.__debugLog = [];
    let last = null;
    let lastDbg = '';
    setInterval(() => {
      const d = document.querySelector('[data-debug]')?.textContent || '';
      if (d !== lastDbg) { lastDbg = d; dbg.push([performance.now(), d]); }
      const f = src.grab();
      if (!f) return;
      const box = tracker.update(f).find((c) => c.kind === 'dialog');
      if (box && box.hash !== last) { last = box.hash; changes.push(f.t); }
    }, 100);
  });
}

const liveText = (page) => page.evaluate(() => ({ text: document.querySelector('.live .part--dialog .part__orig')?.textContent.replace(/\s+/g, ' ').trim() || '' }));

const typedAt = (page, before) => page.evaluate((b) => {
  const xs = window.__boxChanges.filter((t) => t <= b);
  return xs.length ? xs[xs.length - 1] : null;
}, before);

const events = (page, since = 0) => page.evaluate((s) => window.__qa.filter((e) => e.t >= s), since);
const debugStats = (page) => page.evaluate(() => {
  const t = document.querySelector('[data-debug]')?.textContent || '';
  const m = /OCR reads (\d+) · cache hits (\d+)(?: · screen reads (\d+))?/.exec(t);
  return m ? { reads: Number(m[1]), hits: Number(m[2]), screen: Number(m[3] || 0), raw: t } : { reads: null, hits: null, screen: null, raw: t };
});

async function pressA(page) {
  await page.focus('#game');
  const t = await page.evaluate(() => performance.now());
  await page.keyboard.down('z');
  await sleep(150);
  await page.keyboard.up('z');
  return t;
}

// waits until the dialog shows `expected` with a final translation; returns
// the first time each happened (from the recorder)
async function waitForPage(page, expected, since, timeout) {
  const want = norm(expected);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await page.evaluate(() => document.querySelector('[data-action="show-queued"]')?.click());
    const ev = await events(page, since);
    const shown = ev.find((e) => norm(e.text) === want);
    const done = ev.find((e) => norm(e.text) === want && e.tr);
    if (done) return { ok: true, shownAt: shown.t, doneAt: done.t, text: done.text, tr: done.tr, lang: done.lang, also: done.also };
    await sleep(200);
  }
  const ev = await events(page, since);
  const lastEv = ev[ev.length - 1] || {};
  return { ok: false, text: lastEv.text, tr: lastEv.tr, also: lastEv.also, seen: [...new Set(ev.map((e) => e.text))].slice(-6) };
}

async function startGame(page, base, romPath, { viaButton = false } = {}) {
  if (viaButton) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      page.click('section[data-view="play"] [data-action="choose-rom"]')
    ]);
    await chooser.setFiles(romPath);
  } else {
    await page.setInputFiles('section[data-view="play"] [data-rom-input]', romPath);
  }
  await page.waitForSelector('.stage[data-state="running"]', { timeout: 120000 });
  await installRecorder(page);
}

async function openPlay(page, base) {
  await page.goto(`${base}?debug=1#/play`);
  await page.waitForSelector('section[data-view="play"]:not([hidden]) h1', { timeout: 30000 });
  await page.waitForTimeout(300);
}

const historyList = (page) => page.evaluate(async () => {
  const h = await import('/src/core/history.js');
  return h.list().map((c) => ({ id: c.id, src: c.src, tgt: c.tgt, dialog: c.dialog ? c.dialog.text : null, translation: c.dialog ? c.dialog.translation : null, others: (c.others || []).map((o) => o.text) }));
});

// ---- scenarios --------------------------------------------------------------------

async function runPages(page, { pages, label, perPage = 1500 }) {
  const expected = expectedTranscripts();
  const out = [];
  await page.mouse.move(2, 2);
  for (const i of pages) {
    const since = i === pages[0] ? 0 : await page.evaluate(() => performance.now());
    const pressAt = i === pages[0] ? null : await pressA(page);
    const r = await waitForPage(page, expected[i], since, i === pages[0] ? FIRST_TIMEOUT : PAGE_TIMEOUT);
    const rec = { page: i, ...r };
    if (r.ok && pressAt != null) {
      const typed = await typedAt(page, r.shownAt);
      rec.textMs = Math.round(r.shownAt - pressAt);
      rec.translationMs = Math.round(r.doneAt - pressAt);
      rec.typingMs = typed != null && typed > pressAt ? Math.round(typed - pressAt) : Math.round(typingMs(i));
      rec.afterTypingMs = Math.round(r.doneAt - pressAt - rec.typingMs);
      // a slow page: keep what the live card went through, for diagnosis
      if (rec.afterTypingMs > 2500) {
        const all = await events(page);
        const before = all.filter((e) => e.t < pressAt).pop();
        const ev = [...(before ? [before] : []), ...all.filter((e) => e.t >= pressAt)];
        rec.timeline = ev.map((e) => [Math.round(e.t - pressAt), e.state, e.text.slice(-24), e.tr ? 'tr' : '']);
        rec.debug = (await debugStats(page)).raw;
        Object.assign(rec, await page.evaluate((t) => ({
          boxChanges: window.__boxChanges.filter((x) => x >= t).map((x) => Math.round(x - t)),
          debugLog: window.__debugLog.filter(([x]) => x >= t - 1000).map(([x, d]) => [Math.round(x - t), d])
        }), pressAt));
      }
    }
    out.push(rec);
    check(`${label} page ${i}: dialog shows “${expected[i]}”`, r.ok && r.lang === 'de', r.ok ? (rec.afterTypingMs != null ? `${rec.translationMs} ms (typed in ${rec.typingMs} ms, nominal ${Math.round(typingMs(i))} → translation +${rec.afterTypingMs} ms)` : undefined) : r);
    await sleep(perPage);
  }
  return out;
}

async function main(browser, router, base, romPath) {
  const context = await newContext(browser, router);
  const page = await context.newPage();
  const errors = watchErrors(page, 'main');
  await openPlay(page, base);

  // onboarding through the UI: game in German, translate into English
  await page.click('.onboarding [data-quick="de"]');
  await page.selectOption('.onboarding select[id$="-target"]', 'en');
  await page.click('.onboarding button[type="submit"]');
  await page.waitForSelector('.onboarding', { state: 'detached', timeout: 5000 });
  // (settings are stored as overrides: a default target is not written)
  const settings = await page.evaluate(async () => {
    const { store } = await import('/src/core/store.js');
    return { source: store.get('source'), target: store.get('target'), onboarded: store.get('onboarded') };
  });
  check('main: onboarding saved German → English', settings.source === 'de' && settings.target === 'en' && settings.onboarded, settings);

  await startGame(page, base, romPath, { viaButton: true });
  log('main: game running');
  const readStart = await page.evaluate(() => performance.now());
  const pages = await runPages(page, { pages: PAGES.map((_, i) => i), label: 'main' });
  const readEnd = await page.evaluate(() => performance.now());
  for (const p of pages) if (p.ok) check(`main page ${p.page}: translation shown`, !!p.tr, p.tr);

  const lat = pages.filter((p) => p.afterTypingMs != null);
  measures.main = {
    latencyAfterTypingMs: { p50: pctl(lat.map((p) => p.afterTypingMs), 50), p90: pctl(lat.map((p) => p.afterTypingMs), 90), all: lat.map((p) => p.afterTypingMs) },
    pressToTextMs: lat.map((p) => p.textMs),
    typedMs: lat.map((p) => p.typingMs),
    pressToTranslationMs: lat.map((p) => p.translationMs),
    slow: lat.filter((p) => p.timeline).map((p) => ({ page: p.page, timeline: p.timeline, debug: p.debug, boxChanges: p.boxChanges, debugLog: p.debugLog }))
  };
  check('main: translation p90 < 2.5 s after typing ends', measures.main.latencyAfterTypingMs.p90 != null && measures.main.latencyAfterTypingMs.p90 < 2500, measures.main.latencyAfterTypingMs);

  // idle on the last page: no re-reads (blinking arrow), no new entries
  const before = await debugStats(page);
  const histBefore = await historyList(page);
  const evIdle0 = await page.evaluate(() => performance.now());
  log(`main: idling ${IDLE_S} s on the last page`);
  await sleep(IDLE_S * 1000);
  const evIdle1 = await page.evaluate(() => performance.now());

  // long tasks while reading, against the idle minute (same game, no reads):
  // the emulator itself causes some on a loaded machine
  const tasks = (a, b) => page.evaluate(([x, y]) => window.__longTasks.filter((t) => t.start >= x && t.start <= y && t.ms > 100), [a, b]);
  const lt = await tasks(readStart, readEnd);
  const ltIdle = await tasks(evIdle0, evIdle1);
  const perMin = (n, ms) => Math.round((n / (ms / 60000)) * 10) / 10;
  measures.main.longTasks = {
    reading: { count: lt.length, perMin: perMin(lt.length, readEnd - readStart), worst: Math.max(0, ...lt.map((t) => t.ms)) },
    idle: { count: ltIdle.length, perMin: perMin(ltIdle.length, evIdle1 - evIdle0), worst: Math.max(0, ...ltIdle.map((t) => t.ms)) }
  };
  check('main: no long tasks > 100 ms from OCR (reading vs idle, per minute)', measures.main.longTasks.reading.perMin <= measures.main.longTasks.idle.perMin + 2, measures.main.longTasks);
  const after = await debugStats(page);
  const hist = await historyList(page);
  const idleEvents = (await events(page, evIdle0)).filter((e) => e.text);
  measures.main.idle = { readsBefore: before.reads, readsAfter: after.reads, hitsBefore: before.hits, hitsAfter: after.hits, screenBefore: before.screen, screenAfter: after.screen, liveChanges: idleEvents.length };
  // (the rest of the screen around a dialog box is read once it has been
  // still 8 s, scanner.js PAGED_QUIET_MS: one whole-screen read, not a re-read)
  check('main: no OCR re-reads during idle (blinking arrow masked)', before.reads != null && after.reads - after.screen === before.reads - before.screen && after.screen - before.screen <= 1, measures.main.idle);
  check('main: history unchanged during idle', hist.length === histBefore.length, { before: histBefore.length, after: hist.length });

  const texts = hist.map((h) => h.dialog || h.others.join(' | '));
  const dupes = texts.filter((t, i) => texts.indexOf(t) !== i);
  const expected = expectedTranscripts();
  const distinct = expected.filter((e, i) => i === expected.length - 1 || !norm(expected[i + 1]).startsWith(norm(e)));
  check('main: zero duplicate history entries', dupes.length === 0, { dupes });
  check(`main: one history entry per transcript (${distinct.length})`, texts.length === distinct.length, texts);

  // cards and dictionary
  const learn = await page.evaluate(async () => {
    const srs = await import('/src/core/srs.js');
    const dict = await import('/src/core/dictionary.js');
    return {
      cards: srs.cards().map((c) => ({ text: c.text, translation: c.translation, origin: c.origin })),
      dict: dict.entries().map((e) => ({ text: e.text, kind: e.kind }))
    };
  });
  measures.main.cards = learn.cards.map((c) => `${c.text} → ${c.translation}`);
  measures.main.dictionary = { total: learn.dict.length, lines: learn.dict.filter((e) => e.kind === 'line').length, words: learn.dict.filter((e) => e.kind === 'word').length };
  const sentences = ['Hallo!', 'Willkommen in der Welt der POKéMON!', 'Ich bin Professor EICH.', 'Möchtest du gegen mich kämpfen?', 'Die Straße führt nach Süden.', 'Übung macht den Meister!', 'Ärgere dich nicht!', 'Öffne das Menü.'];
  const cardNorm = learn.cards.map((c) => norm(c.text));
  const notSentence = learn.cards.filter((c) => !/[.!?…]$/u.test(c.text.trim()));
  check('main: auto-add makes one card per completed sentence (no page fragments)', notSentence.length === 0 && new Set(cardNorm).size === cardNorm.length, { cards: learn.cards.map((c) => c.text) });
  const missing = sentences.filter((s) => !cardNorm.includes(norm(s)));
  check('main: every German sentence became a card', missing.length === 0, { missing });
  check('main: dictionary has line and word entries', measures.main.dictionary.lines > 0 && measures.main.dictionary.words > 0, measures.main.dictionary);

  // "Translate now" (T in the game): time until the button is idle again
  // with the line on show. Each press starts with the scanner idle: a press
  // waits for a read already in flight (one engine job at a time), and the
  // rest of the screen, read after the previous press, takes seconds on a
  // loaded machine.
  const tnow = [];
  const idle = () => page.waitForFunction(() => document.querySelector('.live .status-chip')?.dataset.state !== 'reading', null, { timeout: 30000 }).catch(() => {});
  for (let k = 0; k < 3; k++) {
    await idle();
    await page.focus('#game');
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.press('t');
    await page.waitForFunction(() => document.querySelector('[data-action="translate-now"]')?.getAttribute('aria-busy') === 'true', null, { timeout: 3000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('[data-action="translate-now"]')?.getAttribute('aria-busy') !== 'true', null, { timeout: 30000 });
    tnow.push(Math.round((await page.evaluate(() => performance.now())) - t0));
    await sleep(1000);
  }
  const shownAfter = (await liveText(page)).text;
  measures.main.translateNowMs = tnow;
  check('main: Translate now answers within 2.5 s and keeps the line', Math.max(...tnow) < 2500 && norm(shownAfter) === norm(expected[expected.length - 1]), { ms: tnow, shown: shownAfter });
  const hist2 = await historyList(page);
  check('main: Translate now adds no history entries', hist2.length === hist.length, { before: hist.length, after: hist2.length });

  const chips = [...new Set((await events(page)).map((e) => e.state))];
  check('main: status chip only shows sensible states', chips.every((s) => ['watching', 'reading', 'translating', 'setup', 'paused', 'off'].includes(s)), chips);
  check('main: no page errors or scanner warnings', errors.length === 0, errors.slice(0, 8));
  await context.close();
}

async function hud(browser, router, base, hudRomPath) {
  const context = await newContext(browser, router, { settings: { source: 'de', target: 'en', onboarded: true } });
  const page = await context.newPage();
  const errors = watchErrors(page, 'hud');
  await openPlay(page, base);
  await startGame(page, base, hudRomPath);
  const pages = await runPages(page, { pages: [0, 1, 2, 3, 4], label: 'hud', perPage: 2500 });
  const withSign = pages.filter((p) => p.ok && (p.also || []).some((a) => norm(a) === norm(HUD_TEXT)));
  check('hud: the sign shows under “Also on screen”', withSign.length > 0, pages.map((p) => p.also));
  await sleep(10000);
  const hist = await historyList(page);
  const texts = hist.map((h) => h.dialog || h.others.join(' | '));
  const dupes = texts.filter((t, i) => texts.indexOf(t) !== i);
  check('hud: no duplicate history entries', dupes.length === 0, texts);
  check('hud: the sign never becomes its own line', !hist.some((h) => !h.dialog && h.others.some((o) => norm(o) === norm(HUD_TEXT))), texts);
  check('hud: sign never read as dialog', !hist.some((h) => h.dialog && norm(h.dialog).includes(norm(HUD_TEXT))), texts);
  measures.hud = { history: texts, also: pages.map((p) => p.also) };
  check('hud: no page errors', errors.length === 0, errors.slice(0, 6));
  await context.close();
}

async function mismatch(browser, router, base, romPath) {
  const context = await newContext(browser, router, { settings: { source: 'de', target: 'en', onboarded: true } });
  const page = await context.newPage();
  const errors = watchErrors(page, 'mismatch');
  await openPlay(page, base);
  await startGame(page, base, romPath);
  // pages 0 and 1 are English
  const shown0 = await page.waitForFunction(() => /Hello there/.test(document.querySelector('.live .part--dialog .part__orig')?.textContent || ''), null, { timeout: FIRST_TIMEOUT }).then(() => true, () => false);
  check('mismatch: English page read', shown0);
  await sleep(2500);
  await pressA(page);
  const banner = await page.waitForSelector('[data-action="hint-switch"]', { timeout: 20000 }).then(() => true, () => false);
  const bannerText = banner ? await page.$eval('[data-action="hint-switch"]', (b) => b.closest('.banner, [role], div')?.textContent.replace(/\s+/g, ' ').trim()) : null;
  check('mismatch: language banner appears for English text', banner, bannerText || await page.evaluate(() => document.querySelector('.live')?.textContent.replace(/\s+/g, ' ').slice(0, 300)));
  if (banner) {
    await page.click('[data-action="hint-switch"]');
    await sleep(500);
    const src = await page.evaluate(() => JSON.parse(localStorage.getItem('emulingo:settings') || '{}').source);
    check('mismatch: Switch sets the game language to English', src === 'en', src);
    const reread = await page.waitForFunction(() => {
      const o = document.querySelector('.live .part--dialog .part__orig');
      return o && o.getAttribute('lang') === 'en' && /POK/.test(o.textContent);
    }, null, { timeout: 30000 }).then(() => true, () => false);
    check('mismatch: the line is read again as English', reread);
    check('mismatch: banner gone after switching', !(await page.$('[data-action="hint-switch"]')));
  }
  check('mismatch: no page errors', errors.length === 0, errors.slice(0, 6));
  await context.close();
}

async function tesseract(browser, router, base, romPath) {
  const context = await newContext(browser, router, { settings: { source: 'de', target: 'en', onboarded: true, ocrEngine: 'tesseract' } });
  const page = await context.newPage();
  const errors = watchErrors(page, 'tesseract');
  await openPlay(page, base);
  await startGame(page, base, romPath);
  const expected = expectedTranscripts();
  const out = [];
  for (const i of [0, 1, 2]) {
    const since = i === 0 ? 0 : await page.evaluate(() => performance.now());
    const pressAt = i === 0 ? null : await pressA(page);
    // accept whatever settles: Tesseract may misread, so wait for a translation of a read
    // that is at least half the page long
    const end = Date.now() + (i === 0 ? FIRST_TIMEOUT : PAGE_TIMEOUT);
    let best = null;
    while (Date.now() < end) {
      const ev = await events(page, since);
      const done = ev.filter((e) => e.text && e.tr);
      best = done.find((e) => norm(e.text) === norm(expected[i])) || done[done.length - 1] || null;
      if (best && norm(best.text) === norm(expected[i])) break;
      if (best && Date.now() > end - (i === 0 ? FIRST_TIMEOUT : PAGE_TIMEOUT) + 12000 && cer(expected[i], best.text) < 0.5) break;
      await sleep(300);
    }
    const c = best ? cer(expected[i], best.text) : 1;
    out.push({ page: i, got: best && best.text, cer: +c.toFixed(3), ms: best && pressAt != null ? Math.round(best.t - pressAt) : null });
    check(`tesseract page ${i}: read via Tesseract (CER ${(c * 100).toFixed(1)}%)`, best && c < 0.25, { want: expected[i], got: best && best.text });
  }
  const engine = (await debugStats(page)).raw;
  check('tesseract: engine reported as Tesseract', /tesseract/i.test(engine), engine);
  measures.tesseract = { pages: out, debug: engine };
  check('tesseract: no page errors', errors.length === 0, errors.slice(0, 6));
  await context.close();
}

async function phone(browser, router, base, romPath) {
  const context = await newContext(browser, router, { viewport: { width: 390, height: 844 }, dpr: 3, mobile: true, settings: { source: 'de', target: 'en', onboarded: true } });
  const page = await context.newPage();
  const errors = watchErrors(page, 'phone');
  await openPlay(page, base);
  await startGame(page, base, romPath);
  const pages = await runPages(page, { pages: PAGES.map((_, i) => i), label: 'phone' });
  const lat = pages.filter((p) => p.afterTypingMs != null).map((p) => p.afterTypingMs);
  measures.phone = {
    latencyAfterTypingMs: { p50: pctl(lat, 50), p90: pctl(lat, 90), all: lat },
    pages: pages.map((p) => ({ page: p.page, typed: p.typingMs, text: p.textMs, translation: p.translationMs, timeline: p.timeline, boxChanges: p.boxChanges, debugLog: p.debugLog }))
  };
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('#game canvas');
    return c ? { w: c.width, h: c.height, cssW: Math.round(c.getBoundingClientRect().width), cssH: Math.round(c.getBoundingClientRect().height) } : null;
  });
  measures.phone.canvas = canvas;
  await sleep(5000);
  const hist = await historyList(page);
  const texts = hist.map((h) => h.dialog || h.others.join(' | '));
  const dupes = texts.filter((t, i) => texts.indexOf(t) !== i);
  check('phone: zero duplicate history entries', dupes.length === 0, texts);
  check('phone: no page errors', errors.length === 0, errors.slice(0, 6));
  await page.screenshot({ path: path.join(os.tmpdir(), 'emulingo-qa-phone.png') });
  await context.close();
}

// ---- main -------------------------------------------------------------------------

async function run() {
  await setupEmulatorJs();
  const romDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emulingo-qa-rom-'));
  const { romPath } = writeAll(romDir);
  const hudRomPath = writeAll(romDir, { hud: true }).romPath;
  const { server, base } = await startVite();
  log('vite', base);
  const router = createCdnRouter({ repoRoot: ROOT, viteOrigin: base.replace(/\/$/, ''), emulatorjsDataDir: EJS_DIR });
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  const browser = await chromium.launch({ headless: !HEADED, proxy });
  try {
    for (const [name, fn, rom] of [['main', main, romPath], ['hud', hud, hudRomPath], ['mismatch', mismatch, romPath], ['tesseract', tesseract, romPath], ['phone', phone, romPath]]) {
      if (!ONLY.has(name)) continue;
      log(`--- ${name}`);
      try {
        await fn(browser, router, base, rom);
      } catch (err) {
        check(`${name}: scenario ran to the end`, false, String(err && err.stack || err).slice(0, 600));
      }
    }
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(romDir, { recursive: true, force: true });
  }
  if (router.stats.missing.length) console.log('INFO CDN requests without a local copy:', [...new Set(router.stats.missing)].slice(0, 10));
  measures.networkDrops = networkDrops;
  if (networkDrops.length) console.log(`note: the network dropped ${networkDrops.length} translation request(s); the app recovered:\n  ${networkDrops.join('\n  ')}`);
  console.log('\nMEASUREMENTS', JSON.stringify(measures, null, 2));
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ results, measures }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
