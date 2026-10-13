// Vite plugin: writes dist/sw.js from build/sw.js once the build is on disk,
// with this build's id and file lists:
//  - precache: the app shell (index.html, hashed JS/CSS, workers, manifest,
//    icons), so the app opens offline after the first visit;
//  - heavy:    runtimes over 1 MB (the ONNX Runtime and Tesseract WebAssembly
//    builds), cached on first use instead, since many people never need them;
//  - models:   public/models/* with a content hash, so a changed model is a new
//    cache entry even though its file name stays the same.
// The dev server answers sw.js with a worker that removes itself instead
// (serviceWorkerDevReset below).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transformWithEsbuild } from 'vite';

export const SW_SOURCE = fileURLToPath(new URL('./sw.js', import.meta.url));
export const SW_FILE = 'sw.js';
export const HEAVY_BYTES = 1024 * 1024;
// EmulatorJS needs about 2 MB per system (scripts, core, its version report)
export const CDN_LIMITS = Object.freeze({ entries: 60, bytes: 64 * 1024 * 1024 });
// the declaration in build/sw.js whose fallback value the manifest replaces
const DECLARATION = /^const MANIFEST = self\.__SPRITESPEAK_SW_MANIFEST__ \|\| .*;$/m;

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Every file under dir as { path (POSIX, relative), size, hash }. */
export function listFiles(dir) {
  const out = [];
  (function walk(sub) {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) {
        const data = fs.readFileSync(path.join(dir, rel));
        out.push({ path: rel, size: data.length, hash: sha(data) });
      }
    }
  })('');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Split build output into precache / heavy / models (see the header). */
export function classify(files, { heavyBytes = HEAVY_BYTES } = {}) {
  const precache = [];
  const heavy = [];
  const models = {};
  for (const f of files) {
    if (f.path === SW_FILE || f.path.endsWith('.map')) continue;
    if (f.path.startsWith('models/')) models[f.path] = f.hash.slice(0, 12);
    else if (f.path.endsWith('.wasm') || f.size > heavyBytes) heavy.push(f.path);
    else precache.push(f.path);
  }
  return { precache, heavy, models };
}

/** The manifest the service worker reads; `version` changes with any shell file. */
export function buildManifest(files, { build = 'dev', heavyBytes = HEAVY_BYTES, cdnLimits = CDN_LIMITS } = {}) {
  const lists = classify(files, { heavyBytes });
  const byPath = new Map(files.map((f) => [f.path, f]));
  const digest = sha(lists.precache.map((p) => `${p}:${byPath.get(p).hash}`).join('\n'));
  return { build, version: `${build}-${digest.slice(0, 10)}`, ...lists, cdnLimits: { ...cdnLimits } };
}

export function renderServiceWorker(source, manifest) {
  if (!DECLARATION.test(source)) throw new Error('build/sw.js must declare `const MANIFEST = self.__SPRITESPEAK_SW_MANIFEST__ || …;`');
  return source.replace(DECLARATION, () => `const MANIFEST = ${JSON.stringify(manifest)};`);
}

// Served as sw.js by the dev server. Version 1 registered its worker in dev
// too, and that network-first worker would otherwise keep controlling
// localhost, re-caching every module (and the 40 MB of OCR files) forever:
// the browser's update check gets the dev server's index.html and keeps the
// old worker. This replacement deletes the v1 caches and unregisters itself.
export const DEV_RESET_WORKER = `// Spritespeak dev server: removes a service worker left by a production build or by version 1.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name === 'emulingo-v1' || name === 'emulingo-v2' || name.startsWith('emulingo-shell-')) await caches.delete(name);
    }
    await self.registration.unregister();
  })());
});
`;

/** Dev-server half of the service worker: answers sw.js with DEV_RESET_WORKER (the app registers nothing in dev). */
export function serviceWorkerDevReset() {
  return {
    name: 'spritespeak:service-worker-dev-reset',
    apply: 'serve',
    configureServer(server) {
      const url = `${server.config.base || '/'}${SW_FILE}`;
      server.middlewares.use((req, res, next) => {
        if ((req.url || '').split('?')[0] !== url) return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(DEV_RESET_WORKER);
      });
    },
  };
}

const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

/**
 * @param {{ build?: string, entry?: string, heavyBytes?: number, cdnLimits?: {entries: number, bytes: number}, minify?: boolean }} opts
 *   entry: the app page that must be in the output (other builds made with
 *   this config, e.g. test pages, get no service worker).
 */
export function serviceWorker({ build = 'dev', entry = 'index.html', heavyBytes = HEAVY_BYTES, cdnLimits = CDN_LIMITS, minify = true } = {}) {
  let logger = null;
  return {
    name: 'spritespeak:service-worker',
    apply: 'build',
    configResolved(config) {
      logger = config.logger;
    },
    writeBundle: {
      sequential: true,
      order: 'post',
      async handler(options) {
        const outDir = options.dir;
        if (!outDir || !fs.existsSync(path.join(outDir, entry))) return;
        const files = listFiles(outDir);
        const manifest = buildManifest(files, { build, heavyBytes, cdnLimits });
        let code = renderServiceWorker(fs.readFileSync(SW_SOURCE, 'utf8'), manifest);
        if (minify) code = (await transformWithEsbuild(code, SW_FILE, { minify: true, target: 'es2020', legalComments: 'none' })).code;
        fs.writeFileSync(path.join(outDir, SW_FILE), code);
        const size = (list) => list.reduce((sum, p) => sum + files.find((f) => f.path === p).size, 0);
        const models = Object.keys(manifest.models);
        logger?.info(
          `\nservice worker: ${SW_FILE} (${kb(code.length)}), shell ${manifest.version}\n` +
          `  precached on install: ${manifest.precache.length} files, ${kb(size(manifest.precache))}\n` +
          `  cached on first use:  ${manifest.heavy.length} runtimes, ${kb(size(manifest.heavy))}; ${models.length} models, ${kb(size(models))}`,
        );
      },
    },
  };
}
