// Emulingo service worker. build/sw-plugin.js writes dist/sw.js from this
// file, replacing self.__EMULINGO_SW_MANIFEST__ with the build's manifest:
//   { build, version, precache: [path], heavy: [path], models: { path: hash },
//     cdnLimits: { entries, bytes } }
// (paths relative to the app's folder). Classic script, no imports.
//
// Caches (all prefixed "emulingo-", which Settings › Erase everything clears):
//  - emulingo-shell-<scope>-<version>: the app shell, precached on install so
//    the app opens offline after the first visit. Only older shell caches of
//    this same app are deleted, never other apps' caches on a shared origin
//    (e.g. <user>.github.io).
//  - emulingo-models-v1: OCR models and runtimes (tens of MB), cached on first
//    use. Hashed or versioned URLs, so an update is a new entry; stale ones
//    are dropped when a new version activates.
//  - emulingo-cdn-v1: exact-version EmulatorJS and dictionary files, size-
//    capped and evicted least recently used first.
// Translation requests are never touched. Updates wait for the page to ask
// ({type:'SKIP_WAITING'}), so a running game is never swapped out mid-play.

const MANIFEST = self.__EMULINGO_SW_MANIFEST__ || { build: 'dev', version: 'dev', precache: [], heavy: [], models: {} };

const BASE = new URL('./', self.location.href);
const SCOPE_ID = hash(BASE.pathname);
const SHELL_PREFIX = `emulingo-shell-${SCOPE_ID}-`;
const SHELL_CACHE = SHELL_PREFIX + MANIFEST.version;
const MODELS_CACHE = 'emulingo-models-v1';
const CDN_CACHE = 'emulingo-cdn-v1';
// the v1 worker kept everything in one network-first cache
const LEGACY_CACHES = ['emulingo-v1', 'emulingo-v2'];

const NAV_TIMEOUT_MS = 3000;
const CDN_LIMITS = MANIFEST.cdnLimits || { entries: 60, bytes: 64 * 1024 * 1024 };

const INDEX_URL = abs('index.html');
// LRU book-keeping lives in the CDN cache itself, under a key no request
// can ever match; shared by every copy of the app on this origin, like the cache
const LRU_KEY = 'https://emulingo.invalid/cdn-lru.json';
const PRECACHE = new Set(MANIFEST.precache);
const HEAVY = new Set(MANIFEST.heavy);
const MATCH = { ignoreVary: true };

// Only exact versions: a cache-first copy of a moving URL ('stable', '@2')
// would never update. Language data from tessdata.projectnaptha.com is left
// alone: tesseract.js already keeps it in IndexedDB.
const CDN_RULES = [
  { host: 'cdn.emulatorjs.org', path: /^\/\d+\.\d+\.\d+\/data\//, cache: CDN_CACHE },
  { host: 'cdn.jsdelivr.net', path: /^\/npm\/dictionary-[a-z-]+@\d+\.\d+\.\d+\//, cache: CDN_CACHE },
  // the Japanese/Chinese recogniser, published under a release folder
  { host: 'paddle-model-ecology.bj.bcebos.com', path: /^\/paddlex\/official_inference_model\/paddle\d+\.\d+\.\d+\/[\w.-]+\.tar$/, cache: MODELS_CACHE },
];

function abs(path) {
  return new URL(path, BASE).href;
}

// FNV-1a: a short, stable id for this app's folder
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

function modelKey(path) {
  return abs(`${path}?v=${MANIFEST.models[path]}`);
}

// Storage can be unavailable (private mode, quota, blocked site data):
// requests must still reach the network.
async function openCache(name) {
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}

async function cached(cache, key) {
  if (!cache) return undefined;
  try {
    return await cache.match(key, MATCH);
  } catch {
    return undefined;
  }
}

function storable(res) {
  return !!res && res.status === 200 && (res.type === 'basic' || res.type === 'cors' || res.type === 'default');
}

function timeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---- install / activate -------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 'reload' skips the HTTP cache: hosts like GitHub Pages cache index.html
    // for minutes, and a stale one would point at assets that no longer exist
    await cache.addAll(MANIFEST.precache.map((path) => new Request(abs(path), { cache: 'reload' })));
    // No skipWaiting here, not even over the v1 worker: the v1 worker is
    // network-first, so the page it serves online is already this version,
    // and that page offers "Reload". Activating by itself would leave the
    // page's update prompt with a Reload button that does nothing.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => (name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE) || LEGACY_CACHES.includes(name))
      .map((name) => caches.delete(name)));
    await pruneModels().catch(() => {});
    await reconcileCdn().catch(() => {});
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Same-origin model and runtime files this build doesn't use any more.
async function pruneModels() {
  const cache = await openCache(MODELS_CACHE);
  if (!cache) return;
  const keep = new Set([...MANIFEST.heavy.map(abs), ...Object.keys(MANIFEST.models).map(modelKey)]);
  for (const req of await cache.keys()) {
    if (req.url.startsWith(BASE.href) && !keep.has(req.url)) await cache.delete(req);
  }
}

// ---- fetch routing ------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const handler = route(event.request);
  if (handler) event.respondWith(handler(event));
});

function route(request) {
  if (request.method !== 'GET' || request.headers.has('range')) return null;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.origin === self.location.origin) {
    // other apps may live on the same origin (<user>.github.io/<other>/)
    if (!url.pathname.startsWith(BASE.pathname)) return null;
    const path = url.pathname.slice(BASE.pathname.length);
    if (request.mode === 'navigate') return path === '' || path === 'index.html' ? navigate : null;
    if (path === 'sw.js') return null;
    if (Object.prototype.hasOwnProperty.call(MANIFEST.models, path)) return (e) => cacheFirst(e, MODELS_CACHE, modelKey(path));
    // keyed without the query, the way pruneModels() matches them
    if (HEAVY.has(path)) return (e) => cacheFirst(e, MODELS_CACHE, abs(path));
    if (path.endsWith('.wasm')) return (e) => cacheFirst(e, MODELS_CACHE);
    if (PRECACHE.has(path) || path.startsWith('assets/')) return (e) => cacheFirst(e, SHELL_CACHE);
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const rule = CDN_RULES.find((r) => r.host === url.hostname && r.path.test(url.pathname));
  if (!rule) return null;
  return rule.cache === CDN_CACHE ? cdn : (e) => cacheFirst(e, rule.cache);
}

// Network first so a new deploy shows up on the next visit, but never wait
// more than 3 s on a bad connection when the shell is already on disk.
async function navigate(event) {
  const cache = await openCache(SHELL_CACHE);
  const shell = await cached(cache, INDEX_URL);
  const network = Promise.resolve(event.preloadResponse).then((res) => res || fetch(event.request));
  if (!shell) return network;
  event.waitUntil(network.then(() => {}, () => {}));
  try {
    const res = await timeout(network, NAV_TIMEOUT_MS);
    return res.ok || res.type === 'opaqueredirect' ? res : shell;
  } catch {
    return shell;
  }
}

async function cacheFirst(event, cacheName, key = event.request.url) {
  const cache = await openCache(cacheName);
  const hit = await cached(cache, key);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (cache && storable(res)) event.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

// ---- CDN cache (least recently used first out) ----------------------------------

async function cdn(event) {
  const request = event.request;
  const url = request.url;
  const cache = await openCache(CDN_CACHE);
  const hit = await cached(cache, url);
  if (hit) {
    event.waitUntil(touch(cache, url).catch(() => {}));
    return hit;
  }
  let res;
  if (request.mode === 'no-cors') {
    // <script> and <link> tags fetch without CORS, and an opaque response
    // can't be stored safely; the CDN sends CORS headers, so ask for them.
    try {
      res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    } catch {
      return fetch(request);
    }
  } else {
    res = await fetch(request);
  }
  if (cache && res.status === 200 && res.type === 'cors') event.waitUntil(store(cache, url, res.clone()).catch(() => {}));
  return res;
}

// One index update at a time: concurrent requests would lose each other's writes.
let lruQueue = Promise.resolve();
function withIndex(cache, fn) {
  const run = lruQueue.then(async () => {
    const res = await cached(cache, LRU_KEY);
    let index = {};
    try {
      index = res ? await res.json() : {};
    } catch { /* corrupt: rebuilt below */ }
    if ((await fn(index)) === false) return;
    await cache.put(LRU_KEY, new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json' } }));
  });
  lruQueue = run.catch(() => {});
  return run;
}

async function store(cache, url, res) {
  const size = (await res.clone().blob()).size;
  if (size > CDN_LIMITS.bytes) return;
  await cache.put(url, res);
  await withIndex(cache, async (index) => {
    index[url] = { size, at: Date.now() };
    await evict(cache, index, url);
  });
}

function touch(cache, url) {
  return withIndex(cache, (index) => {
    if (!index[url]) return false;
    index[url].at = Date.now();
  });
}

async function evict(cache, index, keep) {
  const entries = Object.entries(index).sort((a, b) => a[1].at - b[1].at);
  let bytes = entries.reduce((sum, [, e]) => sum + (e.size || 0), 0);
  let count = entries.length;
  for (const [url, entry] of entries) {
    if (count <= CDN_LIMITS.entries && bytes <= CDN_LIMITS.bytes) break;
    if (url === keep) continue;
    await cache.delete(url);
    delete index[url];
    bytes -= entry.size || 0;
    count--;
  }
}

// The index can miss entries if the worker was stopped between a write and
// its book-keeping; bring both back in line.
async function reconcileCdn() {
  const cache = await openCache(CDN_CACHE);
  if (!cache) return;
  const urls = (await cache.keys()).map((req) => req.url).filter((url) => url !== LRU_KEY);
  await withIndex(cache, async (index) => {
    const present = new Set(urls);
    for (const url of Object.keys(index)) if (!present.has(url)) delete index[url];
    for (const url of urls) {
      if (index[url]) continue;
      const res = await cached(cache, url);
      index[url] = { size: res ? (await res.blob()).size : 0, at: 0 };
    }
    await evict(cache, index);
  });
}
