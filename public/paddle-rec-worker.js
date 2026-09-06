// PaddleOCR recognition-only worker (classic: importScripts for ORT's UMD
// build, which is the worker-safe loading path). Box detection happens on
// the main thread (our own band detector); this worker crops each box,
// splits it into text lines, runs the PP-OCRv5 latin recognition model
// (~8 MB ONNX via onnxruntime-web WASM) and CTC-decodes the result.
// Worker-safe: no DOM access, OffscreenCanvas only.

self.postMessage({ debug: 'worker script loaded' });
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.wasm.min.js');
self.postMessage({ debug: 'ort imported' });

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';
ort.env.wasm.numThreads = 1;

let sessionPromise = null;
let labels = null;

function init() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const [dictRes, modelBuf] = await Promise.all([
      fetch(new URL('models/latin-dict.json', self.location.href)),
      fetch(new URL('models/rec.onnx', self.location.href)).then((r) => r.arrayBuffer())
    ]);
    const dict = (await dictRes.json()).chars;
    // CTC classes: 0 = blank, 1..N = dict chars, +1 trailing space class when
    // the model was built with use_space_char (checked against output shape)
    labels = ['###'].concat(dict);
    const session = await ort.InferenceSession.create(modelBuf, { executionProviders: ['wasm'] });
    return session;
  })();
  sessionPromise = sessionPromise.catch((e) => { sessionPromise = null; throw e; });
  return sessionPromise;
}

// crop a box from the bitmap and split it into text-line bands. Border
// lines (rows/cols with near-full contrast coverage) are masked out so the
// recognizer only sees text, like Paddle's det polygons would.
function lineBands(bitmap, rect) {
  const c = new OffscreenCanvas(rect.w, rect.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  const d = ctx.getImageData(0, 0, rect.w, rect.h).data;
  const w = rect.w, h = rect.h;
  const lums = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    lums[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  const sorted = Float32Array.from(lums).sort();
  const bg = sorted[(sorted.length / 2) | 0];
  const inkRow = new Uint16Array(h);
  const inkCol = new Uint16Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(lums[y * w + x] - bg) > 60) { inkRow[y]++; inkCol[x]++; }
    }
  }
  const isBorderRow = (y) => inkRow[y] > w * 0.8;
  const isBorderCol = (x) => inkCol[x] > h * 0.8;
  // smoothed text-row profile: nearest-neighbour downscales scatter single
  // dark pixels into empty rows, which would otherwise weld two text lines
  // into one band
  const smooth = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < h) { s += inkRow[yy]; n++; }
    }
    smooth[y] = s / n;
  }
  const bands = [];
  let cur = null;
  for (let y = 0; y < h; y++) {
    if (!isBorderRow(y) && smooth[y] > w * 0.06) {
      if (!cur) cur = { y0: y, y1: y };
      else cur.y1 = y;
    } else if (cur) { bands.push(cur); cur = null; }
  }
  if (cur) bands.push(cur);
  const merged = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y0 - last.y1 <= 2) last.y1 = b.y1;
    else merged.push({ ...b });
  }
  return merged
    .filter((b) => b.y1 - b.y0 >= 6)
    .map((b) => {
      // trim each band to its text columns
      const rows = b.y1 - b.y0 + 1;
      let minX = -1, maxX = -1;
      for (let x = 0; x < w; x++) {
        if (isBorderCol(x)) continue;
        let ink = 0;
        for (let y = b.y0; y <= b.y1; y++) if (Math.abs(lums[y * w + x] - bg) > 60) ink++;
        if (ink > rows * 0.08) { if (minX === -1) minX = x; maxX = x; }
      }
      if (minX === -1) { minX = 0; maxX = w - 1; }
      return {
        x0: Math.max(0, minX - 4),
        x1: Math.min(w, maxX + 5),
        y0: Math.max(0, b.y0 - 2),
        y1: Math.min(h, b.y1 + 3),
        rows
      };
    });
}

// PP-OCR rec preprocessing: resize to 48px height (width by aspect), BGR,
// normalize (x/255 - 0.5) / 0.5, CHW layout
function lineTensor(bitmap, rect, band) {
  const bw = band.y1 - band.y0;
  const cw = band.x1 - band.x0;
  const w2 = Math.max(8, Math.min(1200, Math.round(cw * 48 / bw)));
  const c = new OffscreenCanvas(w2, 48);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, rect.x + band.x0, rect.y + band.y0, cw, bw, 0, 0, w2, 48);
  const d = ctx.getImageData(0, 0, w2, 48).data;
  const preview = c.transferToImageBitmap();
  const out = new Float32Array(3 * 48 * w2);
  const plane = 48 * w2;
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < w2; x++) {
      const i = (y * w2 + x) * 4;
      const p = y * w2 + x;
      out[p] = (d[i + 2] / 255 - 0.5) / 0.5;
      out[plane + p] = (d[i + 1] / 255 - 0.5) / 0.5;
      out[2 * plane + p] = (d[i] / 255 - 0.5) / 0.5;
    }
  }
  return { tensor: new ort.Tensor('float32', out, [1, 3, 48, w2]), preview };
}

function ctcDecode(data, dims) {
  const T = dims[1], C = dims[2];
  // extend labels with the trailing space class if the model has one
  if (labels.length === C - 1) labels.push(' ');
  let last = 0, text = '';
  const confs = [];
  for (let t = 0; t < T; t++) {
    let best = 0, bestP = data[t * C];
    for (let c = 1; c < C; c++) {
      if (data[t * C + c] > bestP) { bestP = data[t * C + c]; best = c; }
    }
    if (best !== 0 && best !== last) {
      text += labels[best] || '';
      confs.push(bestP);
    }
    last = best;
  }
  return { text, score: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0 };
}

self.onmessage = async (e) => {
  const { id, type, bitmap, rects, detLimit } = e.data || {};
  if (!id || !type) return;
  if (type === 'init') {
    try {
      await init();
      self.postMessage({ id, ok: true });
    } catch (err) {
      self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
    return;
  }
  if (type !== 'predict' || !bitmap || !rects) return;
  try {
    const session = await init();
    const out = [];
    for (const rect of rects) {
      const bands = lineBands(bitmap, rect);
      let text = '', score = 0, n = 0;
      for (const band of bands) {
        const { tensor } = lineTensor(bitmap, rect, band);
        const feed = {};
        feed[session.inputNames[0]] = tensor;
        self.postMessage({ debug: 'running tensor w=' + tensor.dims[3] });
        const r = await session.run(feed);
        self.postMessage({ debug: 'run done' });
        const t = r[Object.keys(r)[0]];
        const line = ctcDecode(t.data, t.dims);
        // de-hyphenate lines the game wrapped ("TELEFON-" + "Symbol")
        if (text && /\p{L}-$/u.test(text)) text = text.slice(0, -1) + line.text;
        else text = text ? text + ' ' + line.text : line.text;
        score += line.score; n++;
      }
      out.push({
        text: text.replace(/\s+/g, ' ').trim(),
        conf: Math.round(n ? (score / n) * 100 : 0),
        x: rect.x, y: rect.y
      });
    }
    self.postMessage({ id, ok: true, boxes: out, crops: dbgCrops });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }
};
