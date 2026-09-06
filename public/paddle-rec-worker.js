// PaddleOCR PP-OCRv5 worker (det + rec), fully on-device via
// onnxruntime-web WASM. No SDK, no OpenCV, no DOM access.
//
// NOTE: importScripts + ort.env setup must run inside an async IIFE exactly
// like a plain script would — touching ort.env synchronously at top level
// after importScripts wedges the worker (threaded-WASM pool spawn).
//
// Pipeline per frame:
//   1. det: resize long side to 960, ImageNet-normalize, run DBNet
//   2. post: threshold prob map -> connected components -> line boxes
//      (GB text is axis-aligned, so plain bounding boxes beat polygon
//      fitting). DBNet's prob map covers the SHRUNKEN text core, so each
//      box is unclipped back out to the full text extent before cropping.
//   3. rec: crop each box, resize to 48px height, run recognizer, CTC-decode
//   4. return line items [{text, score, x, y, w, h}] sorted top-to-bottom

let detSession = null;
let recSession = null;
let labels = null;
let bootPromise = null;

function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    self.postMessage({ debug: 'importing ort…' });
    importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.wasm.min.js');
    self.postMessage({ debug: 'ort imported' });
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';
    self.postMessage({ debug: 'fetching models (~13 MB)…' });
    const base = new URL('models/', self.location.href);
    const [dictRes, detBuf, recBuf] = await Promise.all([
      fetch(new URL('latin-dict.json', base)),
      fetch(new URL('det.onnx', base)).then((r) => r.arrayBuffer()),
      fetch(new URL('rec.onnx', base)).then((r) => r.arrayBuffer())
    ]);
    self.postMessage({ debug: 'models fetched, creating sessions…' });
    const dict = (await dictRes.json()).chars;
    labels = ['###'].concat(dict);
    const opts = { executionProviders: ['wasm'] };
    [detSession, recSession] = await Promise.all([
      ort.InferenceSession.create(detBuf, opts),
      ort.InferenceSession.create(recBuf, opts)
    ]);
    self.postMessage({ debug: 'sessions ready' });
  })();
  bootPromise = bootPromise.catch((e) => { bootPromise = null; throw e; });
  return bootPromise;
}

// ---- det ----

function detPreprocess(bitmap) {
  // Paddle's DetResizeForTest(resize_long: 960) always scales the LONG side
  // to 960 - upscaling included. Skipping the upscale starves the model and
  // the probability map degrades into few, merged blobs.
  const scale = 960 / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(32, Math.round(bitmap.width * scale));
  const h = Math.max(32, Math.round(bitmap.height * scale));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  // ImageNet normalize, RGB, CHW (Paddle det: mean .485/.456/.406 std .229/.224/.225)
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let p = 0; p < plane; p++) {
    const i = p * 4;
    out[p] = (d[i] / 255 - mean[0]) / std[0];
    out[plane + p] = (d[i + 1] / 255 - mean[1]) / std[1];
    out[2 * plane + p] = (d[i + 2] / 255 - mean[2]) / std[2];
  }
  return { tensor: new ort.Tensor('float32', out, [1, 3, h, w]), w, h };
}

// connected components (BFS, 8-conn) over the thresholded prob map
function findBoxes(prob, w, h) {
  const seen = new Uint8Array(w * h);
  const boxes = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] < 0.3) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w, maxX = 0, minY = h, maxY = 0, area = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w, y = (idx / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (!seen[n] && prob[n] >= 0.3) { seen[n] = 1; stack[sp++] = n; }
        }
      }
    }
    if (area < 120) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    // text lines: wide and short-ish; drop square blobs (sprites, tiles)
    if (bw < 12 || bh < 6) continue;
    if (bw / bh > 14 || bh / bw > 2.2) continue;
    // DBNet's prob map covers the SHRUNKEN text core - Paddle unclips each
    // box back out to the full text extent. Without this the recognizer
    // gets crops with cut-off glyphs. (Axis-aligned approximation of
    // Paddle's polygon offset: expand ~18% of height per side vertically,
    // ~8% of width per side horizontally.)
    const oy = Math.max(2, Math.round(bh * 0.18));
    const ox = Math.max(2, Math.round(bw * 0.08));
    boxes.push({
      x: Math.max(0, minX - ox),
      y: Math.max(0, minY - oy),
      w: bw + 2 * ox,
      h: bh + 2 * oy
    });
  }
  return boxes;
}

async function detBoxes(bitmap) {
  const { tensor, w, h } = detPreprocess(bitmap);
  const feed = {};
  feed[detSession.inputNames[0]] = tensor;
  const r = await detSession.run(feed);
  const t = r[Object.keys(r)[0]];
  const boxes = findBoxes(t.data, t.dims[3], t.dims[2]);
  const sx = bitmap.width / w, sy = bitmap.height / h;
  return boxes.map((b) => ({
    x: Math.max(0, Math.floor(b.x * sx) - 2),
    y: Math.max(0, Math.floor(b.y * sy) - 3),
    w: Math.min(bitmap.width - Math.floor(b.x * sx), Math.ceil(b.w * sx) + 4),
    h: Math.min(bitmap.height - Math.floor(b.y * sy), Math.ceil(b.h * sy) + 6)
  })).filter((b) => b.w >= 16 && b.h >= 10);
}

// ---- rec ----

function recLine(bitmap, box) {
  const c = new OffscreenCanvas(box.w, box.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const w2 = Math.max(16, Math.min(1200, Math.round(box.w * 48 / box.h)));
  const c2 = new OffscreenCanvas(w2, 48);
  const ctx2 = c2.getContext('2d', { willReadFrequently: true });
  ctx2.drawImage(c, 0, 0, box.w, box.h, 0, 0, w2, 48);
  const d = ctx2.getImageData(0, 0, w2, 48).data;
  // rec preprocessing: BGR, (x/255 - 0.5) / 0.5, CHW
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
  const feed = {};
  feed[recSession.inputNames[0]] = new ort.Tensor('float32', out, [1, 3, 48, w2]);
  return recSession.run(feed).then((r) => {
    const t = r[Object.keys(r)[0]];
    return ctcDecode(t.data, t.dims);
  });
}

function ctcDecode(data, dims) {
  const T = dims[1], C = dims[2];
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
  return { text: text.replace(/\s+/g, ' ').trim(), score: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0 };
}

// de-hyphenate lines the game wrapped ("TELEFON-" + "Symbol" -> "TELEFON-Symbol")
function joinLines(a, b) {
  if (a && /\p{L}-$/u.test(a)) return a.slice(0, -1) + b;
  return a ? a + ' ' + b : b;
}

// group recognized line boxes into reading-order text regions: lines whose
// vertical gap is under a line height and that share a column form one
// region (a dialog box, a menu entry...)
function groupLines(items) {
  const lines = items
    .map((it) => ({ ...it, y1: it.y + it.h }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const regions = [];
  for (const l of lines) {
    const last = regions[regions.length - 1];
    const rh = last ? Math.max(last.h, l.h, 1) : 0;
    const gap = last ? l.y - last.y1 : Infinity;
    const overlapW = last ? Math.min(last.x + last.w, l.x + l.w) - Math.max(last.x, l.x) : 0;
    const colOverlap = last ? overlapW > 0.3 * Math.min(last.w, l.w) : false;
    if (last && gap < rh * 0.9 && colOverlap) {
      last.text = joinLines(last.text, l.text);
      last.y1 = Math.max(last.y1, l.y1);
      last.h = last.y1 - last.y;
      last.x = Math.min(last.x, l.x);
      last.w = Math.max(last.x + last.w, l.x + l.w) - last.x;
      last.score = Math.max(last.score, l.score);
      continue;
    }
    regions.push({ ...l });
  }
  return regions;
}

self.onmessage = async (e) => {
  const { id, type, bitmap } = e.data || {};
  if (!id || !type) return;
  try {
    await boot();
    if (type === 'init') {
      self.postMessage({ id, ok: true });
      return;
    }
    if (type !== 'predict' || !bitmap) {
      self.postMessage({ id, ok: false, error: 'bad predict request' });
      return;
    }
    const boxes = await detBoxes(bitmap);
    boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const items = [];
    for (const box of boxes) {
      const line = await recLine(bitmap, box);
      if (!line.text || line.score < 0.45) continue;
      items.push({
        text: line.text,
        score: line.score,
        x: box.x, y: box.y, w: box.w, h: box.h
      });
    }
    const regions = groupLines(items);
    self.postMessage({ id, ok: true, regions });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }
};
