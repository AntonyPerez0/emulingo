#!/usr/bin/env node
// End-to-end harness: real Emulingo app (Vite dev server) + real EmulatorJS
// (gambatte core, served locally) + homebrew test ROM in headless Chromium.
// Verifies the full loop  game -> snapshot -> OCR -> translate -> UI.
//
//   NODE_USE_ENV_PROXY=1 node bench/e2e/run-e2e.mjs [options]
//
// options:
//   --app=head|worktree  which app code to serve (default head: a `git archive
//                        HEAD` export in bench/.cache/app-head, immune to
//                        concurrent edits; worktree = the live working tree)
//   --engine=paddle|tesseract   settings.ocrEngine (default paddle = app default)
//   --pages=N            number of ROM pages to walk (default: all 8)
//   --dwell=SECONDS      minimum time each page stays on screen after it is
//                        fully typed (default 15) - long enough to observe
//                        re-processing / duplicate history entries
//   --timeout=SECONDS    per-page wait for a matching translation (default 60;
//                        page 0 gets +120 s for OCR model download/init)
//   --dpr=N              deviceScaleFactor (default 1)
//   --viewport=WxH       default 1280x800
//   --out=DIR            default bench/results/e2e/<app>-<engine>
//   --settings=JSON      extra settings merged into emulingo:settings
//   --headed             show the browser
//
// Requires: node bench/e2e/setup.mjs (run automatically) and the repo's
// devDependencies (vite, playwright 1.56.1). Translation requests go to the
// real Google endpoint through the sandbox proxy (HTTPS_PROXY).

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setup, EJS_DIR } from './setup.mjs';
import { writeAll, PAGES, PAGE_LANG, renderExpected as renderExpectedBase, LAYOUT, HUD_TEXT } from './make-gb-rom.mjs';
import { encodePng, indexToPng } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ------------------------------------------------------------------ args
const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const APP = argv.app || 'head';
const ENGINE = argv.engine || 'paddle';
const NPAGES = Math.min(PAGES.length, +(argv.pages || PAGES.length));
const DWELL = +(argv.dwell || 15) * 1000;
const TIMEOUT = +(argv.timeout || 60) * 1000;
const DPR = +(argv.dpr || 1);
const [VW, VH] = String(argv.viewport || '1280x800').split('x').map(Number);
const EXTRA_SETTINGS = argv.settings ? JSON.parse(argv.settings) : {};
const HUDROM = argv.rom === 'hud';
const renderExpected = (p, o = {}) => renderExpectedBase(p, { ...o, hud: HUDROM });
const OUT = path.resolve(argv.out || path.join(ROOT, 'bench', 'results', 'e2e', `${APP}-${ENGINE}${HUDROM ? '-hud' : ''}${DPR !== 1 ? '-dpr' + DPR : ''}`));

fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ deps
async function importPlaywright() {
  for (const p of [path.join(ROOT, 'node_modules', 'playwright', 'index.mjs'), '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    if (fs.existsSync(p)) return { mod: await import(pathToFileURL(p).href), from: p };
  }
  throw new Error('playwright not found (repo node_modules or /opt/node22/lib/node_modules)');
}

async function loadRouter() {
  const lib = path.join(ROOT, 'bench', 'lib', 'routes.mjs');
  if (fs.existsSync(lib)) return { mod: await import(pathToFileURL(lib).href), from: 'bench/lib/routes.mjs' };
  return { mod: null, from: 'builtin (EmulatorJS only)' };
}

// minimal fallback when bench/lib/routes.mjs is absent: only EmulatorJS is
// served locally, every other CDN request 404s so the app has to degrade
function builtinRouter() {
  const stats = { served: [], missing: [], warnings: ['bench/lib/routes.mjs missing: only cdn.emulatorjs.org is served locally'] };
  const re = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|tessdata\.projectnaptha\.com|cdn\.emulatorjs\.org|esm\.sh)\//;
  return {
    stats,
    async install(ctx) {
      await ctx.route(re, (route) => {
        const url = route.request().url();
        const m = url.match(/^https:\/\/cdn\.emulatorjs\.org\/[^/]+\/data\/([^?#]+)/);
        const f = m && path.join(EJS_DIR, m[1]);
        if (f && fs.existsSync(f)) { stats.served.push(url); return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'access-control-allow-origin': '*' } }); }
        stats.missing.push(url);
        return route.fulfill({ status: 404, body: 'blocked in e2e' });
      });
    }
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// export HEAD into bench/.cache/app-head so concurrent edits to src/ cannot
// change the code under test (or trigger reloads) mid-run
function prepareAppRoot() {
  if (APP === 'worktree') return { root: ROOT, rev: 'worktree' };
  const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
  const dir = path.join(ROOT, 'bench', '.cache', 'app-head');
  const stamp = path.join(dir, '.rev');
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== rev) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execSync(`git archive HEAD | tar -x -C ${JSON.stringify(dir)}`, { cwd: ROOT });
    fs.writeFileSync(stamp, rev);
  }
  // node_modules + router shims must resolve inside the exported root
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(ROOT, 'node_modules'), nm, 'dir');
  const shimsSrc = path.join(ROOT, 'bench', 'lib', 'shims');
  if (fs.existsSync(shimsSrc)) {
    const shimsDst = path.join(dir, 'bench', 'lib', 'shims');
    fs.mkdirSync(shimsDst, { recursive: true });
    for (const f of fs.readdirSync(shimsSrc)) fs.copyFileSync(path.join(shimsSrc, f), path.join(shimsDst, f));
  }
  return { root: dir, rev };
}

function srcHash(root) {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { h.update(path.relative(root, p)); h.update(fs.readFileSync(p)); }
    }
  };
  for (const d of ['src', 'index.html']) {
    const p = path.join(root, d);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p); else h.update(fs.readFileSync(p));
  }
  return h.digest('hex').slice(0, 12);
}

// ------------------------------------------------------------------ text utils
const norm = (s) => String(s || '').normalize('NFC').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const similarity = (a, b) => { a = norm(a); b = norm(b); const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; };
const cer = (got, exp) => { const e = norm(exp); return e.length ? lev(norm(got), e) / e.length : 0; };

// ------------------------------------------------------------------ fidelity
const b64ToU8 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));

// learn the 4 rendered palette colours from a trusted sampling, then classify
function learnPalette(rgba, expected) {
  const sums = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  for (let i = 0; i < expected.length; i++) {
    const k = expected[i]; if (k === 255) continue;
    sums[k][0] += rgba[i * 4]; sums[k][1] += rgba[i * 4 + 1]; sums[k][2] += rgba[i * 4 + 2]; sums[k][3]++;
  }
  return sums.map(([r, g, b, n]) => (n ? [r / n, g / n, b / n] : null));
}
function classify(rgba, pal) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < 4; k++) {
      if (!pal[k]) continue;
      const d = (rgba[i * 4] - pal[k][0]) ** 2 + (rgba[i * 4 + 1] - pal[k][1]) ** 2 + (rgba[i * 4 + 2] - pal[k][2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    out[i] = best;
  }
  return out;
}
// mismatch counts per area; "ink" = text pixels (expected colour 3 inside text rows)
function compare(idx, expected) {
  const W = 160;
  const areas = {
    frame: () => true,
    dialogBox: (x, y) => y >= LAYOUT.box.row0 * 8,
    textLines: (x, y) => LAYOUT.textRows.some((r) => y >= r * 8 && y < r * 8 + 8) && x >= LAYOUT.textCol * 8 && x < (LAYOUT.textCol + LAYOUT.maxCols) * 8
  };
  const res = {};
  for (const [name, fn] of Object.entries(areas)) {
    let n = 0, bad = 0, inkN = 0, inkBad = 0;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] === 255) continue;
      const x = i % W, y = (i / W) | 0;
      if (!fn(x, y)) continue;
      n++; if (idx[i] !== expected[i]) bad++;
      if (expected[i] === 3) { inkN++; if (idx[i] !== 3) inkBad++; }
    }
    res[name] = { pixels: n, mismatched: bad, errorRate: +(bad / Math.max(1, n)).toFixed(5), inkPixels: inkN, inkMissed: inkBad };
  }
  return res;
}

// ------------------------------------------------------------------ instrumentation
// Wraps app functions in flight (the files on disk are untouched): the
// response Vite serves for a module is rewritten so `export async function
// NAME(` becomes a private function plus an exported logging wrapper. This
// separates what the OCR engine read from what spell-correction made of it.
const WRAP = [
  ['/src/core/ocr-neural.js', ['ocrFrameNeural']],
  ['/src/core/ocr.js', ['ocrRegion']],
  ['/src/core/correct.js', ['correctOcrText']],
  ['/src/core/translate.js', ['translate']]
];
const instrumentNotes = [];
function wrapSource(src, fns) {
  let out = src;
  for (const fn of fns) {
    const re = new RegExp(`export\\s+async\\s+function\\s+${fn}\\s*\\(`);
    if (!re.test(out)) { instrumentNotes.push(`could not wrap ${fn} (signature changed)`); continue; }
    out = out.replace(re, `async function __e2e_orig_${fn}(`);
    out += `
export async function ${fn}(...args) {
  const t = performance.now();
  let r, err;
  try { r = await __e2e_orig_${fn}(...args); } catch (e) { err = e; }
  try {
    const sum = (v) => v == null ? v : typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (x && typeof x === 'object') ? { text: x.text, conf: x.conf } : x) : (typeof v === 'object' ? { text: v.text, confidence: v.confidence } : v);
    window.__e2e && window.__e2e.calls.push({ fn: '${fn}', t, dt: performance.now() - t, in: typeof args[0] === 'string' ? args[0] : (args[1] && args[1].w ? args[1] : undefined), out: sum(r), err: err ? String(err.message || err) : undefined });
  } catch {}
  if (err) throw err;
  return r;
}
`;
  }
  // raw per-line detector output of the neural engine (before region merging)
  if (fns.includes('ocrFrameNeural')) {
    const anchor = 'const items = result.items || [];';
    if (out.includes(anchor)) out = out.replace(anchor, anchor + ` try { window.__e2e && window.__e2e.rawItems.push({ t: performance.now(), items: items.map((i) => ({ text: i.text, score: +(+i.score || 0).toFixed(3), poly: i.poly, x: i.x, y: i.y, w: i.w, h: i.h })) }); } catch {}`);
    else instrumentNotes.push('could not hook raw paddle items');
  }
  return out;
}
async function instrument(context) {
  for (const [file, fns] of WRAP) {
    const re = new RegExp(file.replace(/[.\/]/g, (c) => '\\' + c) + '(\\?.*)?$');
    await context.route(re, async (route) => {
      try {
        const res = await route.fetch();
        const body = await res.text();
        await route.fulfill({ response: res, body: wrapSource(body, fns) });
      } catch (e) { instrumentNotes.push('instrument failed for ' + file + ': ' + e.message); await route.continue(); }
    });
  }
}

// ------------------------------------------------------------------ main
const report = {
  startedAt: new Date().toISOString(),
  options: { app: APP, rom: HUDROM ? 'hud' : 'base', engine: ENGINE, pages: NPAGES, dwellMs: DWELL, timeoutMs: TIMEOUT, dpr: DPR, viewport: [VW, VH], extraSettings: EXTRA_SETTINGS },
  env: {}, boot: {}, canvas: {}, pages: [], history: {}, console: [], pageErrors: [], requestFailures: [], httpErrors: [], routes: {}, bugs: []
};
const consoleCounts = { error: 0, warning: 0 };

async function main() {
  setup();
  const rom = writeAll(undefined, { hud: HUDROM });
  log('ROM', path.relative(ROOT, rom.romPath), `${rom.size} B, code+data ${rom.codeSize} B, header checksum 0x${rom.headerChecksum.toString(16)}, global 0x${rom.globalChecksum.toString(16)}`);
  report.rom = rom;

  const { root: appRoot, rev } = prepareAppRoot();
  report.env.appRoot = path.relative(ROOT, appRoot) || '.';
  report.env.appRev = rev;
  report.env.srcHash = srcHash(appRoot);
  report.env.node = process.version;

  const { mod: routesMod, from: routesFrom } = await loadRouter();
  report.env.routes = routesFrom;
  const { createServer } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
  const port = await freePort();
  const vite = await createServer({
    root: appRoot,
    configFile: path.join(appRoot, 'vite.config.js'),
    logLevel: 'warn',
    clearScreen: false,
    // no HMR / watching: another agent edits src/ concurrently and a reload
    // mid-run would invalidate the measurement
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/*'] }, fs: { allow: [ROOT] } },
    optimizeDeps: { include: routesMod?.VITE_OPTIMIZE_DEPS || [] }
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${port}`;
  log('vite dev server', origin, 'serving', report.env.appRoot, `(rev ${rev}, src ${report.env.srcHash})`);

  const { mod: pw, from: pwFrom } = await importPlaywright();
  const chromeArgs = (process.env.E2E_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
  // translation requests must reach the real endpoint through the sandbox
  // proxy; the Vite origin must NOT (Playwright force-proxies loopback unless
  // this env var is set - the proxy answers plain-HTTP requests with 405)
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  const browser = await pw.chromium.launch({ headless: !argv.headed, args: chromeArgs, proxy });
  report.env.playwright = pwFrom;
  report.env.chromium = browser.version();
  report.env.chromeArgs = chromeArgs;
  report.env.proxy = proxy ? proxy.server : null;
  log('chromium', browser.version(), chromeArgs.length ? chromeArgs.join(' ') : '(no extra flags)');

  // the app's service worker (public/sw.js) claims the page immediately and
  // re-issues every CDN request itself; Playwright cannot route requests made
  // by a service worker, so they would hit the (blocked) network. Block it.
  const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR, serviceWorkers: 'block' });
  const router = routesMod ? routesMod.createCdnRouter({ repoRoot: ROOT, viteOrigin: origin, emulatorjsDataDir: EJS_DIR, log: (m) => log(m) }) : builtinRouter();
  await router.install(context);
  if (!argv['no-instrument']) await instrument(context);

  const settings = { source: 'de', target: 'en', ocrEngine: ENGINE, ...EXTRA_SETTINGS };
  report.settings = settings;
  await context.addInitScript(({ settings }) => {
    try {
      if (!localStorage.getItem('emulingo:settings')) {
        localStorage.setItem('emulingo:settings', JSON.stringify(settings));
        // store.js flips autoTts off once on first load ("tts-default-migrated");
        // mark the migration done so an explicit autoTts:true survives
        localStorage.setItem('emulingo:tts-default-migrated', 'true');
      }
    } catch {}
    const E = window.__e2e = { log: [], tts: [], fetches: [], calls: [], rawItems: [], gaps: { frames: 0, over50: 0, over100: 0, over250: 0, max: 0, worst: [] } };
    // main-thread responsiveness: gaps between animation frames
    let lastF = 0;
    const onFrame = (ts) => {
      if (lastF) {
        const d = ts - lastF; const g = E.gaps; g.frames++;
        if (d > 50) g.over50++; if (d > 100) g.over100++; if (d > 250) g.over250++;
        if (d > g.max) g.max = d;
        if (d > 250 && g.worst.length < 200) g.worst.push({ t: Math.round(ts), ms: Math.round(d) });
      }
      lastF = ts; requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
    try {
      if (window.speechSynthesis) {
        const orig = speechSynthesis.speak.bind(speechSynthesis);
        speechSynthesis.speak = (u) => { E.tts.push({ t: performance.now(), text: u && u.text, lang: u && u.lang }); try { if (u && u.text) orig(u); } catch {} };
      }
    } catch {}
    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input);
      if (/translate|mymemory/i.test(url)) E.fetches.push({ t: performance.now(), url });
      return of.apply(this, arguments);
    };
    const panelState = (panel) => {
      const regions = [...panel.querySelectorAll('.region')].map((r) => ({
        orig: (r.querySelector('.orig')?.innerText || '').replace(/\s+/g, ' ').trim(),
        trans: (r.querySelector('.trans')?.innerText || '').replace(/\s+/g, ' ').trim()
      }));
      return { regions, text: regions.length ? null : panel.innerText.replace(/\s+/g, ' ').trim().slice(0, 400) };
    };
    const observe = () => {
      const panel = document.getElementById('current-line-panel');
      const status = document.getElementById('live-status');
      const hist = document.getElementById('history-list');
      if (!panel || !status || !hist) return setTimeout(observe, 50);
      let lastP = '', lastS = '', lastH = -1;
      const onPanel = () => { const s = panelState(panel); const k = JSON.stringify(s); if (k !== lastP) { lastP = k; E.log.push({ t: performance.now(), kind: 'panel', ...s }); } };
      const onStatus = () => { const s = status.innerText.replace(/\s+/g, ' ').trim(); if (s !== lastS) { lastS = s; E.log.push({ t: performance.now(), kind: 'status', text: s }); } };
      const onHist = () => { const n = hist.querySelectorAll('.history-item').length; if (n !== lastH) { lastH = n; E.log.push({ t: performance.now(), kind: 'history', count: n }); } };
      new MutationObserver(onPanel).observe(panel, { childList: true, subtree: true, characterData: true });
      new MutationObserver(onStatus).observe(status, { childList: true, subtree: true, characterData: true });
      new MutationObserver(onHist).observe(hist, { childList: true, subtree: true });
      const toasts = document.getElementById('toast-wrap');
      if (toasts) new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) E.log.push({ t: performance.now(), kind: 'toast', text: n.textContent, cls: n.className }); }).observe(toasts, { childList: true });
      onPanel(); onStatus(); onHist();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe); else observe();
  }, { settings });

  const page = await context.newPage();
  page.on('console', (m) => {
    const type = m.type();
    if (type === 'error') consoleCounts.error++;
    if (type === 'warning') consoleCounts.warning++;
    if (type === 'error' || type === 'warning' || /emulingo|ocr|paddle|tesseract/i.test(m.text())) {
      report.console.push({ t: Date.now() - t0, type, text: m.text().slice(0, 600) });
    }
  });
  page.on('pageerror', (e) => { report.pageErrors.push({ t: Date.now() - t0, message: String(e && (e.stack || e.message || e)).slice(0, 1200) }); log('PAGEERROR', String(e.message || e).slice(0, 200)); });
  page.on('requestfailed', (r) => report.requestFailures.push({ url: r.url().slice(0, 300), failure: r.failure()?.errorText }));
  page.on('response', (r) => { if (r.status() >= 400) report.httpErrors.push({ url: r.url().slice(0, 300), status: r.status() }); });

  // ---------------------------------------------------------------- boot
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.waitForSelector('#rom-input', { state: 'attached', timeout: 30000 });
  await page.screenshot({ path: path.join(OUT, '00-app-start.png') });
  report.env.webgl = await page.evaluate(() => {
    const out = {};
    for (const t of ['webgl2', 'webgl']) {
      const gl = document.createElement('canvas').getContext(t);
      if (!gl) { out[t] = null; continue; }
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      out[t] = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
    return out;
  });
  log('webgl', JSON.stringify(report.env.webgl));

  const bootStart = Date.now();
  await page.setInputFiles('#rom-input', rom.romPath);
  try {
    await page.waitForFunction(() => window.EJS_emulator && window.EJS_emulator.started === true && document.querySelector('#game canvas'), null, { timeout: 120000 });
  } catch (e) {
    await page.screenshot({ path: path.join(OUT, '01-boot-failed.png') });
    report.boot = { ok: false, error: e.message, ejsText: await page.evaluate(() => document.querySelector('#game')?.innerText?.slice(0, 500)) };
    throw new Error('emulator did not start: ' + e.message + ' / ' + report.boot.ejsText);
  }
  const gameStartPerf = await page.evaluate(() => performance.now());
  report.boot = { ok: true, ms: Date.now() - bootStart };
  log(`emulator started in ${report.boot.ms} ms`);
  report.boot.ejs = await page.evaluate(() => {
    const e = window.EJS_emulator;
    return { version: e.ejs_version, core: e.getCore && e.getCore(), coreName: e.coreName, webgl2Enabled: e.webgl2Enabled, supportsWebgl2: e.supportsWebgl2, threads: typeof SharedArrayBuffer === 'function' };
  });
  report.boot.coreFilesServed = (router.stats.served || []).filter((u) => /emulatorjs/.test(u)).map((u) => u.replace(/^https:\/\/cdn\.emulatorjs\.org/, ''));

  // ---------------------------------------------------------------- helpers
  const pageLogSince = async (tPerf) => page.evaluate((t) => window.__e2e.log.filter((e) => e.t >= t), tPerf);
  const perfNow = () => page.evaluate(() => performance.now());

  async function canvasInfo() {
    return page.evaluate(async () => {
      const em = await import('/src/core/emulator.js');
      const c = em.getGameCanvas();
      const r = c.getBoundingClientRect();
      return { canvasW: c.width, canvasH: c.height, cssW: +r.width.toFixed(2), cssH: +r.height.toFixed(2), dpr: devicePixelRatio, grid: em.getGrid(), core: window.__emulingoCore };
    });
  }

  async function grabNative() {
    return page.evaluate(async () => {
      const em = await import('/src/core/emulator.js');
      let snap = await em.snapshot();
      // emulator.snapshot()'s retry path resolves a bare <canvas> instead of
      // {canvas, grid}; record it and recover so the measurement still runs
      let snapshotShape = 'ok';
      if (snap instanceof HTMLCanvasElement) { snapshotShape = 'bare-canvas (retry path)'; snap = { canvas: snap, grid: em.getGrid() }; }
      if (!snap || !snap.canvas || !snap.grid) return { error: 'no snapshot', snapshotShape };
      const { canvas, grid } = snap;
      const W = grid.nativeW, H = grid.nativeH;
      const enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
      // (a) the app's method: one smoothed drawImage of the content rect
      const a = document.createElement('canvas'); a.width = W; a.height = H;
      const actx = a.getContext('2d', { willReadFrequently: true });
      actx.imageSmoothingEnabled = true; actx.imageSmoothingQuality = 'high';
      actx.drawImage(canvas, grid.x0, grid.y0, grid.contentW, grid.contentH, 0, 0, W, H);
      const A = actx.getImageData(0, 0, W, H).data;
      // (b) exact centre sampling of the full-resolution frame
      const full = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
      const B = new Uint8ClampedArray(W * H * 4);
      const sx = grid.contentW / W, sy = grid.contentH / H;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const px = Math.min(canvas.width - 1, Math.floor(grid.x0 + (x + 0.5) * sx));
        const py = Math.min(canvas.height - 1, Math.floor(grid.y0 + (y + 0.5) * sy));
        const si = (py * canvas.width + px) * 4, di = (y * W + x) * 4;
        B[di] = full[si]; B[di + 1] = full[si + 1]; B[di + 2] = full[si + 2]; B[di + 3] = 255;
      }
      // (c) whatever the app's own detector downscales to (if exported)
      let C = null, cNote = null;
      try {
        const ocr = await import('/src/core/ocr.js');
        if (typeof ocr.detectTextRects === 'function') {
          const det = ocr.detectTextRects(canvas, 6, grid);
          window.__e2e.lastRects = det && det.rects;
          if (det && det.canvas && det.canvas.width === W && det.canvas.height === H) C = enc(new Uint8Array(det.canvas.getContext('2d').getImageData(0, 0, W, H).data.buffer));
          else cNote = 'detectTextRects canvas is ' + (det && det.canvas ? det.canvas.width + 'x' + det.canvas.height : 'missing');
        }
      } catch (e) { cNote = 'ocr.detectTextRects failed: ' + e.message; }
      // actual content bounding box: extent of non-letterbox (non pure black)
      // pixels - the test ROM's frame edges always contain light pixels
      const cw = canvas.width, ch = canvas.height;
      const bg = [full[0], full[1], full[2]];
      let minX = cw, minY = ch, maxX = -1, maxY = -1;
      for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) {
        const i = (y * cw + x) * 4;
        if (full[i + 3] > 0 && full[i] + full[i + 1] + full[i + 2] > 30) {
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      const bbox = maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
      // (d) centre sampling at the MEASURED content placement
      let D = null;
      if (bbox) {
        D = new Uint8ClampedArray(W * H * 4);
        const bx = bbox.w / W, by = bbox.h / H;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const px = Math.min(cw - 1, Math.floor(bbox.x + (x + 0.5) * bx));
          const py = Math.min(ch - 1, Math.floor(bbox.y + (y + 0.5) * by));
          const si = (py * cw + px) * 4, di = (y * W + x) * 4;
          D[di] = full[si]; D[di + 1] = full[si + 1]; D[di + 2] = full[si + 2]; D[di + 3] = 255;
        }
      }
      return { snapshotShape, appRects: window.__e2e.lastRects || null, grid, canvasW: cw, canvasH: ch, A: enc(new Uint8Array(A.buffer)), B: enc(new Uint8Array(B.buffer)), C, D: D && enc(new Uint8Array(D.buffer)), cNote, contentBBox: bbox, cornerRGB: bg };
    });
  }

  // which ROM page is on screen + snapshot fidelity for each downscale method
  async function fidelity(expectPage, tag) {
    let g = null;
    for (let i = 0; i < 4 && !(g && g.A); i++) { g = await grabNative(); if (!(g && g.A)) await sleep(300); }
    if (!g || !g.A) return { error: 'no snapshot', snapshotShape: g && g.snapshotShape };
    const A = b64ToU8(g.A), B0 = b64ToU8(g.B), C = g.C ? b64ToU8(g.C) : null, D = g.D ? b64ToU8(g.D) : null;
    // page identification / palette learning use the measured placement when
    // the app's grid is off (portrait layouts), else the app-grid samples
    const B = D || B0;
    // identify the displayed page from centre samples (arrow cell = don't care)
    let best = -1, bestBad = Infinity;
    const perPage = [];
    for (let p = 0; p < PAGES.length; p++) {
      const exp = renderExpected(p, { arrow: null });
      const pal = learnPalette(B, exp);
      const bad = compare(classify(B, pal), exp).textLines.mismatched;
      perPage.push(bad);
      if (bad < bestBad) { bestBad = bad; best = p; }
    }
    const exp = renderExpected(expectPage, { arrow: null });
    const pal = learnPalette(B, exp);
    const res = {
      displayedPage: best, displayedPageTextMismatch: bestBad, expectedPage: expectPage,
      grid: g.grid, canvas: [g.canvasW, g.canvasH], contentBBox: g.contentBBox, cornerRGB: g.cornerRGB,
      palette: pal.map((c) => c && c.map((v) => Math.round(v))),
      snapshotShape: g.snapshotShape,
      smoothDownscale: compare(classify(A, pal), exp),
      centreSample: compare(classify(B0, pal), exp),
      centreSampleMeasuredBBox: D ? compare(classify(D, pal), exp) : null
    };
    if (C) res.appDetectorCanvas = compare(classify(C, pal), exp); else res.appDetectorNote = g.cNote;
    res.appDetectorRects = g.appRects; // detectTextRects() output on this frame (native coords)
    fs.writeFileSync(path.join(OUT, `${tag}-native-smooth.png`), encodePng(160, 144, A));
    fs.writeFileSync(path.join(OUT, `${tag}-native-centre.png`), encodePng(160, 144, B0));
    if (D) fs.writeFileSync(path.join(OUT, `${tag}-native-centre-bbox.png`), encodePng(160, 144, D));
    return res;
  }

  async function pressA() {
    await page.evaluate(() => { try { window.EJS_emulator.elements.parent.focus(); } catch {} });
    const tp = await perfNow();
    await page.keyboard.down('z');
    await sleep(150);
    await page.keyboard.up('z');
    return tp;
  }

  const typingMs = (p) => Math.ceil(((PAGES[p][0].length + PAGES[p][1].length + 2) * LAYOUT.framesPerChar) / 59.73 * 1000);

  // ---------------------------------------------------------------- canvas
  await sleep(1500);
  report.canvas = await canvasInfo();
  log('canvas', JSON.stringify(report.canvas));
  await page.screenshot({ path: path.join(OUT, '01-emulator-started.png') });

  // ---------------------------------------------------------------- pages
  for (let p = 0; p < NPAGES; p++) {
    const tag = `p${p}`;
    const exp = PAGES[p].join(' ');
    let tChange;
    if (p === 0) tChange = gameStartPerf;
    else tChange = await pressA();
    await sleep(typingMs(p) + 500);
    const tTyped = await perfNow();
    const fid = await fidelity(p, tag);
    try { await page.locator('#game canvas').screenshot({ path: path.join(OUT, `${tag}-canvas.png`) }); } catch {}
    log(`page ${p} typed: ROM shows page ${fid.displayedPage} (text mismatch ${fid.displayedPageTextMismatch}px); textLines err smooth=${fid.smoothDownscale?.textLines.errorRate} centre=${fid.centreSample?.textLines.errorRate}`);

    // wait for the app to show a matching, fully translated line
    const pageTimeout = TIMEOUT + (p === 0 ? 120000 : 0);
    const deadline = Date.now() + pageTimeout;
    let matched = null, best = null;
    const dwellUntil = Date.now() + DWELL;
    for (;;) {
      const evs = await pageLogSince(tChange);
      for (const e of evs) {
        if (e.kind !== 'panel' || !e.regions || !e.regions.length) continue;
        const orig = e.regions.map((r) => r.orig).join(' / ');
        const trans = e.regions.map((r) => r.trans).join(' / ');
        const done = e.regions.every((r) => r.trans && r.trans !== '…');
        // hud ROM: the route banner merged into the dialog region still counts
        const sim = Math.max(similarity(orig, exp), HUDROM ? similarity(orig, HUD_TEXT + ' ' + exp) : 0);
        if (done && (!best || sim > best.sim)) best = { t: e.t, sim, orig, trans };
        if (done && sim >= 0.85 && !matched) matched = { t: e.t, sim, orig, trans };
      }
      if ((matched && Date.now() >= dwellUntil) || Date.now() > deadline) break;
      await sleep(400);
    }
    const evs = await pageLogSince(tChange);
    await page.screenshot({ path: path.join(OUT, `${tag}-app.png`) });
    const finalPanel = await page.evaluate(() => {
      const panel = document.getElementById('current-line-panel');
      return [...panel.querySelectorAll('.region')].map((r) => ({ orig: r.querySelector('.orig')?.innerText.replace(/\s+/g, ' ').trim(), trans: r.querySelector('.trans')?.innerText.replace(/\s+/g, ' ').trim() }));
    });
    const panels = evs.filter((e) => e.kind === 'panel' && e.regions && e.regions.length && e.regions.every((r) => r.trans && r.trans !== '…'));
    const statuses = [...new Set(evs.filter((e) => e.kind === 'status' && e.text).map((e) => e.text))];
    const shownOrig = finalPanel.map((r) => r.orig).join(' / ');
    const entry = {
      page: p, lang: PAGE_LANG[p], expected: exp,
      hudTextMergedIntoRegion: HUDROM ? finalPanel.some((r) => /route/i.test(r.orig || '')) : undefined,
      romDisplayedPage: fid.displayedPage,
      shown: { original: shownOrig, translation: finalPanel.map((r) => r.trans).join(' / '), regions: finalPanel.length },
      similarity: +similarity(shownOrig, exp).toFixed(3), cer: +cer(shownOrig, exp).toFixed(3),
      matched: !!matched,
      latencyMs: {
        fromChangeToTranslation: matched ? Math.round(matched.t - tChange) : null,
        fromTypedToTranslation: matched ? Math.round(matched.t - tTyped) : null,
        firstCompletedPanel: panels.length ? Math.round(panels[0].t - tChange) : null
      },
      best: best && { ...best, t: Math.round(best.t - tChange), sim: +best.sim.toFixed(3) },
      distinctPanelsShown: [...new Set(panels.map((e) => e.regions.map((r) => r.orig + ' => ' + r.trans).join(' | ')))],
      statusMessages: statuses.slice(0, 30),
      ocrCalls: await page.evaluate((t) => window.__e2e.calls.filter((c) => c.t >= t && /ocr/i.test(c.fn)).map((c) => ({ t: Math.round(c.t - t), dt: Math.round(c.dt), fn: c.fn, rect: c.in, out: c.out, err: c.err })), tChange),
      corrections: await page.evaluate((t) => window.__e2e.calls.filter((c) => c.t >= t && c.fn === 'correctOcrText' && c.in !== c.out).map((c) => ({ in: c.in, out: c.out })), tChange),
      rawPaddleItems: await page.evaluate((t) => { const r = window.__e2e.rawItems.filter((c) => c.t >= t); return r.length ? r[r.length - 1].items : null; }, tChange),
      fidelity: fid
    };
    report.pages.push(entry);
    log(`page ${p}: ${matched ? 'MATCH' : 'no match'} sim=${entry.similarity} latency=${entry.latencyMs.fromChangeToTranslation}ms shown="${entry.shown.original}" => "${entry.shown.translation}"`);
  }

  // ---------------------------------------------------------------- history / storage
  const store = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('emulingo:')) { try { out[k] = JSON.parse(localStorage.getItem(k)); } catch { out[k] = localStorage.getItem(k); } }
    }
    return out;
  });
  const hist = (store['emulingo:history'] || []).slice().reverse(); // oldest first
  const domHistory = await page.evaluate(() => [...document.querySelectorAll('#history-list .history-item')].map((el) => ({ orig: el.querySelector('.hi-orig')?.innerText, trans: el.querySelector('.hi-trans')?.innerText })));
  const byText = {};
  for (const h of hist) byText[h.original] = (byText[h.original] || 0) + 1;
  let consecutiveDupes = 0;
  for (let i = 1; i < hist.length; i++) if (norm(hist[i].original) === norm(hist[i - 1].original)) consecutiveDupes++;
  const e2e = await page.evaluate(() => ({ tts: window.__e2e.tts, fetches: window.__e2e.fetches.length, translateUrls: [...new Set(window.__e2e.fetches.map((f) => f.url.split('?')[0]))] }));
  report.history = {
    entries: hist.length,
    distinct: Object.keys(byText).length,
    consecutiveDuplicates: consecutiveDupes,
    countsByOriginal: byText,
    domShown: domHistory.length,
    timeline: hist.map((h) => ({ t: h.time, original: h.original, translation: h.translation, conf: h.conf }))
  };
  report.storage = {
    dictEntries: (store['emulingo:dict'] || []).length,
    dictLineCounts: (store['emulingo:dict'] || []).filter((d) => d.kind === 'line').map((d) => ({ text: d.text, count: d.count })),
    cards: (store['emulingo:cards'] || []).length,
    settings: store['emulingo:settings']
  };
  report.tts = { calls: e2e.tts.length, texts: e2e.tts.map((x) => x.text) };
  report.mainThread = await page.evaluate(() => { const g = window.__e2e.gaps; return { ...g, worst: g.worst.slice(0, 50) }; });
  const allCalls = await page.evaluate(() => window.__e2e.calls.map((c) => ({ fn: c.fn, dt: Math.round(c.dt) })));
  const byFn = {};
  for (const c of allCalls) { (byFn[c.fn] = byFn[c.fn] || []).push(c.dt); }
  report.callStats = Object.fromEntries(Object.entries(byFn).map(([k, v]) => { v.sort((a, b) => a - b); return [k, { n: v.length, medianMs: v[v.length >> 1], p90Ms: v[Math.floor(v.length * 0.9)], maxMs: v[v.length - 1] }]; }));
  report.instrumentNotes = instrumentNotes;
  await page.screenshot({ path: path.join(OUT, '98-after-pages.png'), fullPage: true });

  // ---------------------------------------------------------------- save state -> reload -> auto-restore
  if (!argv['no-state'] && NPAGES > 1) {
    const st = { lastPage: NPAGES - 1 };
    try {
      const tS = await perfNow();
      await page.click('#btn-save-state');
      await sleep(2000);
      st.saveToasts = (await pageLogSince(tS)).filter((e) => e.kind === 'toast').map((e) => e.text);
      st.idbHasState = await page.evaluate(() => new Promise((res) => {
        const rq = indexedDB.open('emulingo'); rq.onerror = () => res(null);
        rq.onsuccess = () => { try { const db = rq.result; const names = [...db.objectStoreNames]; const tx = db.transaction(names[0], 'readonly'); const os = tx.objectStore(names[0]); const k = os.getAllKeys(); k.onsuccess = () => res(k.result.map(String)); k.onerror = () => res(names); } catch (e) { res('err ' + e.message); } };
      }));
      // a fresh page load, then start the game from the ROM library like a returning user
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('[data-play]', { timeout: 20000 });
      const tR = await perfNow();
      await page.click('[data-play]');
      await page.waitForFunction(() => window.EJS_emulator && window.EJS_emulator.started === true, null, { timeout: 60000 });
      await sleep(4000);
      const f = await fidelity(st.lastPage, 'state-restore');
      st.displayedPageAfterReload = f.displayedPage;
      st.restored = f.displayedPage === st.lastPage;
      st.toastsAfterReload = (await pageLogSince(tR)).filter((e) => e.kind === 'toast').map((e) => e.text);
      await page.screenshot({ path: path.join(OUT, 'state-restore.png') });
      // manual Load button: proves the stored state itself is valid
      const tL = await perfNow();
      await page.click('#btn-load-state');
      await sleep(2500);
      st.displayedPageAfterLoadButton = (await fidelity(st.lastPage, 'state-load-button')).displayedPage;
      st.loadButtonWorks = st.displayedPageAfterLoadButton === st.lastPage;
      st.loadToasts = (await pageLogSince(tL)).filter((e) => e.kind === 'toast').map((e) => e.text);
    } catch (e) { st.error = e.message; }
    report.stateTest = st;
    log('state test', JSON.stringify(st));
  }

  report.translateFetches = { count: e2e.fetches, endpoints: e2e.translateUrls };
  report.routes = { served: router.stats.served.length, missing: router.stats.missing, warnings: router.stats.warnings, tessdata: router.stats.tessdata };
  report.consoleCounts = consoleCounts;
  await page.screenshot({ path: path.join(OUT, '99-final.png'), fullPage: true });

  await browser.close();
  await vite.close();
}

function summarize() {
  const s = [];
  s.push(`app=${APP} (${report.env.appRev}, src ${report.env.srcHash}) engine=${ENGINE} chromium=${report.env.chromium}`);
  s.push(`boot: ${JSON.stringify(report.boot)}`);
  s.push(`canvas: ${JSON.stringify(report.canvas)}`);
  for (const p of report.pages) {
    const f = p.fidelity || {};
    s.push(`p${p.page} [rom shows ${p.romDisplayedPage}] exp="${p.expected}" shown="${p.shown.original}" => "${p.shown.translation}" sim=${p.similarity} matched=${p.matched} latency=${p.latencyMs.fromChangeToTranslation}ms | textLines err smooth=${f.smoothDownscale?.textLines.errorRate} centre=${f.centreSample?.textLines.errorRate} centre@bbox=${f.centreSampleMeasuredBBox?.textLines.errorRate}${f.appDetectorCanvas ? ' app=' + f.appDetectorCanvas.textLines.errorRate : ''}`);
  }
  s.push(`history: ${report.history.entries} entries, ${report.history.distinct} distinct, ${report.history.consecutiveDuplicates} consecutive duplicates`);
  s.push(`tts calls: ${report.tts?.calls}, translate fetches: ${report.translateFetches?.count}, dict entries ${report.storage?.dictEntries}, cards ${report.storage?.cards}`);
  s.push(`console: ${JSON.stringify(report.consoleCounts)}, page errors: ${report.pageErrors.length}, http errors: ${report.httpErrors.length}, missing routes: ${report.routes?.missing?.length}`);
  return s.join('\n');
}

// a killed run still leaves a (partial) report behind
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  report.fatal = 'interrupted by ' + sig;
  try { fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(OUT, 'summary.txt'), summarize() + '\n'); } catch {}
  process.exit(130);
});

try {
  await main();
} catch (e) {
  report.fatal = String(e && (e.stack || e.message || e));
  console.error('FATAL', report.fatal);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - t0;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  try { const s = summarize(); fs.writeFileSync(path.join(OUT, 'summary.txt'), s + '\n'); console.log('\n' + s); } catch (e) { console.error('summary failed', e); }
  // backup copy: bench/results/ is shared with other tooling that may clear it
  try { fs.cpSync(OUT, path.join(ROOT, 'bench', '.cache', 'e2e', 'results', path.basename(OUT)), { recursive: true }); } catch {}
  console.log('\nresults:', path.relative(ROOT, OUT));
  process.exit(process.exitCode || 0);
}
