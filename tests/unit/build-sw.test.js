// @vitest-environment node
// The service worker (build/sw.js) runs in a vm context with a fake Cache
// Storage and network, both as source and as the minified dist/sw.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformWithEsbuild } from 'vite';
import { SW_SOURCE, renderServiceWorker } from '../../build/sw-plugin.js';

const ORIGIN = 'https://user.github.io';
const BASE = `${ORIGIN}/spritespeak/`;
const MANIFEST = {
  build: 'abc1234',
  version: 'abc1234-0123456789',
  precache: ['index.html', 'manifest.webmanifest', 'icons/icon.svg', 'assets/index-AAAA.js', 'assets/index-BBBB.css'],
  heavy: ['assets/ort-wasm-simd-threaded-CCCC.wasm', 'assets/tesseract-core-simd-lstm.wasm-DDDD.js'],
  models: { 'models/det.tar': 'd1d1d1d1d1d1', 'models/rec.tar': 'r1r1r1r1r1r1' },
  cdnLimits: { entries: 3, bytes: 1000 },
};
const SOURCE = fs.readFileSync(SW_SOURCE, 'utf8');
const EJS = 'https://cdn.emulatorjs.org/4.2.3/data/';
const LRU_KEY = 'https://emulingo.invalid/cdn-lru.json';

// ---- fakes ----------------------------------------------------------------------

class FakeCache {
  constructor(storage) { this.storage = storage; this.map = new Map(); }
  static key(r) { return typeof r === 'string' ? r : r.url; }
  async match(r) {
    const hit = this.map.get(FakeCache.key(r));
    return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
  }
  async put(r, res) {
    if (this.storage.full) throw new Error('QuotaExceededError');
    const body = await res.arrayBuffer();
    this.map.set(FakeCache.key(r), { body, status: res.status, headers: [...res.headers] });
  }
  async delete(r) { return this.map.delete(FakeCache.key(r)); }
  async keys() { return [...this.map.keys()].map((u) => new Request(u)); }
  async addAll(requests) {
    const got = [];
    for (const req of requests) {
      const res = await this.storage.net(req);
      if (!res.ok) throw new TypeError(`addAll: ${req.url} ${res.status}`);
      got.push([req, res]);
    }
    for (const [req, res] of got) await this.put(req, res);
  }
}

class FakeStorage {
  constructor(net) { this.net = net; this.caches = new Map(); this.full = false; this.broken = false; }
  async open(name) {
    if (this.broken) throw new Error('SecurityError');
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache(this));
    return this.caches.get(name);
  }
  async has(name) { return this.caches.has(name); }
  async delete(name) { return this.caches.delete(name); }
  async keys() { return [...this.caches.keys()]; }
  urls(name) { return [...(this.caches.get(name)?.map.keys() || [])]; }
}

// routes: { url: { status, body, type, delay } | 'offline' }
function createNet(routes) {
  const calls = [];
  const net = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, mode: init.mode || input.mode, credentials: init.credentials, cache: input.cache });
    const r = routes[url];
    if (r === 'offline' || net.offline) throw new TypeError('Failed to fetch');
    if (r?.delay) await new Promise((resolve) => setTimeout(resolve, r.delay));
    const res = new Response(r ? r.body ?? `body of ${url}` : 'not found', { status: r ? r.status ?? 200 : 404 });
    const type = r?.type || (url.startsWith(ORIGIN) ? 'basic' : init.mode === 'cors' || input.mode === 'cors' ? 'cors' : 'opaque');
    Object.defineProperty(res, 'type', { value: type });
    return res;
  };
  net.calls = calls;
  net.offline = false;
  return net;
}

function load({ code = SOURCE, manifest = MANIFEST, routes = {}, scope = BASE, wrapFetch = (f) => f } = {}) {
  const net = createNet(routes);
  const storage = new FakeStorage(net);
  const listeners = {};
  const self = {
    location: new URL('sw.js', scope),
    registration: { navigationPreload: { enable: vi.fn(async () => {}) } },
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    __SPRITESPEAK_SW_MANIFEST__: manifest,
  };
  const context = vm.createContext({
    self, caches: storage, fetch: wrapFetch(net), Request, Response, Headers, URL, console,
    // looked up late so vi.useFakeTimers() applies
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t),
  });
  vm.runInContext(code, context, { filename: 'sw.js' });

  async function lifecycle(type, extra = {}) {
    const waits = [];
    listeners[type]({ ...extra, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  }
  // Returns { handled, response, settled }: settled waits for waitUntil work too.
  function request(url, { mode = 'no-cors', method = 'GET', headers = {}, preload } = {}) {
    let responded = null;
    const waits = [];
    const req = { url, mode, method, headers: new Headers(headers), cache: 'default' };
    listeners.fetch({
      request: req,
      preloadResponse: preload,
      respondWith: (p) => { responded = Promise.resolve(p); },
      waitUntil: (p) => waits.push(p),
    });
    const settled = (async () => {
      if (responded) await responded.catch(() => {});
      let n;
      do { n = waits.length; await Promise.allSettled(waits); } while (n !== waits.length);
    })();
    return { handled: !!responded, response: responded, settled };
  }
  return { self, storage, net, listeners, lifecycle, request };
}

const allOk = (urls) => Object.fromEntries(urls.map((u) => [u, { status: 200 }]));
const shellRoutes = () => allOk(MANIFEST.precache.map((p) => BASE + p));
const shellName = (sw) => [...sw.storage.caches.keys()].find((n) => n.startsWith('emulingo-shell-'));

// ---- tests --------------------------------------------------------------------------

describe('install', () => {
  it('precaches the shell from the network, bypassing the HTTP cache', async () => {
    const sw = load({ routes: shellRoutes() });
    await sw.lifecycle('install');
    const name = shellName(sw);
    expect(name).toMatch(/^emulingo-shell-[0-9a-f]{6}-abc1234-0123456789$/);
    expect(sw.storage.urls(name).sort()).toEqual(MANIFEST.precache.map((p) => BASE + p).sort());
    expect(sw.net.calls.every((c) => c.cache === 'reload')).toBe(true);
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('fails when a shell file is missing, so a broken deploy never activates', async () => {
    const routes = shellRoutes();
    delete routes[BASE + 'assets/index-AAAA.js'];
    const sw = load({ routes });
    await expect(sw.lifecycle('install')).rejects.toThrow(/index-AAAA/);
  });

  it('waits for the page even when replacing the v1 worker', async () => {
    // the page's update prompt is what activates it; activating by itself
    // would leave that prompt with a dead Reload button
    const sw = load({ routes: shellRoutes() });
    await sw.storage.open('emulingo-v2');
    await sw.lifecycle('install');
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    expect(await sw.storage.has('emulingo-v2')).toBe(true);
  });
});

describe('activate', () => {
  it('deletes only this app’s older shells and the v1 caches', async () => {
    const sw = load({ routes: shellRoutes() });
    await sw.lifecycle('install');
    const current = shellName(sw);
    const older = current.replace(/abc1234-0123456789$/, 'old0000-ffffffffff');
    const otherScope = 'emulingo-shell-ffffff-abc1234-0123456789';
    for (const n of [older, otherScope, 'emulingo-v1', 'emulingo-v2', 'other-app-v3', 'emulingo-cdn-v1']) await sw.storage.open(n);
    await sw.lifecycle('activate');
    const names = await sw.storage.keys();
    expect(names).toContain(current);
    expect(names).toContain(otherScope);
    expect(names).toContain('other-app-v3');
    expect(names).toContain('emulingo-cdn-v1');
    expect(names).not.toContain(older);
    expect(names).not.toContain('emulingo-v1');
    expect(names).not.toContain('emulingo-v2');
    expect(sw.self.registration.navigationPreload.enable).toHaveBeenCalled();
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });

  it('drops model and runtime files this build no longer uses', async () => {
    const sw = load();
    const models = await sw.storage.open('emulingo-models-v1');
    const keep = [BASE + 'models/det.tar?v=d1d1d1d1d1d1', BASE + 'assets/ort-wasm-simd-threaded-CCCC.wasm'];
    const drop = [BASE + 'models/det.tar?v=000000000000', BASE + 'assets/ort-wasm-simd-threaded-OLD.wasm'];
    const remote = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/x.tar';
    const elsewhere = `${ORIGIN}/other-app/model.wasm`;
    for (const u of [...keep, ...drop, remote, elsewhere]) await models.put(u, new Response('m'));
    await sw.lifecycle('activate');
    expect(sw.storage.urls('emulingo-models-v1').sort()).toEqual([...keep, remote, elsewhere].sort());
  });
});

describe('navigation', () => {
  let sw;
  beforeEach(async () => {
    sw = load({ routes: shellRoutes() });
    await sw.lifecycle('install');
    sw.net.calls.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('uses the network when it answers', async () => {
    sw = load({ routes: { ...shellRoutes(), [BASE]: { status: 200 } } });
    await sw.lifecycle('install');
    const r = sw.request(BASE, { mode: 'navigate' });
    expect(r.handled).toBe(true);
    expect(await (await r.response).text()).toBe(`body of ${BASE}`);
  });

  it('prefers the navigation preload response', async () => {
    const r = sw.request(BASE, { mode: 'navigate', preload: Promise.resolve(new Response('preloaded')) });
    expect(await (await r.response).text()).toBe('preloaded');
    expect(sw.net.calls).toHaveLength(0);
  });

  it('falls back to the cached shell when the preload request fails', async () => {
    const preload = Promise.reject(new TypeError('Failed to fetch'));
    preload.catch(() => {});
    const r = sw.request(BASE, { mode: 'navigate', preload });
    expect(await (await r.response).text()).toBe(`body of ${BASE}index.html`);
    await r.settled;
  });

  it('falls back to the cached shell offline, also for index.html and ?query', async () => {
    sw.net.offline = true;
    for (const url of [BASE, BASE + 'index.html', BASE + '?debug=1']) {
      const r = sw.request(url, { mode: 'navigate' });
      expect(await (await r.response).text()).toBe(`body of ${BASE}index.html`);
    }
  });

  it('gives up on a slow network after 3 s', async () => {
    vi.useFakeTimers();
    sw = load({ routes: { ...shellRoutes(), [BASE]: { status: 200, body: 'late', delay: 10000 } } });
    await sw.lifecycle('install');
    const r = sw.request(BASE, { mode: 'navigate' });
    let done = false;
    r.response.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(2900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await (await r.response).text()).toBe(`body of ${BASE}index.html`);
    await vi.advanceTimersByTimeAsync(10000);
    await r.settled;
  });

  it('serves the shell instead of a server error', async () => {
    sw = load({ routes: { ...shellRoutes(), [BASE]: { status: 503 } } });
    await sw.lifecycle('install');
    expect((await sw.request(BASE, { mode: 'navigate' }).response).status).toBe(200);
  });

  it('leaves other pages and other apps on the origin alone', () => {
    expect(sw.request(BASE + 'docs/page.html', { mode: 'navigate' }).handled).toBe(false);
    expect(sw.request(`${ORIGIN}/other-app/`, { mode: 'navigate' }).handled).toBe(false);
  });

  it('passes through when nothing is cached yet', async () => {
    const fresh = load({ routes: { [BASE]: { status: 200, body: 'net' } } });
    expect(await (await fresh.request(BASE, { mode: 'navigate' }).response).text()).toBe('net');
  });
});

describe('same-origin files', () => {
  it('serves hashed assets from the shell cache without the network', async () => {
    const sw = load({ routes: shellRoutes() });
    await sw.lifecycle('install');
    sw.net.calls.length = 0;
    sw.net.offline = true;
    const r = sw.request(BASE + 'assets/index-AAAA.js', { mode: 'cors' });
    expect(await (await r.response).text()).toBe(`body of ${BASE}assets/index-AAAA.js`);
    expect(sw.net.calls).toHaveLength(0);
  });

  it('stores a missed hashed asset in the shell cache', async () => {
    const url = BASE + 'assets/late-EEEE.js';
    const sw = load({ routes: { ...shellRoutes(), [url]: { status: 200 } } });
    await sw.lifecycle('install');
    const r = sw.request(url, { mode: 'cors' });
    await r.settled;
    expect(sw.storage.urls(shellName(sw))).toContain(url);
  });

  it('never stores error responses', async () => {
    const sw = load({ routes: shellRoutes() });
    await sw.lifecycle('install');
    const r = sw.request(BASE + 'assets/gone-FFFF.js', { mode: 'cors' });
    expect((await r.response).status).toBe(404);
    await r.settled;
    expect(sw.storage.urls(shellName(sw))).not.toContain(BASE + 'assets/gone-FFFF.js');
  });

  it('keeps models under a content-versioned key and runtimes in the models cache', async () => {
    const det = BASE + 'models/det.tar';
    const wasm = BASE + MANIFEST.heavy[0];
    const sw = load({ routes: allOk([det, wasm]) });
    await sw.request(det, { mode: 'cors' }).settled;
    await sw.request(wasm, { mode: 'cors' }).settled;
    expect(sw.storage.urls('emulingo-models-v1').sort()).toEqual([det + '?v=d1d1d1d1d1d1', wasm].sort());
    sw.net.calls.length = 0;
    sw.net.offline = true;
    expect((await sw.request(det, { mode: 'cors' }).response).status).toBe(200);
    expect(sw.net.calls).toHaveLength(0);
  });

  it('keys runtimes without their query, so a new build keeps them', async () => {
    const wasm = BASE + MANIFEST.heavy[0];
    const sw = load({ routes: allOk([`${wasm}?v=1`]) });
    await sw.request(`${wasm}?v=1`, { mode: 'cors' }).settled;
    expect(sw.storage.urls('emulingo-models-v1')).toEqual([wasm]);
    await sw.lifecycle('activate');
    expect(sw.storage.urls('emulingo-models-v1')).toEqual([wasm]);
    sw.net.offline = true;
    expect((await sw.request(`${wasm}?v=2`, { mode: 'cors' }).response).status).toBe(200);
  });

  it('ignores sw.js, other apps, non-GET and range requests', () => {
    const sw = load();
    expect(sw.request(BASE + 'sw.js').handled).toBe(false);
    expect(sw.request(`${ORIGIN}/other-app/assets/x.js`).handled).toBe(false);
    expect(sw.request(BASE + 'assets/index-AAAA.js', { method: 'POST' }).handled).toBe(false);
    expect(sw.request(BASE + 'models/det.tar', { headers: { range: 'bytes=0-9' } }).handled).toBe(false);
  });

  it('still reaches the network when Cache Storage is unavailable', async () => {
    const url = BASE + 'assets/index-AAAA.js';
    const sw = load({ routes: allOk([url]) });
    sw.storage.broken = true;
    expect((await sw.request(url, { mode: 'cors' }).response).status).toBe(200);
  });

  it('survives a full disk', async () => {
    const url = BASE + 'models/rec.tar';
    const sw = load({ routes: allOk([url]) });
    sw.storage.full = true;
    const r = sw.request(url, { mode: 'cors' });
    expect((await r.response).status).toBe(200);
    await r.settled;
  });
});

describe('third-party requests', () => {
  it('never touches translation services or unpinned CDN paths', () => {
    const sw = load();
    for (const url of [
      'https://translate.googleapis.com/translate_a/single?client=gtx&q=Hallo',
      'https://clients5.google.com/translate_a/t?q=Hallo',
      'https://api.mymemory.translated.net/get?q=Hallo',
      'https://tessdata.projectnaptha.com/4.0.0_best/deu.traineddata.gz',
      'https://cdn.emulatorjs.org/stable/data/loader.js',
      'https://cdn.jsdelivr.net/npm/dictionary-de@latest/index.dic',
      'https://cdn.jsdelivr.net/npm/nspell@2.1.5/index.js',
      'https://evil.example/cdn.emulatorjs.org/4.2.3/data/loader.js',
      'http://cdn.emulatorjs.org/4.2.3/data/loader.js',
    ]) expect(sw.request(url).handled, url).toBe(false);
  });

  it('upgrades EmulatorJS script loads to CORS so they can be cached', async () => {
    const url = EJS + 'loader.js';
    const sw = load({ routes: { [url]: { status: 200, body: 'loader' } } });
    const r = sw.request(url, { mode: 'no-cors' });
    expect(await (await r.response).text()).toBe('loader');
    expect(sw.net.calls[0]).toMatchObject({ mode: 'cors', credentials: 'omit' });
    await r.settled;
    expect(sw.storage.urls('emulingo-cdn-v1')).toContain(url);
    sw.net.calls.length = 0;
    sw.net.offline = true;
    expect(await (await sw.request(url).response).text()).toBe('loader');
  });

  it('falls back to a plain load when the CORS request fails', async () => {
    const url = EJS + 'emulator.min.css';
    // a CDN that stops sending CORS headers: the cors request fails, the plain one works
    const sw = load({
      routes: { [url]: { status: 200, type: 'opaque' } },
      wrapFetch: (net) => async (input, init) => {
        if (init?.mode === 'cors') throw new TypeError('CORS');
        return net(input, init);
      },
    });
    const r = sw.request(url, { mode: 'no-cors' });
    expect((await r.response).type).toBe('opaque');
    await r.settled;
    expect(sw.storage.urls('emulingo-cdn-v1')).toEqual([]);
  });

  it('caches pinned dictionaries and the remote recogniser, but not opaque or failed responses', async () => {
    const dic = 'https://cdn.jsdelivr.net/npm/dictionary-de@3.0.0/index.dic';
    const missing = 'https://cdn.jsdelivr.net/npm/dictionary-fr@3.0.0/index.aff';
    const cjk = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar';
    const sw = load({ routes: { [dic]: { status: 200 }, [missing]: { status: 404 }, [cjk]: { status: 200 } } });
    await sw.request(dic, { mode: 'cors' }).settled;
    await sw.request(missing, { mode: 'cors' }).settled;
    await sw.request(cjk, { mode: 'cors' }).settled;
    expect(sw.storage.urls('emulingo-cdn-v1').filter((u) => u !== LRU_KEY)).toEqual([dic]);
    expect(sw.storage.urls('emulingo-models-v1')).toEqual([cjk]);
  });

  it('evicts the least recently used CDN files past the entry and byte caps', async () => {
    const urls = ['a', 'b', 'c', 'd', 'e'].map((x) => `${EJS}cores/${x}.data`);
    const routes = Object.fromEntries(urls.map((u) => [u, { status: 200, body: 'x'.repeat(100) }]));
    routes[`${EJS}cores/big.data`] = { status: 200, body: 'x'.repeat(1001) };
    routes[`${EJS}cores/half.data`] = { status: 200, body: 'x'.repeat(850) };
    const sw = load({ routes });
    const cached = () => sw.storage.urls('emulingo-cdn-v1').filter((u) => u !== LRU_KEY).sort();
    for (const u of urls.slice(0, 3)) { await sw.request(u, { mode: 'cors' }).settled; await new Promise((r) => setTimeout(r, 2)); }
    await sw.request(urls[0], { mode: 'cors' }).settled; // a is used again
    await new Promise((r) => setTimeout(r, 2));
    await sw.request(urls[3], { mode: 'cors' }).settled; // d pushes out b
    expect(cached()).toEqual([urls[0], urls[2], urls[3]].sort());
    // too big for the cache at all
    await sw.request(`${EJS}cores/big.data`, { mode: 'cors' }).settled;
    expect(cached()).not.toContain(`${EJS}cores/big.data`);
    // 850 + 3 × 100 bytes > 1000: the oldest go until it fits
    await new Promise((r) => setTimeout(r, 2));
    await sw.request(`${EJS}cores/half.data`, { mode: 'cors' }).settled;
    expect(cached()).toEqual([`${EJS}cores/half.data`, urls[3]].sort());
  });

  it('rebuilds a lost LRU index on activate', async () => {
    const sw = load({ manifest: { ...MANIFEST, cdnLimits: { entries: 2, bytes: 1e6 } } });
    const cdn = await sw.storage.open('emulingo-cdn-v1');
    for (const x of ['a', 'b', 'c']) await cdn.put(`${EJS}${x}.js`, new Response('js'));
    await sw.lifecycle('activate');
    const left = sw.storage.urls('emulingo-cdn-v1').filter((u) => u !== LRU_KEY);
    expect(left).toHaveLength(2);
    const index = await (await cdn.match(LRU_KEY)).json();
    expect(Object.keys(index).sort()).toEqual(left.sort());
  });
});

describe('updates', () => {
  it('activates a waiting worker only when the page asks', () => {
    const sw = load();
    sw.listeners.message({ data: { type: 'PING' } });
    sw.listeners.message({ data: null });
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    sw.listeners.message({ data: { type: 'SKIP_WAITING' } });
    expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe('dist/sw.js', () => {
  it('works the same once the manifest is inlined and the code minified', async () => {
    const rendered = renderServiceWorker(SOURCE, MANIFEST);
    const { code } = await transformWithEsbuild(rendered, 'sw.js', { minify: true, target: 'es2020' });
    expect(code).not.toContain('__SPRITESPEAK_SW_MANIFEST__');
    const sw = load({ code, manifest: undefined, routes: shellRoutes() });
    await sw.lifecycle('install');
    expect(sw.storage.urls(shellName(sw))).toHaveLength(MANIFEST.precache.length);
    sw.net.offline = true;
    expect(await (await sw.request(BASE, { mode: 'navigate' }).response).text()).toBe(`body of ${BASE}index.html`);
  });
});
