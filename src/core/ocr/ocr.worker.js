// Neural OCR worker (Vite module worker). Runs PP-OCRv5 detection and
// recognition with onnxruntime-web (single-threaded WASM: GitHub Pages
// can't send the COOP/COEP headers threads need) so inference never blocks
// the emulator on the main thread.
//
// Protocol (every request carries an id; replies echo it):
//   → { type: 'load', id, key, kind: 'det'|'rec', url, size? }
//   ← { type: 'progress', id, key, loaded, total } … { type: 'progress', id, key, stage: 'init' }
//     (the first load also reports key 'runtime': the 14 MB ORT .wasm)
//   ← { type: 'done', id, result: { key, modelName, … } }
//   → { type: 'read', id, op: 'rec'|'detrec'|'det', recKey, images: [img], params }
//     (img.k / params.k: the images' upscale factor, for font-size estimates)
//   ← { type: 'done', id, result }  or  { type: 'fail', id, error, images }
// Images are { width, height, data } with transferred buffers. A failed read
// returns its input buffers so the caller can fall back to Tesseract.

// The plain-WASM build (14 MB) instead of the default JSEP/WebGPU one
// (27.8 MB); the .wasm is emitted same-origin and version-locked by npm.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import {
  extractTar, tarEntry, parseDetConfig, parseRecConfig, writeTensor, cropImage,
  recGeometry, planRecBatches, ctcDecode, REC_NORMALIZE, detGeometry, detBoxes, mergeLineBoxes, autoAspect,
  RUNTIME_SIZE, hasWasmSimd
} from './models.js';

const WASM_URL = new URL(wasmUrl, self.location.href).href;

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: WASM_URL };
ort.env.logLevel = 'error';

const models = new Map(); // key -> { kind, session, config }
const loading = new Map(); // key -> Promise (dedupes concurrent loads)
let runtime = null; // Promise of the prefetched .wasm bytes
let busy = Promise.resolve();

// ORT sessions are not re-entrant: session creation and inference run one
// at a time, while downloads proceed in parallel.
function exclusive(fn) {
  const p = busy.then(fn);
  busy = p.catch(() => {});
  return p;
}

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

function errorInfo(e) {
  return { name: (e && e.name) || 'Error', message: String((e && e.message) || e || 'Unknown error') };
}

// --- model loading -------------------------------------------------------------

async function download(id, key, url, sizeHint) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Couldn’t download the text recognition data (${errorInfo(e).message}).`);
  }
  if (!res.ok) throw new Error(`Couldn’t download the text recognition data (HTTP ${res.status}).`);
  const encoded = (res.headers.get('content-encoding') || 'identity') !== 'identity';
  const length = Number(res.headers.get('content-length')) || 0;
  // a compressed transfer reports the compressed length; use the known size
  const total = !encoded && length ? length : sizeHint || length || 0;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    post({ type: 'progress', id, key, loaded: buf.length, total: buf.length });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let last = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (e) {
      throw new Error(`Couldn’t download the text recognition data (${errorInfo(e).message}).`);
    }
    const { done, value } = step;
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = performance.now();
    if (now - last > 100) {
      last = now;
      post({ type: 'progress', id, key, loaded, total: Math.max(total, loaded) });
    }
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  post({ type: 'progress', id, key, loaded, total: loaded });
  return out;
}

// The runtime .wasm is fetched here (not by ORT) so its bytes show in the
// download progress; ORT then compiles the buffer it is handed.
function ensureRuntime(id) {
  if (!runtime) {
    runtime = download(id, 'runtime', WASM_URL, RUNTIME_SIZE)
      .then((bytes) => { ort.env.wasm.wasmBinary = bytes; })
      .catch((e) => { runtime = null; throw e; });
  }
  return runtime;
}

function load(msg) {
  const { key } = msg;
  if (models.has(key)) return Promise.resolve({ key, modelName: models.get(key).config.modelName, cached: true });
  if (!loading.has(key)) {
    const p = loadModel(msg).finally(() => loading.delete(key));
    loading.set(key, p);
  }
  return loading.get(key);
}

async function loadModel({ id, key, kind, url, size }) {
  // the runtime needs WASM SIMD (Safari 16.4+): fail before downloading 27 MB
  if (!hasWasmSimd()) throw new Error('This browser can’t run the built-in text reader. Updating the browser should fix this.');
  const [tarBytes] = await Promise.all([download(id, key, url, size), ensureRuntime(id)]);
  const tar = extractTar(tarBytes);
  const configText = new TextDecoder().decode(tarEntry(tar, 'inference.yml'));
  const config = kind === 'det' ? parseDetConfig(configText) : parseRecConfig(configText);
  // copy: the session must not keep the whole tar alive through a view
  const bytes = tarEntry(tar, 'inference.onnx').slice();
  return exclusive(async () => {
    post({ type: 'progress', id, key, stage: 'init' });
    let session;
    try {
      // logSeverityLevel 3: ORT's graph optimiser otherwise prints dozens of
      // harmless "unused initializer" warnings to the console as errors
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    } catch (e) {
      throw new Error(`Text recognition couldn’t start (${errorInfo(e).message}).`);
    }
    // ORT compiled the runtime with the first session; free the 14 MB copy
    ort.env.wasm.wasmBinary = undefined;
    models.set(key, { kind, session, config });
    return { key, modelName: config.modelName, chars: kind === 'rec' ? config.charDict.length : undefined };
  });
}

function model(key, kind) {
  const m = models.get(key);
  if (!m || m.kind !== kind) throw new Error(`The ${kind === 'det' ? 'detection' : 'recognition'} model “${key}” isn’t loaded.`);
  return m;
}

async function run(session, tensor) {
  const out = await session.run({ [session.inputNames[0]]: tensor });
  return out[session.outputNames[0]];
}

// --- inference --------------------------------------------------------------------

async function recognize(rec, images, params = {}) {
  const { height, baseWidth, charDict } = rec.config;
  // recAspect < 1 squeezes lines horizontally before recognition; 'auto'
  // squeezes only wide tile-font glyphs (models.autoAspect)
  const aspects = images.map((img) => (params.recAspect === 'auto'
    ? autoAspect(img, { ...params.aspectOpts, k: img.k || params.k || 1 })
    : params.recAspect > 0 ? params.recAspect : 1));
  const geo = images.map((img, i) => recGeometry(img.width * aspects[i], img.height, height, baseWidth));
  const results = new Array(images.length);
  const plan = planRecBatches(geo.map((g) => g.recW), { maxBatch: params.recBatch ?? 6, maxPadRatio: params.recPadRatio ?? 1.15 });
  for (const batch of plan) {
    const W = batch.width;
    const N = batch.items.length;
    const plane = 3 * height * W;
    const data = new Float32Array(N * plane); // zero = SDK padding
    batch.items.forEach((idx, b) => {
      writeTensor(images[idx], geo[idx].resizedW, height, data, { base: b * plane, stride: W, planeH: height, ...REC_NORMALIZE });
    });
    const out = await run(rec.session, new ort.Tensor('float32', data, [N, 3, height, W]));
    const [, steps, classes] = out.dims;
    batch.items.forEach((idx, b) => { results[idx] = { ...ctcDecode(out.data, b * steps * classes, steps, classes, charDict), aspect: aspects[idx] }; });
    out.dispose?.();
  }
  return results;
}

async function detect(det, img, params = {}) {
  const { dstW, dstH } = detGeometry(img.width, img.height, {
    limitSideLen: params.limitSideLen ?? Math.max(img.width, img.height),
    limitType: params.limitType ?? 'max',
    maxSideLimit: params.maxSideLimit ?? 4000
  });
  const cfg = det.config;
  const data = new Float32Array(3 * dstH * dstW);
  writeTensor(img, dstW, dstH, data, { mean: cfg.mean, std: cfg.std, scale: cfg.scale });
  const out = await run(det.session, new ort.Tensor('float32', data, [1, 3, dstH, dstW]));
  const dims = out.dims;
  const boxes = detBoxes(out.data, dims[dims.length - 1], dims[dims.length - 2], img.width, img.height, {
    thresh: params.thresh ?? cfg.thresh,
    boxThresh: params.boxThresh ?? cfg.boxThresh,
    unclipRatio: params.unclipRatio ?? cfg.unclipRatio,
    maxCandidates: cfg.maxCandidates
  });
  out.dispose?.();
  return params.merge === false ? boxes : mergeLineBoxes(boxes, params.mergeOpts);
}

async function read({ op, recKey, images, params = {} }) {
  const t0 = performance.now();
  if (op === 'rec') {
    const recs = await recognize(model(recKey, 'rec'), images, params);
    return { result: { items: recs, recMs: performance.now() - t0 } };
  }
  if (op !== 'det' && op !== 'detrec') throw new Error(`Unknown read “${op}”.`);
  const det = model('det', 'det');
  const img = images[0];
  const boxes = await detect(det, img, params);
  const detMs = performance.now() - t0;
  // crops of the (merged) line boxes from the ×k input
  const crops = boxes.map((b) => cropImage(img, b));
  if (op === 'det') {
    return {
      result: { items: boxes.map((b, i) => ({ box: b, crop: crops[i] })), detMs },
      transfer: crops.map((c) => c.data.buffer)
    };
  }
  const recs = crops.length ? await recognize(model(recKey, 'rec'), crops, params) : [];
  return {
    result: {
      items: boxes.map((b, i) => ({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, detScore: b.score, parts: b.parts, ...recs[i] })),
      detMs,
      recMs: performance.now() - t0 - detMs
    }
  };
}

// --- dispatch -------------------------------------------------------------------------

async function handle(msg) {
  try {
    if (msg.type === 'load') {
      post({ type: 'done', id: msg.id, result: await load(msg) });
    } else if (msg.type === 'read') {
      const { result, transfer } = await exclusive(() => read(msg));
      post({ type: 'done', id: msg.id, result }, transfer);
    } else {
      throw new Error(`Unknown request “${msg.type}”.`);
    }
  } catch (e) {
    const images = msg.type === 'read' && Array.isArray(msg.images) ? msg.images : [];
    const transfer = new Set(images.map((i) => i && i.data && i.data.buffer).filter((b) => b && b.byteLength));
    post({ type: 'fail', id: msg.id, error: errorInfo(e), images }, [...transfer]);
  }
}

self.onmessage = (event) => { handle(event.data || {}); };
