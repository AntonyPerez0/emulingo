// OCR engine: the one place that turns upscaled game text into lines.
//
//   const engine = createOcrEngine({ onStatus });
//   await engine.prepare('de');                         // optional warm-up
//   const { lines, ms, engine: used } = await engine.read(job);
//
// Neural recognition (PP-OCRv5 via onnxruntime-web) runs in a module worker
// (ocr.worker.js); Tesseract is the lazy-loaded fallback. Routing by script:
//   Latin languages   → local det + Latin rec (public/models/*.tar)
//   Japanese, Chinese → local det + PP-OCRv5_mobile_rec downloaded from the
//                       PaddleOCR model CDN, else Tesseract jpn / chi_sim
//   other scripts     → local det boxes + Tesseract line reading
// Neural failures latch with backoff (1 → 5 → 15 min); meanwhile Latin
// languages are read by Tesseract.
//
// Jobs (coordinates in native frame pixels; images already upscaled ×k):
//   { mode: 'lines', strips: [{ img, k, offset }], lang }  → one Line per strip
//   { mode: 'container'|'free', img, k, offset, lang }     → detected lines
// Line = { text, score 0..1, box: { x, y, w, h } (native) }.
// read() TRANSFERS the jobs' pixel buffers to the worker: the ImageData
// objects are detached (data.length 0) once the job starts.
// Only one job runs at a time; a newer queued job replaces an older queued
// one, which then rejects with an AbortError (latest wins). dispose() rejects
// the running and the queued job with an AbortError.

import { langInfo } from '../language.js';
import { toNativeBox, RUNTIME_SIZE } from './models.js';
import { createTesseract } from './tesseract.js';

export { RUNTIME_SIZE }; // onnxruntime-web's WASM, fetched by the worker with the first model

export const MODELS = Object.freeze({
  det: { kind: 'det', file: 'det.tar', size: 4833280 },
  latin: { kind: 'rec', file: 'rec.tar', size: 8058880 },
  // multilingual (Chinese, Japanese, Latin) recogniser; ~16 MB, same CDN the
  // PaddleOCR SDK uses by default
  cjk: {
    kind: 'rec',
    url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar',
    size: 16500000
  }
});

export const BACKOFF_MS = Object.freeze([60000, 300000, 900000]);

// Detection is never downscaled (limit 'max' = the image's own long side):
// at ×3–×4 pixel-font lines are detected whole. Tuned on the OCR bench:
// box 0.5 keeps faint (smoothed) lines, unclip 2.0 gives recognition whole
// glyphs at the box edges (free-mode CER 18.5 % → 16.2 %, no false positives).
export const DET_PARAMS = Object.freeze({ thresh: 0.3, boxThresh: 0.5, unclipRatio: 2.0 });
// same-row det boxes are merged before recognition (see models.mergeLineBoxes)
export const MERGE_OPTS = Object.freeze({ minOverlap: 0.5, maxGap: 1.5, minHeightRatio: 0.5 });
// Tesseract's confidences run lower than the neural engine's for the same
// quality: correct pixel-font lines often score 0.3–0.5 (bench: "ITEM"
// 0.43, "SAVE" 0.40), and dropping one loses half a page.
export const MIN_SCORE = Object.freeze({ lines: 0.5, container: 0.5, free: 0.6, tesseract: 0.3 });
// recognition input: squeeze wide tile fonts (models.autoAspect), batch
// strips of similar width (models.planRecBatches)
export const REC_PARAMS = Object.freeze({ recAspect: 'auto', recBatch: 6, recPadRatio: 1.15 });
// The squeeze targets Latin tile fonts; kana and kanji are square in print
// too, so the Japanese/Chinese recogniser always reads unsqueezed.
const recParamsFor = (recKey, params) => (recKey === 'cjk' ? { ...params, recAspect: 1 } : { ...params });
const MIN_NATIVE_HEIGHT = 4; // smaller boxes are texture specks, not glyphs

const TIMEOUTS = Object.freeze({ loadIdle: 60000, read: 30000 });

// --- pure helpers (exported for tests) -------------------------------------------

export function routeFor(lang, info = langInfo(lang)) {
  if (!info || info.ocr === 'none') return { kind: 'none', tess: null };
  if (info.script === 'latin') return { kind: 'latin', rec: 'latin', tess: info.tess };
  if (info.script === 'japanese' || info.script === 'han') return { kind: 'cjk', rec: 'cjk', tess: info.tess };
  return { kind: 'tesseract', rec: null, tess: info.tess };
}

export function createLatch({ now = Date.now, steps = BACKOFF_MS } = {}) {
  let failures = 0;
  let until = 0;
  let lastError = null;
  let epoch = 0; // failures from one attempt (det + rec failing together) count once
  return {
    get epoch() { return epoch; },
    get failures() { return failures; },
    get lastError() { return lastError; },
    blocked: () => failures > 0 && now() < until,
    retryIn: () => Math.max(0, until - now()),
    fail(err, at = epoch) {
      if (at !== epoch) return false;
      epoch++;
      failures++;
      until = now() + steps[Math.min(failures, steps.length) - 1];
      lastError = err;
      return true;
    },
    succeed() { failures = 0; until = 0; lastError = null; }
  };
}

export function abortError(message) {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

// At most one job running; a newer queued job replaces the queued one.
// abort() settles the running job's promise at once (its work may still
// finish in the background, but never overlaps the next job).
export function createLatestQueue(run) {
  let running = false;
  let pending = null;
  let current = null; // reject() of the running job
  function pump() {
    if (running || !pending) return;
    const { job, resolve, reject } = pending;
    pending = null;
    running = true;
    current = reject;
    Promise.resolve()
      .then(() => run(job))
      .then(resolve, reject)
      .finally(() => { running = false; current = null; pump(); });
  }
  function clear(err) {
    if (pending) pending.reject(err);
    pending = null;
  }
  return {
    push(job) {
      return new Promise((resolve, reject) => {
        if (pending) pending.reject(abortError('Superseded by a newer read.'));
        pending = { job, resolve, reject };
        pump();
      });
    },
    clear,
    abort(err) {
      clear(err);
      if (current) current(err);
    },
    get busy() { return running; }
  };
}

const cleanText = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

// One Line per strip; unreadable strips become '' (score 0) with the raw
// read kept for diagnostics.
export function stripLine(res, strip, minScore = MIN_SCORE.lines) {
  const box = toNativeBox({ x: 0, y: 0, w: strip.width, h: strip.height }, strip.k, strip.offset);
  const text = cleanText(res && res.text);
  const score = Math.max(0, Math.min(1, (res && res.score) || 0));
  if (!text || score < minScore) return { text: '', score: 0, box, raw: text, rawScore: score };
  return { text, score, box };
}

// Det items (boxes in ×k image px) → native Lines, filtered per item.
export function linesFromItems(items, { k = 1, offset = { x: 0, y: 0 }, mode = 'container' } = {}, minScore = MIN_SCORE[mode] ?? 0.5) {
  const out = [];
  for (const it of items || []) {
    const text = cleanText(it.text);
    const score = Math.max(0, Math.min(1, it.score || 0));
    const box = toNativeBox(it.box, k, offset);
    if (!text || score < minScore || box.h < MIN_NATIVE_HEIGHT) continue;
    // a frame without a text box: punctuation-only reads are texture
    if (mode === 'free' && !/[\p{L}\p{N}]/u.test(text)) continue;
    out.push({ text, score, box });
  }
  return out;
}

// TypeError only for an unknown mode: callers treat it as "this engine has
// no such mode" (the scanner then switches to detection). Bad pixels are a
// plain Error.
export function validateJob(job) {
  if (!job || typeof job !== 'object') return new TypeError('read() needs a job object.');
  if (!['lines', 'container', 'free'].includes(job.mode)) return new TypeError(`Unknown OCR mode “${job.mode}”.`);
  const isImg = (i) => i && i.width > 0 && i.height > 0 && i.data && i.data.length === i.width * i.height * 4;
  if (job.mode === 'lines') {
    if (!Array.isArray(job.strips)) return new Error('Line mode needs job.strips.');
    if (!job.strips.every((s) => s && isImg(s.img))) return new Error('Every strip needs an ImageData img (one not yet handed to an earlier read).');
  } else if (!isImg(job.img || job.image)) {
    return new Error('The job has no image (or its pixels were already handed to an earlier read).');
  }
  return null;
}

export function formatWait(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  return min === 1 ? '1 minute' : `${min} minutes`;
}

const mb = (n) => (n / 1e6).toFixed(1);

const plainImage = (img) => ({ width: img.width, height: img.height, data: img.data });

function buffersOf(images) {
  return [...new Set(images.map((i) => i.data.buffer).filter((b) => b && b.byteLength))];
}

function defaultModelBase() {
  if (typeof document !== 'undefined' && document.baseURI) return new URL('models/', document.baseURI).href;
  if (typeof location !== 'undefined') return new URL('models/', location.href).href;
  throw new Error('createOcrEngine needs a modelBase outside the browser.');
}

function defaultWorker() {
  return new Worker(new URL('./ocr.worker.js', import.meta.url), { type: 'module', name: 'emulingo-ocr' });
}

// --- worker client --------------------------------------------------------------

function createWorkerClient(factory, onCrash) {
  let worker = null;
  let seq = 0;
  const calls = new Map();

  function crash(err) {
    const w = worker;
    worker = null;
    try { w && w.terminate(); } catch { /* already gone */ }
    // the worker latch holds a crash; callers must not latch it again
    if (err.name !== 'AbortError') err.crash = true;
    const pending = [...calls.values()];
    calls.clear();
    for (const c of pending) { clearTimeout(c.timer); c.reject(err); }
    if (err.name !== 'AbortError') onCrash(err);
  }

  function spawn() {
    const w = factory();
    w.onmessage = (ev) => {
      if (w !== worker) return;
      const msg = ev.data || {};
      if (msg.type === 'progress') {
        // any progress keeps every pending load alive: a model that finished
        // downloading may still be waiting for the shared runtime. The
        // runtime reports under the first load's id, which may have failed
        // already; another load then shows its progress.
        for (const other of calls.values()) other.touch();
        const c = calls.get(msg.id) || (msg.key === 'runtime' ? [...calls.values()].find((o) => o.onProgress) : null);
        if (c && c.onProgress) c.onProgress(msg);
        return;
      }
      const c = calls.get(msg.id);
      if (!c) return;
      calls.delete(msg.id);
      clearTimeout(c.timer);
      if (msg.type === 'done') c.resolve(msg.result);
      else {
        const err = new Error((msg.error && msg.error.message) || 'Text recognition failed.');
        err.name = (msg.error && msg.error.name) || 'Error';
        err.images = msg.images; // input buffers handed back for a fallback
        c.reject(err);
      }
    };
    w.onerror = (ev) => {
      if (w !== worker) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      // an ErrorEvent with a message: it crashed; a bare Event: it never loaded
      crash(new Error(ev && ev.message
        ? `Text recognition stopped unexpectedly (${ev.message}).`
        : 'Text recognition couldn’t start in this browser.'));
    };
    w.onmessageerror = () => { if (w === worker) crash(new Error('Text recognition sent back unreadable data.')); };
    worker = w;
  }

  function call(msg, { transfer = [], onProgress, idleMs = 0, totalMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      try {
        if (!worker) spawn();
      } catch (e) {
        reject(new Error(`Text recognition isn’t available in this browser (${(e && e.message) || e}).`));
        return;
      }
      const id = ++seq;
      const c = { resolve, reject, onProgress, timer: 0, touch: () => {} };
      const ms = idleMs || totalMs;
      if (ms) {
        const arm = () => {
          clearTimeout(c.timer);
          c.timer = setTimeout(() => crash(new Error('Text recognition stopped responding.')), ms);
        };
        if (idleMs) c.touch = arm;
        arm();
      }
      calls.set(id, c);
      try {
        worker.postMessage({ ...msg, id }, transfer);
      } catch (e) {
        calls.delete(id);
        clearTimeout(c.timer);
        reject(e);
      }
    });
  }

  return {
    call,
    terminate(err = abortError('The text reader was closed.')) { if (worker) crash(err); }
  };
}

// --- engine ---------------------------------------------------------------------

export function createOcrEngine({
  onStatus = () => {},
  modelBase,
  workerFactory = defaultWorker,
  tesseract,
  now = Date.now,
  timeouts = TIMEOUTS,
  detParams = DET_PARAMS,
  mergeOpts = MERGE_OPTS,
  recParams = REC_PARAMS
} = {}) {
  const status = (s) => { try { onStatus(s); } catch { /* a UI bug must not break OCR */ } };
  // worker: crashes and hangs (gates every neural read, the worker is shared);
  // local: the bundled det/Latin models; cjk: the remote Japanese/Chinese one.
  // A latch only resets after a successful neural read, so a failure that
  // keeps coming back backs off 1 → 5 → 15 min.
  const latches = { worker: createLatch({ now }), local: createLatch({ now }), cjk: createLatch({ now }) };
  const groupOf = (key) => (key === 'cjk' ? 'cjk' : 'local');
  const loaded = new Map(); // model key -> Promise
  const progress = new Map(); // model key -> { loaded, total }
  let base = null;
  let disposed = false;
  let preference = 'auto';
  let loadsInFlight = 0;
  let runtimeLoaded = false; // per worker: the first load also fetches the .wasm

  const tess = tesseract || createTesseract({ onStatus: status });

  // Every await can outlive dispose(): never start new work afterwards.
  function alive() {
    if (disposed) throw abortError('The text reader was closed.');
  }

  const client = createWorkerClient(workerFactory, (err) => {
    // the worker is gone and every loaded model with it
    loaded.clear();
    progress.clear();
    runtimeLoaded = false;
    latches.worker.fail(err);
    reportFailure('worker', err);
  });

  function urlFor(key) {
    const m = MODELS[key];
    if (m.url) return m.url;
    base = base || modelBase || defaultModelBase();
    return new URL(m.file, base).href;
  }

  function reportFailure(group, err) {
    const latch = latches[group];
    let reason = String((err && err.message) || 'Text recognition failed.').trim();
    if (!/[.!?)]$/.test(reason)) reason += '.';
    const what = group === 'cjk' ? 'The Japanese and Chinese reader isn’t available. ' : '';
    status({
      phase: 'error',
      progress: 0,
      engine: 'neural',
      message: `${what}${reason} Using the Classic reader for now — trying again in ${formatWait(latch.retryIn())}.`,
      retryAt: now() + latch.retryIn()
    });
  }

  function emitProgress() {
    let got = 0;
    let total = 0;
    for (const p of progress.values()) { got += p.loaded; total += p.total; }
    if (!total) return;
    status({
      phase: 'download',
      progress: Math.min(0.99, got / total),
      engine: 'neural',
      bytes: { loaded: got, total },
      message: `Downloading text recognition data — ${mb(got)} of ${mb(total)} MB`
    });
  }

  function loadModel(key) {
    if (loaded.has(key)) return loaded.get(key);
    const m = MODELS[key];
    loadsInFlight++;
    progress.set(key, { loaded: 0, total: m.size });
    if (!runtimeLoaded && !progress.has('runtime')) progress.set('runtime', { loaded: 0, total: RUNTIME_SIZE });
    const p = client.call(
      { type: 'load', key, kind: m.kind, url: urlFor(key), size: m.size },
      {
        idleMs: timeouts.loadIdle,
        onProgress: (msg) => {
          if (msg.stage === 'init') {
            progress.set(key, { loaded: m.size, total: m.size });
            status({ phase: 'init', progress: 1, engine: 'neural', message: 'Starting text recognition…' });
            return;
          }
          const k = msg.key || key;
          const fallback = k === 'runtime' ? RUNTIME_SIZE : m.size;
          progress.set(k, { loaded: msg.loaded, total: Math.max(msg.total || fallback, msg.loaded) });
          emitProgress();
        }
      }
    );
    loaded.set(key, p);
    const settle = () => {
      loadsInFlight--;
      progress.delete(key);
      if (!loadsInFlight) progress.clear();
    };
    p.then(
      () => {
        runtimeLoaded = true;
        settle();
        if (!loadsInFlight) status({ phase: 'ready', progress: 1, engine: 'neural', message: 'Text recognition is ready.' });
      },
      () => {
        settle();
        if (loaded.get(key) === p) loaded.delete(key);
      }
    );
    return p;
  }

  const blocked = (keys) => latches.worker.blocked() || keys.some((k) => latches[groupOf(k)].blocked());

  // Resolves true when every model in `keys` is loaded, false when the
  // neural path is latched or failed to load (the failure is latched here).
  async function ready(keys) {
    if (preference === 'tesseract' || disposed || blocked(keys)) return false;
    const groups = [...new Set(keys.map(groupOf))];
    const epochs = Object.fromEntries(groups.map((g) => [g, latches[g].epoch]));
    const results = await Promise.allSettled(keys.map(loadModel));
    let ok = true;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') return;
      ok = false;
      const e = r.reason;
      // closing, or a crash the worker latch already holds
      if (!e || e.name === 'AbortError' || e.crash) return;
      const g = groupOf(keys[i]);
      if (latches[g].fail(e, epochs[g])) reportFailure(g, e);
    });
    return ok;
  }

  function succeeded(keys) {
    latches.worker.succeed();
    for (const k of keys) latches[groupOf(k)].succeed();
  }

  // --- neural reads ---

  async function neuralLines(job, recKey) {
    const strips = job.strips.map((s) => ({ width: s.img.width, height: s.img.height, k: s.k || job.k || 1, offset: s.offset || { x: 0, y: 0 } }));
    const images = job.strips.map((s, i) => ({ ...plainImage(s.img), k: strips[i].k }));
    const res = await client.call(
      { type: 'read', op: 'rec', recKey, images, params: recParamsFor(recKey, recParams) },
      { transfer: buffersOf(images), totalMs: timeouts.read }
    );
    return strips.map((s, i) => stripLine(res.items[i], s));
  }

  async function neuralDetRec(job, recKey) {
    const img = plainImage(job.img || job.image);
    const res = await client.call(
      { type: 'read', op: 'detrec', recKey, images: [img], params: { ...detParams, ...recParamsFor(recKey, recParams), mergeOpts, k: job.k || 1 } },
      { transfer: buffersOf([img]), totalMs: timeouts.read }
    );
    return linesFromItems(res.items, job);
  }

  // --- Tesseract reads ---

  async function tesseractRead(job, tessLang) {
    if (!tessLang) throw new Error('The Classic reader isn’t available for this language.');
    if (job.mode === 'lines') {
      const res = await tess.recognizeLines(job.strips.map((s) => s.img), tessLang);
      return job.strips.map((s, i) => stripLine(res[i], { width: s.img.width, height: s.img.height, k: s.k || job.k || 1, offset: s.offset }, MIN_SCORE.tesseract));
    }
    let img = job.img || job.image;
    // local detection finds the lines; Tesseract reads each one (PSM 7)
    const detOk = await ready(['det']);
    alive();
    if (detOk) {
      const plain = plainImage(img);
      try {
        const res = await client.call(
          { type: 'read', op: 'det', images: [plain], params: { ...detParams, mergeOpts } },
          { transfer: buffersOf([plain]), totalMs: timeouts.read }
        );
        alive();
        const recs = await tess.recognizeLines(res.items.map((it) => it.crop), tessLang);
        return linesFromItems(res.items.map((it, i) => ({ box: it.box, ...recs[i] })), job);
      } catch (e) {
        if (!e.images || !e.images[0]) throw e;
        img = e.images[0];
      }
    }
    alive();
    const lines = await tess.recognizeBlock(img, tessLang, { sparse: job.mode === 'free' });
    return linesFromItems(lines, job);
  }

  // --- one job ---

  async function execute(job) {
    alive();
    const t0 = performance.now();
    const route = routeFor(job.lang);
    if (route.kind === 'none') throw new Error('Reading text isn’t supported for this language yet.');
    const done = (lines, engine) => ({ lines, ms: performance.now() - t0, engine });
    if (job.mode === 'lines' && !job.strips.length) return done([], route.rec ? 'neural' : 'tesseract');

    if (route.rec) {
      const keys = job.mode === 'lines' ? [route.rec] : ['det', route.rec];
      const ok = await ready(keys);
      alive();
      if (ok) {
        try {
          const lines = job.mode === 'lines' ? await neuralLines(job, route.rec) : await neuralDetRec(job, route.rec);
          succeeded(keys);
          // neural reads are back: release an idle fallback worker (30–100 MB)
          if (tess.language()) tess.dispose();
          return done(lines, 'neural');
        } catch (e) {
          if (e.name === 'AbortError' || !e.images) throw e; // worker gone: pixels lost with it
          alive();
          const g = groupOf(route.rec);
          if (latches[g].fail(e)) reportFailure(g, e);
          job = withImages(job, e.images);
        }
      }
    }
    return done(await tesseractRead(job, route.tess), 'tesseract');
  }

  // a failed worker read hands the transferred pixels back
  function withImages(job, images) {
    if (job.mode === 'lines') return { ...job, strips: job.strips.map((s, i) => ({ ...s, img: images[i] })) };
    return { ...job, img: images[0], image: undefined };
  }

  const queue = createLatestQueue(execute);

  return {
    // Downloads and starts what `lang` needs; the Tesseract fallback only
    // when the neural reader can't be used. (An idle fallback is released
    // by the next neural read, never here: a read may be using it.)
    async prepare(lang) {
      alive();
      const route = routeFor(lang);
      if (route.kind === 'none') throw new Error('Reading text isn’t supported for this language yet.');
      let recOk;
      if (route.kind === 'latin') {
        recOk = await ready(['det', 'latin']);
      } else {
        [, recOk] = await Promise.all([ready(['det']), route.rec ? ready([route.rec]) : false]);
      }
      alive();
      if (!recOk) await tess.prepare(route.tess);
    },

    read(job) {
      if (disposed) return Promise.reject(abortError('The text reader was closed.'));
      const err = validateJob(job);
      if (err) return Promise.reject(err);
      return queue.push(job);
    },

    // The reader the next read of `lang` will try first.
    supports(lang) {
      const route = routeFor(lang);
      if (route.kind === 'none') return 'none';
      if (!route.rec || preference === 'tesseract' || blocked([route.rec])) return 'tesseract';
      return 'neural';
    },

    // Settings › engine: 'auto' (neural with fallback) or 'tesseract' (always)
    setPreference(pref) { preference = pref === 'tesseract' ? 'tesseract' : 'auto'; },

    // Diagnostics for ?debug=1
    state() {
      return {
        models: [...loaded.keys()],
        reading: queue.busy,
        preference,
        latched: Object.fromEntries(Object.entries(latches).map(([g, l]) => [g, l.blocked()])),
        retryIn: Object.fromEntries(Object.entries(latches).map(([g, l]) => [g, l.retryIn()])),
        lastError: Object.fromEntries(Object.entries(latches).map(([g, l]) => [g, l.lastError ? l.lastError.message : null])),
        tesseract: tess.language()
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      const err = abortError('The text reader was closed.');
      queue.abort(err);
      client.terminate(err);
      loaded.clear();
      progress.clear();
      tess.dispose();
    }
  };
}
