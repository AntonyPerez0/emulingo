#!/usr/bin/env node
// Production-build check of the OCR engine:
//   1. vite build (the real vite.config.js) with tests/e2e-engine/engine.html
//      as the only entry, into a temp dir
//   2. serve it statically (first free port from 5471, override with PORT)
//   3. headless Chromium runs engine-page.js: neural reads in the module
//      worker, the Tesseract fallback, main-thread long tasks
// Checks: only the plain (non-JSEP) ORT wasm is emitted and loaded, every
// runtime request is same-origin except tessdata (served from
// bench/.cache by the bench CDN router), text is read correctly, no
// main-thread long task exceeds 50 ms during reads, and the Tesseract
// fallback survives a language switch and settles on dispose().
//
//   node tests/e2e-engine/run.mjs [--keep]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';
import { createCdnRouter } from '../../bench/lib/routes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.PORT || 5471);
const outDir = process.env.OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'spritespeak-engine-'));
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

await build({
  root,
  configFile: path.join(root, 'vite.config.js'),
  logLevel: 'warn',
  build: { outDir, emptyOutDir: true, rollupOptions: { input: { engine: path.join(root, 'tests/e2e-engine/engine.html') } } }
});

const assets = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else assets.push({ file: path.relative(outDir, p), size: fs.statSync(p).size });
  }
})(outDir);
assets.sort((a, b) => b.size - a.size);
console.log('\nemitted files:');
for (const a of assets) console.log(`  ${(a.size / 1e6).toFixed(2).padStart(7)} MB  ${a.file}`);
const wasm = assets.filter((a) => a.file.endsWith('.wasm'));
check(wasm.length === 1 && /ort-wasm-simd-threaded-[\w-]+\.wasm$/.test(wasm[0].file) && !/jsep/.test(wasm[0].file), 'exactly one ORT wasm, the plain (non-JSEP) build');
check(assets.some((a) => /ocr\.worker-[\w-]+\.js$/.test(a.file)), 'OCR module worker emitted');
check(assets.some((a) => /worker\.min-[\w-]+\.js$/.test(a.file)) && assets.some((a) => /tesseract-core-simd-lstm\.wasm-[\w-]+\.js$/.test(a.file)), 'Tesseract worker + core emitted same-origin');
const pageChunk = assets.find((a) => /^assets\/engine-[\w-]+\.js$/.test(a.file));
check(pageChunk && !fs.readFileSync(path.join(outDir, pageChunk.file), 'utf8').includes('tesseract.js-core'), 'tesseract.js is not in the page chunk (lazy)');

// static server for dist + public models (copied by the build)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.tar': 'application/x-tar', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(outDir, decodeURIComponent(url.pathname));
  if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
// other local servers share the 54xx range: take the first free port
let listening = 0;
for (let p = port; p < port + 9 && !listening; p++) {
  listening = await new Promise((resolve) => {
    server.once('error', () => resolve(0));
    server.listen(p, '127.0.0.1', () => resolve(p));
  });
}
if (!listening) throw new Error(`no free port in ${port}–${port + 8}`);
const origin = `http://127.0.0.1:${listening}`;

const browser = await chromium.launch({ args: ['--no-proxy-server'] });
try {
  const context = await browser.newContext();
  const router = createCdnRouter({ repoRoot: root, viteOrigin: origin });
  await router.install(context);
  const requests = [];
  context.on('request', (r) => requests.push(r.url()));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // ORT's optimiser warnings arrive as console errors unless silenced
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
  await page.goto(`${origin}/tests/e2e-engine/engine.html`);
  await page.waitForFunction(() => typeof window.engineTest === 'function');
  const res = await page.evaluate(() => window.engineTest());
  console.log('\n' + JSON.stringify({ ...res, statuses: res.statuses.map((s) => `${s.phase} ${s.engine} ${s.message}`) }, null, 1));

  const phases = res.statuses.filter((s) => s.engine === 'neural').map((s) => s.phase);
  check(phases.includes('download') && phases.includes('init') && phases[phases.length - 1] === 'ready', 'neural status: download → init → ready');
  check(res.lines.engine === 'neural' && res.lines.texts.join(' | ') === 'Hello there! | Welcome to the', `lines mode reads the GB dialog (${res.lines.texts.join(' | ')})`);
  check(res.free.texts.some((t) => /Hello there/.test(t)), `free mode finds the dialog (${res.free.texts.join(' | ')})`);
  check(res.container.texts.some((t) => /What will/i.test(t)), `container mode reads light-on-dark GBA text (${res.container.texts.join(' | ')})`);
  check(res.tesseract.engine === 'tesseract' && /Hello/i.test(res.tesseract.texts.join(' ')), `Tesseract fallback reads (${res.tesseract.texts.join(' | ')})`);
  check(res.languageSwitch.en.ok && /Hello/i.test(res.languageSwitch.en.texts.join(' ')), `a Tesseract read survives a language switch (${JSON.stringify(res.languageSwitch.en)})`);
  check(res.languageSwitch.de.ok, `the new language reads afterwards (${JSON.stringify(res.languageSwitch.de)})`);
  check(!res.dispose.ok && /^AbortError/.test(res.dispose.error) && res.dispose.ms < 1000, `dispose settles a running Tesseract read at once (${JSON.stringify(res.dispose)})`);
  for (const k of ['lines', 'free', 'container']) check(res[k].maxLongTaskMs <= 50, `${k}: no main-thread long task over 50 ms (max ${res[k].maxLongTaskMs} ms, read ${res[k].ms} ms)`);
  const foreign = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('https://tessdata.projectnaptha.com/') && !u.startsWith('data:') && !u.startsWith('blob:'));
  check(!foreign.length, `no third-party requests besides tessdata ${foreign.length ? JSON.stringify(foreign) : ''}`);
  const wasmReq = requests.filter((u) => u.endsWith('.wasm'));
  check(wasmReq.length === 1 && !/jsep/.test(wasmReq[0]), `the plain ORT wasm is loaded (${wasmReq.map((u) => u.slice(origin.length)).join(', ')})`);
  check(!errors.length, `no page or console errors ${errors.slice(0, 3).join('; ')}`);
} finally {
  await browser.close();
  server.close();
  if (!process.argv.includes('--keep') && !process.env.OUT_DIR) fs.rmSync(outDir, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
