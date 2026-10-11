// Reusable CDN interception for headless runs (OCR bench, E2E tests).
//
// The app loads its heavy runtime pieces from CDNs (jsDelivr, tessdata,
// EmulatorJS). Those hosts are unreachable in CI/sandboxes, and even when
// they are reachable a benchmark should not depend on whatever version a CDN
// resolves today. This module installs a Playwright route handler that serves
// local equivalents from node_modules (or a download cache) for every CDN URL
// the app requests, and FAILS LOUDLY (404 + a record in `stats.missing`) for
// any CDN URL it does not know - nothing silently falls through to the
// network.
//
// Usage:
//   import { createCdnRouter } from './lib/routes.mjs';
//   const router = createCdnRouter({ repoRoot, viteOrigin: 'http://127.0.0.1:5173' });
//   await router.install(browserContext);     // or a Page
//   ... after the run: router.stats -> { served, missing, warnings }
//
// ES modules served from jsDelivr '+esm' URLs are answered with a tiny
// re-export module pointing at a shim under bench/lib/shims/ on the Vite dev
// server, so Vite resolves the real package from node_modules (pre-bundled
// via optimizeDeps - see VITE_OPTIMIZE_DEPS below).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// packages the shims import; pass to Vite's optimizeDeps.include so Vite
// pre-bundles them at startup instead of discovering them mid-run (a
// mid-run discovery triggers a full page reload)
export const VITE_OPTIMIZE_DEPS = ['@paddleocr/paddleocr-js', 'nspell'];

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.dic': 'text/plain; charset=utf-8',
  '.aff': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
  '.data': 'application/octet-stream',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

// tessdata flavours the app may request -> upstream GitHub repo + tag
const TESSDATA_UPSTREAM = {
  '4.0.0_best': 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/4.0.0/',
  '4.0.0_fast': 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.0.0/',
  '4.0.0': 'https://raw.githubusercontent.com/tesseract-ocr/tessdata/4.0.0/'
};

const CDN_HOSTS = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|tessdata\.projectnaptha\.com|cdn\.emulatorjs\.org|esm\.sh)\//;

function readPkgVersion(repoRoot, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch { return null; }
}

// "5" matches 5.1.1, "v5.1.1" and "5.1.1" match exactly, "2" matches 2.x
function versionMatches(requested, installed) {
  if (!requested || !installed) return false;
  const req = requested.replace(/^v/, '');
  if (req === installed) return true;
  const parts = req.split('.');
  return installed.split('.').slice(0, parts.length).join('.') === req;
}

export function createCdnRouter(opts) {
  const {
    repoRoot,
    viteOrigin,
    cacheDir = path.join(repoRoot, 'bench', '.cache'),
    log = () => {},
    // optional: directory holding an EmulatorJS "data/" tree (loader.js,
    // emulator.min.js, cores/...) to answer cdn.emulatorjs.org/stable/data/*
    emulatorjsDataDir = null,
    // allow downloading missing tessdata from GitHub into cacheDir
    allowDownload = true,
    // extra [regex, async (match, url) => response|null] rules, tried first
    extraRules = []
  } = opts;
  if (!repoRoot) throw new Error('createCdnRouter: repoRoot is required');
  if (!viteOrigin) throw new Error('createCdnRouter: viteOrigin is required');

  const nm = path.join(repoRoot, 'node_modules');
  const stats = { served: [], missing: [], warnings: [], tessdata: {} };
  const warnOnce = new Set();
  const warn = (msg) => {
    if (warnOnce.has(msg)) return;
    warnOnce.add(msg);
    stats.warnings.push(msg);
    log('[routes] WARNING ' + msg);
  };

  const fileResponse = (file) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return { status: 200, body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'application/octet-stream', file };
  };
  const jsModule = (code) => ({ status: 200, body: Buffer.from(code), contentType: MIME['.js'] });

  const checkVersion = (pkg, requested) => {
    const installed = readPkgVersion(repoRoot, pkg);
    if (!installed) { warn(`${pkg} is not installed (requested ${requested})`); return; }
    if (!versionMatches(requested, installed)) {
      warn(`${pkg}: app requests ${requested} from the CDN but node_modules has ${installed} - serving ${installed}`);
    }
  };

  async function tessdata(flavour, lang) {
    const dir = path.join(cacheDir, 'tessdata', flavour);
    const file = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(file)) { stats.tessdata[lang] = flavour; return fileResponse(file); }
    const upstream = TESSDATA_UPSTREAM[flavour];
    if (allowDownload && upstream) {
      try {
        log(`[routes] downloading ${flavour}/${lang}.traineddata from GitHub (cached in ${path.relative(repoRoot, dir)})`);
        const res = await fetch(upstream + `${lang}.traineddata`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const raw = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, zlib.gzipSync(raw, { level: 6 }));
        stats.tessdata[lang] = flavour;
        return fileResponse(file);
      } catch (e) {
        warn(`could not download ${flavour}/${lang}.traineddata (${e.message})`);
      }
    }
    // offline fallback: @tesseract.js-data/<lang> ships 4.0.0 (legacy+LSTM
    // integer) and 4.0.0_best_int - NOT the float 4.0.0_best the app uses
    for (const alt of ['4.0.0_best_int', '4.0.0']) {
      const f = path.join(nm, '@tesseract.js-data', lang, alt, `${lang}.traineddata.gz`);
      if (fs.existsSync(f)) {
        warn(`tessdata ${flavour}/${lang} unavailable - substituting @tesseract.js-data/${lang} ${alt} (different model flavour than the app uses)`);
        stats.tessdata[lang] = alt + ' (substitute)';
        return fileResponse(f);
      }
    }
    return null;
  }

  // rules: [regex, async (match, url) => response | null]
  const rules = [
    ...extraRules,
    // PaddleOCR SDK as an ES module (the app imports '<pkg>@0.4.2/+esm')
    [/^https:\/\/cdn\.jsdelivr\.net\/npm\/@paddleocr\/paddleocr-js@([^/]+)\/\+esm$/, async (m) => {
      checkVersion('@paddleocr/paddleocr-js', m[1]);
      return jsModule(`export * from ${JSON.stringify(viteOrigin + '/bench/lib/shims/paddleocr-js.js')};\n`);
    }],
    // nspell (spell correction) as an ES module
    [/^https:\/\/cdn\.jsdelivr\.net\/npm\/nspell@([^/]+)\/\+esm$/, async (m) => {
      checkVersion('nspell', m[1]);
      return jsModule(`export { default } from ${JSON.stringify(viteOrigin + '/bench/lib/shims/nspell.js')};\n`);
    }],
    // onnxruntime-web runtime files (wasmPaths)
    [/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@([^/]+)\/dist\/([^?#]+)/, async (m) => {
      checkVersion('onnxruntime-web', m[1]);
      return fileResponse(path.join(nm, 'onnxruntime-web', 'dist', m[2]));
    }],
    // tesseract.js main script + worker
    [/^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@([^/]+)\/dist\/([^?#]+)/, async (m) => {
      checkVersion('tesseract.js', m[1]);
      return fileResponse(path.join(nm, 'tesseract.js', 'dist', m[2]));
    }],
    // tesseract.js-core (wasm build loaded by the worker via importScripts)
    [/^https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js-core@([^/]+)\/([^?#]+)/, async (m) => {
      checkVersion('tesseract.js-core', m[1]);
      return fileResponse(path.join(nm, 'tesseract.js-core', m[2]));
    }],
    // Hunspell dictionaries (correct.js)
    [/^https:\/\/cdn\.jsdelivr\.net\/npm\/(dictionary-[a-z]{2})@([^/]+)\/(index\.(?:dic|aff))$/, async (m) => {
      checkVersion(m[1], m[2]);
      return fileResponse(path.join(nm, m[1], m[3]));
    }],
    // tessdata
    [/^https:\/\/tessdata\.projectnaptha\.com\/([^/]+)\/([a-z_]+)\.traineddata(\.gz)?$/, async (m) => {
      const res = await tessdata(m[1], m[2]);
      if (res && !m[3]) {
        // uncompressed request (gzip:false) - inflate the cached .gz
        return { ...res, body: zlib.gunzipSync(res.body), contentType: 'application/octet-stream' };
      }
      return res;
    }],
    // EmulatorJS data tree
    [/^https:\/\/cdn\.emulatorjs\.org\/[^/]+\/data\/([^?#]+)/, async (m) => {
      if (!emulatorjsDataDir) return null;
      return fileResponse(path.join(emulatorjsDataDir, m[1]));
    }]
  ];

  async function handler(route) {
    const url = route.request().url();
    for (const [re, fn] of rules) {
      const m = url.match(re);
      if (!m) continue;
      let res = null;
      try { res = await fn(m, url); } catch (e) { warn(`rule error for ${url}: ${e.message}`); }
      if (res) {
        stats.served.push(url);
        return route.fulfill({
          status: res.status || 200,
          body: res.body,
          contentType: res.contentType,
          headers: {
            'access-control-allow-origin': '*',
            'cross-origin-resource-policy': 'cross-origin',
            'cache-control': 'no-store'
          }
        });
      }
      break;
    }
    stats.missing.push(url);
    log('[routes] NO LOCAL EQUIVALENT for ' + url + ' -> 404');
    return route.fulfill({ status: 404, body: 'bench/lib/routes.mjs: no local equivalent for ' + url, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' } });
  }

  return {
    stats,
    handler,
    pattern: CDN_HOSTS,
    // target: a Playwright BrowserContext (preferred - also covers workers)
    // or a Page
    async install(target) { await target.route(CDN_HOSTS, handler); }
  };
}
