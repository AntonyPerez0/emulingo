// @vitest-environment node
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { build } from 'vite';
import {
  classify, buildManifest, renderServiceWorker, serviceWorker, serviceWorkerDevReset, listFiles, SW_SOURCE, HEAVY_BYTES, CDN_LIMITS,
  DEV_RESET_WORKER,
} from '../../build/sw-plugin.js';
import { contentSecurityPolicy } from '../../build/csp.js';

const file = (p, size = 10, hash = 'h'.repeat(64)) => ({ path: p, size, hash });

describe('classify', () => {
  it('sorts build output into shell, heavy runtimes and models', () => {
    const out = classify([
      file('index.html'),
      file('manifest.webmanifest'),
      file('icons/icon.svg'),
      file('assets/index-A.js', 140e3),
      file('assets/index-B.css'),
      file('assets/index-A.js.map'),
      file('assets/ort-wasm-simd-threaded-C.wasm', 14e6),
      file('assets/tesseract-core-simd-lstm.wasm-D.js', 3.9e6),
      file('models/det.tar', 4.8e6, 'abcdef0123456789'.repeat(4)),
      file('sw.js'),
    ]);
    expect(out.precache).toEqual(['index.html', 'manifest.webmanifest', 'icons/icon.svg', 'assets/index-A.js', 'assets/index-B.css']);
    expect(out.heavy).toEqual(['assets/ort-wasm-simd-threaded-C.wasm', 'assets/tesseract-core-simd-lstm.wasm-D.js']);
    expect(out.models).toEqual({ 'models/det.tar': 'abcdef012345' });
  });

  it('treats any .wasm as heavy, whatever its size', () => {
    expect(classify([file('assets/tiny.wasm', 100)]).heavy).toEqual(['assets/tiny.wasm']);
    expect(classify([file('assets/a.js', HEAVY_BYTES + 1)]).heavy).toEqual(['assets/a.js']);
  });
});

describe('buildManifest', () => {
  it('versions the shell by its contents, not only by the commit', () => {
    const a = buildManifest([file('index.html', 10, 'a'.repeat(64))], { build: 'abc1234' });
    const b = buildManifest([file('index.html', 10, 'b'.repeat(64))], { build: 'abc1234' });
    expect(a.version).toMatch(/^abc1234-[0-9a-f]{10}$/);
    expect(a.version).not.toBe(b.version);
    expect(a.cdnLimits).toEqual(CDN_LIMITS);
  });

  it('keeps a model change out of the shell version', () => {
    const shell = [file('index.html', 10, 'a'.repeat(64))];
    const a = buildManifest([...shell, file('models/rec.tar', 10, '1'.repeat(64))]);
    const b = buildManifest([...shell, file('models/rec.tar', 10, '2'.repeat(64))]);
    expect(a.version).toBe(b.version);
    expect(a.models['models/rec.tar']).not.toBe(b.models['models/rec.tar']);
  });
});

describe('renderServiceWorker', () => {
  it('inlines the manifest in place of the fallback', () => {
    const src = fs.readFileSync(SW_SOURCE, 'utf8');
    const out = renderServiceWorker(src, { build: 'x', version: 'x-1', precache: ['index.html'], heavy: [], models: {} });
    expect(out).toContain('const MANIFEST = {"build":"x","version":"x-1","precache":["index.html"],"heavy":[],"models":{}};');
    expect(out).not.toMatch(/const MANIFEST = self\./);
    expect(() => new Function(out)).not.toThrow();
  });

  it('refuses a source without the declaration', () => {
    expect(() => renderServiceWorker('const x = 1;', {})).toThrow(/MANIFEST/);
  });
});

describe('in a Vite build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emulingo-sw-plugin-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes sw.js listing the output, public files included, and the CSP on index.html only', async () => {
    fs.mkdirSync(path.join(root, 'public/models'), { recursive: true });
    fs.mkdirSync(path.join(root, 'public/icons'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public/models/m.tar'), 'model');
    fs.writeFileSync(path.join(root, 'public/icons/i.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(root, 'public/big.bin'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(root, 'main.js'), 'document.body.dataset.ok = "1";\n');
    const page = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><script type="module" src="./main.js"></script></body></html>`;
    fs.writeFileSync(path.join(root, 'index.html'), page('App'));
    fs.writeFileSync(path.join(root, 'other.html'), page('Other'));
    const outDir = path.join(root, 'dist');
    await build({
      root,
      base: './',
      configFile: false,
      logLevel: 'silent',
      build: { outDir, rollupOptions: { input: { index: path.join(root, 'index.html'), other: path.join(root, 'other.html') } } },
      plugins: [contentSecurityPolicy(), serviceWorker({ build: 't1', heavyBytes: 1024, minify: false })],
    });
    const sw = fs.readFileSync(path.join(outDir, 'sw.js'), 'utf8');
    const manifest = JSON.parse(sw.match(/^const MANIFEST = (.*);$/m)[1]);
    const files = listFiles(outDir).map((f) => f.path);
    expect(manifest.build).toBe('t1');
    expect(manifest.precache).toEqual(expect.arrayContaining(['index.html', 'other.html', 'icons/i.svg']));
    expect(manifest.precache.some((p) => /^assets\/.+\.js$/.test(p))).toBe(true);
    expect(manifest.heavy).toEqual(['big.bin']);
    expect(Object.keys(manifest.models)).toEqual(['models/m.tar']);
    for (const p of [...manifest.precache, ...manifest.heavy]) expect(files).toContain(p);
    expect(manifest.precache).not.toContain('sw.js');
    expect(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')).toMatch(/<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy"/);
    expect(fs.readFileSync(path.join(outDir, 'other.html'), 'utf8')).not.toContain('Content-Security-Policy');
  }, 30000);

  it('skips builds without the app page', async () => {
    const outDir = path.join(root, 'dist-other');
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      build: { outDir, rollupOptions: { input: { other: path.join(root, 'other.html') } } },
      plugins: [serviceWorker({ minify: false })],
    });
    expect(fs.existsSync(path.join(outDir, 'other.html'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'sw.js'))).toBe(false);
  }, 30000);
});

describe('serviceWorkerDevReset', () => {
  function serve(base = '/') {
    let handler = null;
    serviceWorkerDevReset().configureServer({ config: { base }, middlewares: { use: (fn) => { handler = fn; } } });
    return (url) => {
      const res = { headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
      const next = vi.fn();
      handler({ url }, res, next);
      return { res, next };
    };
  }

  it('runs only on the dev server', () => {
    expect(serviceWorkerDevReset().apply).toBe('serve');
  });

  it('answers sw.js (with or without a query) and nothing else', () => {
    const get = serve();
    for (const url of ['/sw.js', '/sw.js?v=1']) {
      const { res, next } = get(url);
      expect(next).not.toHaveBeenCalled();
      expect(res.body).toBe(DEV_RESET_WORKER);
      expect(res.headers['content-type']).toMatch(/^text\/javascript/);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    for (const url of ['/src/main.js', '/assets/sw.js', '/sw.json', '/']) expect(get(url).next).toHaveBeenCalled();
    expect(serve('/emulingo/')('/emulingo/sw.js').res.body).toBe(DEV_RESET_WORKER);
  });

  it('serves a worker that clears the v1 caches and unregisters itself', async () => {
    const listeners = {};
    const names = new Set(['emulingo-v2', 'emulingo-shell-abcdef-x', 'emulingo-models-v1', 'other-app']);
    const self = {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: vi.fn(),
      registration: { unregister: vi.fn(async () => true) },
    };
    const caches = { keys: async () => [...names], delete: async (n) => names.delete(n) };
    vm.runInContext(DEV_RESET_WORKER, vm.createContext({ self, caches }));
    listeners.install({});
    expect(self.skipWaiting).toHaveBeenCalled();
    const waits = [];
    listeners.activate({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect([...names].sort()).toEqual(['emulingo-models-v1', 'other-app']);
    expect(self.registration.unregister).toHaveBeenCalled();
    expect(listeners.fetch).toBeUndefined();
  });
});
