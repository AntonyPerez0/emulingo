#!/usr/bin/env node
// Production smoke test: the real build, served by `vite preview`, in
// headless Chromium with the service worker enabled and the build's
// Content-Security-Policy in force.
//
//  1. first visit: the app boots without console errors or CSP violations,
//     the service worker activates and precaches the shell
//  2. a real game: EmulatorJS 4.2.3 (gambatte, served from bench/.cache in
//     place of cdn.emulatorjs.org) starts the homebrew test ROM, the OCR
//     worker reads its dialog box and the line is translated — all under
//     the CSP; the models, runtime and EmulatorJS files land in their caches
//  3. update: a rebuild with another build id shows "An update is
//     available"; Reload activates the new worker, which drops the old shell
//  4. offline: with the network gone, the app still opens, the game starts
//     from the cached emulator files and the screen is still read
//
//   node build/smoke.mjs [--keep] [--headed]     (npm run e2e:pwa)
//
// The CDNs are stood in for by a local HTTPS server that Chromium reaches
// under the real host names (--host-resolver-rules), so requests take the
// same path as in production, service worker included, with no Playwright
// interception: EmulatorJS from bench/.cache/emulatorjs (laid out by
// bench/e2e/setup.mjs, run here if missing) and the Hunspell dictionaries
// from node_modules. Needs openssl for the throwaway certificate.
// Translation uses the real Google endpoint (through $HTTPS_PROXY when set).
// Prints PASS/FAIL lines and a size summary; exits 1 on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { setup as setupEmulatorJs, EJS_DIR } from '../bench/e2e/setup.mjs';
import { writeAll, PAGES } from '../bench/e2e/make-gb-rom.mjs';
import { listFiles, buildManifest } from './sw-plugin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Playwright otherwise sends 127.0.0.1 through a configured HTTP proxy
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
const CDN_HOSTS = ['cdn.emulatorjs.org', 'cdn.jsdelivr.net'];

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const HEADED = argv.includes('--headed');
const PORTS = [5490, 5491, 5492, 5493, 5494, 5495, 5496, 5497, 5498, 5499];
const FIRST_READ_MS = 180000;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, info) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined && !ok ? ` :: ${JSON.stringify(info).slice(0, 800)}` : ''}`);
  return !!ok;
}

const norm = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
const kb = (n) => `${(n / 1e3).toFixed(1)} kB`;

// ---- build + serve -------------------------------------------------------------

async function buildApp(outDir, sha) {
  const before = process.env.GITHUB_SHA;
  process.env.GITHUB_SHA = sha;
  try {
    await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  } finally {
    if (before === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = before;
  }
}

const MIME = {
  '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.dic': 'text/plain; charset=utf-8', '.aff': 'text/plain; charset=utf-8',
};

// The stand-in CDN. no-store: anything that works offline later came from
// the service worker, not the HTTP cache.
function cdnFile(host, pathname) {
  if (host === 'cdn.emulatorjs.org') {
    const m = pathname.match(/^\/(?:4\.2\.3|stable)\/data\/([^?#]+)$/);
    return m && path.join(EJS_DIR, m[1]);
  }
  if (host === 'cdn.jsdelivr.net') {
    const m = pathname.match(/^\/npm\/(dictionary-[a-z]+)@[\d.]+\/(index\.(?:dic|aff))$/);
    return m && path.join(ROOT, 'node_modules', m[1], m[2]);
  }
  return null;
}

async function startCdn(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=spritespeak-smoke', '-addext', `subjectAltName=${CDN_HOSTS.map((h) => `DNS:${h}`).join(',')}`], { stdio: 'ignore' });
  const served = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const file = cdnFile(host, new URL(req.url, 'https://x').pathname);
    const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, headers);
      return res.end('not found');
    }
    served.push(`${host}${req.url}`);
    res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
  });
  for (const port of PORTS) {
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return { server, port, served };
  }
  throw new Error(`No free port in ${PORTS.join(', ')}`);
}

async function serve(outDir) {
  for (const port of PORTS) {
    try {
      const server = await preview({
        root: ROOT,
        configFile: path.join(ROOT, 'vite.config.js'),
        logLevel: 'warn',
        build: { outDir },
        preview: { port, strictPort: true, host: '127.0.0.1', open: false },
      });
      return { server, base: `http://127.0.0.1:${port}/` };
    } catch (e) {
      if (!/in use|EADDRINUSE/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error(`No free port in ${PORTS.join(', ')}`);
}

function sizeReport(outDir) {
  const files = listFiles(outDir);
  const m = buildManifest(files);
  const by = new Map(files.map((f) => [f.path, f]));
  const sum = (list) => list.reduce((s, p) => s + by.get(p).size, 0);
  const gz = (list) => list.reduce((s, p) => s + zlib.gzipSync(fs.readFileSync(path.join(outDir, p))).length, 0);
  const shell = m.precache;
  const firstOcr = [...Object.keys(m.models), m.heavy.find((p) => p.endsWith('.wasm'))].filter(Boolean);
  return {
    total: files.reduce((s, f) => s + f.size, 0),
    shell: { files: shell.length, bytes: sum(shell), gzip: gz(shell) },
    firstOcr: { files: firstOcr, bytes: sum(firstOcr) },
    tesseract: { files: m.heavy.filter((p) => /tesseract/.test(p)), bytes: sum(m.heavy.filter((p) => /tesseract-core-simd/.test(p))) },
  };
}

// ---- page helpers --------------------------------------------------------------

function watch(page, sink) {
  page.on('pageerror', (e) => {
    const stack = String(e.stack || e.message);
    // EmulatorJS checks for its own updates only on localhost, without a catch
    if (sink.offline && /checkForUpdates/.test(stack)) return;
    sink.push(`pageerror: ${stack.split('\n').slice(0, 3).join(' | ')}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // EmulatorJS asks for a wake lock headless Chromium refuses; translation is
    // expected to fail while offline
    if (/Wake Lock|wakeLock/i.test(text)) return;
    if (sink.offline && /ERR_INTERNET_DISCONNECTED|Failed to fetch|translate/i.test(text)) return;
    sink.push(`console.error: ${text}`);
  });
}

async function appReady(page) {
  await page.waitForSelector('section[data-view="play"]:not([hidden]) h1', { timeout: 30000 });
}

async function cacheReport(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map((r) => r.url);
    }
    return out;
  });
}

const liveDialog = (page) => page.evaluate(() => {
  const orig = document.querySelector('.live .part--dialog .part__orig');
  const trans = document.querySelector('.live .part--dialog .part__trans');
  return {
    text: orig ? orig.textContent.replace(/\s+/g, ' ').trim() : '',
    translation: trans && !trans.matches('.part__trans--pending, .part__trans--error, .part__trans--updating') ? trans.textContent.trim() : '',
  };
});

async function waitForText(page, expected, { translated, timeout }) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = await liveDialog(page).catch(() => null);
    await page.evaluate(() => document.querySelector('[data-action="show-queued"]')?.click()).catch(() => {});
    if (last && norm(last.text) === norm(expected) && (!translated || last.translation)) return { ok: true, ...last };
    await sleep(300);
  }
  return { ok: false, ...last };
}

// ---- run ---------------------------------------------------------------------------

async function main() {
  await setupEmulatorJs();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spritespeak-pwa-'));
  const outDir = path.join(work, 'dist');
  const { romPath } = writeAll(path.join(work, 'rom'));
  const firstPage = `${PAGES[0][0]} ${PAGES[0][1]}`;

  log('building (build id smoke01)…');
  await buildApp(outDir, 'smoke01aaaaaaa');
  const sizes = sizeReport(outDir);
  const cdn = await startCdn(work);
  const { server, base } = await serve(outDir);
  log('preview', base, '· CDN stand-in on port', cdn.port);

  const bypass = ['127.0.0.1', 'localhost', ...CDN_HOSTS].join(',');
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass } : undefined;
  const browser = await chromium.launch({
    headless: !HEADED,
    proxy,
    args: [`--host-resolver-rules=${CDN_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${cdn.port}`).join(', ')}`, '--ignore-certificate-errors'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'allow' });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'}${e.sourceFile ? ` in ${e.sourceFile}:${e.lineNumber}` : ''}`);
    });
  });
  const errors = [];
  let page = await context.newPage();
  watch(page, errors);

  try {
    // ---- 1. first visit
    await page.goto(base);
    await appReady(page);
    check('app boots from the production build', true);
    check('CSP meta is in force', await page.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')));
    const sw = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 20000))]);
      if (!reg) return null;
      const w = reg.active;
      if (w.state !== 'activated') await new Promise((r) => w.addEventListener('statechange', () => w.state === 'activated' && r()));
      return { state: w.state, script: w.scriptURL, controlled: !!navigator.serviceWorker.controller };
    });
    check('service worker registers, activates and controls the first visit', sw && sw.state === 'activated' && sw.script.endsWith('/sw.js') && sw.controlled, sw);
    let caches1 = await cacheReport(page);
    const shell1 = Object.keys(caches1).find((n) => n.startsWith('emulingo-shell-'));
    check('shell precached on install', shell1 && caches1[shell1].length === sizes.shell.files && caches1[shell1].includes(base + 'index.html'),
      { shell1, entries: shell1 && caches1[shell1].length, expected: sizes.shell.files });
    check('shell cache carries the build id', /smoke01/.test(shell1 || ''), shell1);

    // ---- 2. a real game under the CSP
    await page.click('.onboarding [data-quick="de"]');
    await page.click('.onboarding button[type="submit"]');
    await page.waitForSelector('.onboarding', { state: 'detached', timeout: 5000 });
    await page.setInputFiles('section[data-view="play"] [data-rom-input]', romPath);
    await page.waitForSelector('.stage[data-state="running"]', { timeout: 120000 });
    check('EmulatorJS starts the game under the CSP', true);
    await page.mouse.move(2, 2);
    const read1 = await waitForText(page, firstPage, { translated: true, timeout: FIRST_READ_MS });
    check('OCR worker reads the dialog and the line is translated', read1.ok, read1);
    await sleep(1500);
    caches1 = await cacheReport(page);
    const models = caches1['emulingo-models-v1'] || [];
    const cdnCache = caches1['emulingo-cdn-v1'] || [];
    check('models and the ONNX runtime cached on first use',
      ['models/det.tar?v=', 'models/rec.tar?v=', '.wasm'].every((s) => models.some((u) => u.includes(s))), models);
    check('EmulatorJS files cached (loader, scripts, core, report)',
      ['/data/loader.js', '/data/emulator.min.js', '/data/cores/gambatte', '/data/cores/reports/gambatte.json'].every((s) => cdnCache.some((u) => u.includes(s))), cdnCache);
    check('nothing from the translation services is cached', !Object.values(caches1).flat().some((u) => /translate|mymemory/.test(u)));
    const csp1 = await page.evaluate(() => window.__csp);
    check('no CSP violations while playing', csp1.length === 0, csp1);
    check('no console errors while playing', errors.length === 0, errors);

    // ---- 3. update prompt
    log('rebuilding (build id smoke02)…');
    await buildApp(outDir, 'smoke02bbbbbbb');
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    const toast = page.locator('#toast-region .toast', { hasText: 'An update is available' });
    const prompted = await toast.waitFor({ timeout: 30000 }).then(() => true, () => false);
    check('a new deploy shows "An update is available"', prompted);
    if (prompted) {
      await Promise.all([page.waitForEvent('load', { timeout: 30000 }), toast.locator('.toast__action').click()]);
      await appReady(page);
      const caches2 = await cacheReport(page);
      const shells = Object.keys(caches2).filter((n) => n.startsWith('emulingo-shell-'));
      check('Reload activates the new worker and drops the old shell', shells.length === 1 && /smoke02/.test(shells[0]), shells);
      check('runtime caches survive the update', (caches2['emulingo-models-v1'] || []).length >= 3 && (caches2['emulingo-cdn-v1'] || []).length >= 4);
    }

    // ---- 4. offline
    await context.setOffline(true);
    await server.close();
    await new Promise((resolve) => cdn.server.close(resolve));
    cdn.server.closeAllConnections?.();
    errors.offline = true;
    await page.close();
    page = await context.newPage();
    watch(page, errors);
    const t = Date.now();
    await page.goto(base);
    await appReady(page);
    check('app opens offline from the cache', true);
    check('offline start is fast (no 3 s network wait)', Date.now() - t < 2900, Date.now() - t);
    await page.click('[data-library] [data-action="play"]', { timeout: 15000 });
    const started = await page.waitForSelector('.stage[data-state="running"]', { timeout: 60000 }).then(() => true, () => false);
    check('the game starts offline from cached emulator files', started);
    if (started) {
      // a resume prompt may cover the game: start fresh
      await page.evaluate(() => document.querySelector('[data-action="dismiss-resume"], [data-action="start-fresh"]')?.click()).catch(() => {});
      const read2 = await waitForText(page, firstPage, { translated: false, timeout: 60000 });
      check('the screen is still read offline', read2.ok, read2);
    }
    const csp2 = await page.evaluate(() => window.__csp);
    check('no CSP violations offline', csp2.length === 0, csp2);
    check('no unexpected console errors', errors.length === 0, errors);
  } catch (err) {
    check(`smoke run completed (${err.message.split('\n')[0]})`, false);
    await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {});
    console.log('screenshot:', path.join(work, 'failure.png'));
  } finally {
    await browser.close();
    await server.close().catch(() => {});
    cdn.server.close();
    cdn.server.closeAllConnections?.();
    if (!KEEP) fs.rmSync(work, { recursive: true, force: true });
  }

  console.log('\nBuild sizes');
  console.log(`  dist total:              ${mb(sizes.total)}`);
  console.log(`  app shell (precached):   ${sizes.shell.files} files, ${kb(sizes.shell.bytes)} (${kb(sizes.shell.gzip)} gzip)`);
  console.log(`  first text recognition:  ${mb(sizes.firstOcr.bytes)} (${sizes.firstOcr.files.join(', ')})`);
  console.log(`  Classic reader (if used): ${mb(sizes.tesseract.bytes)} + language data`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
