// Pure helpers for the neural OCR worker: model archives, the PaddleOCR
// (PP-OCRv5) pre- and post-processing re-implemented for axis-aligned text
// without OpenCV, line-box merging and coordinate mapping.
//
// Mirrors @paddleocr/paddleocr-js 0.4.2 (preprocessSample$1, decodeDetOutput,
// unclip, preprocessSample, decodeCTCSample, extractTarEntries) so results
// match the SDK, with two deliberate differences: boxes are axis-aligned
// (game text is never rotated, and it saves the 10 MB OpenCV runtime) and
// tall crops are not rotated (a lone "I" or "!" would be read sideways).
//
// Images are ImageData-like: { width, height, data: Uint8ClampedArray RGBA }.
// Nothing here touches the DOM or onnxruntime, so Node tests cover it all.

// onnxruntime-web 1.29.0's plain WASM build (dist/ort-wasm-simd-threaded.wasm),
// for download progress before the server reports a length. Shared by the
// engine and its worker; a unit test checks it against node_modules.
export const RUNTIME_SIZE = 13961845;

// Smallest valid module using a SIMD instruction (i8x16.splat + popcnt).
// The ORT runtime needs WASM SIMD (Safari 16.4+), Tesseract has a core without.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export function hasWasmSimd() {
  try { return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE); } catch { return false; }
}

// --- model archives (.tar) ---------------------------------------------------

function readString(bytes, start, length) {
  let out = '';
  for (let i = start; i < start + length; i++) {
    if (bytes[i] === 0) break;
    out += String.fromCharCode(bytes[i]);
  }
  return out.trim();
}

function readOctal(bytes, start, length) {
  const raw = readString(bytes, start, length).replace(/[^0-7]/g, '');
  return raw ? parseInt(raw, 8) : 0;
}

const normName = (name) => name.replace(/^\.?\//, '');

// macOS tar adds AppleDouble ("._x") and PaxHeader entries; skip them
function isMetadata(name) {
  const parts = normName(name).split('/');
  const base = parts[parts.length - 1] || '';
  return base.startsWith('._') || parts.includes('PaxHeader') || parts.includes('__MACOSX');
}

// ustar reader: regular files only, returned as subarray views (no copies)
export function extractTar(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    let empty = true;
    for (let i = offset; i < offset + 512; i++) if (bytes[i] !== 0) { empty = false; break; }
    if (empty) break;
    let name = readString(bytes, offset, 100);
    const prefix = readString(bytes, offset + 345, 155);
    if (prefix && bytes[offset + 257] === 0x75 /* 'u'star */) name = prefix + '/' + name;
    const size = readOctal(bytes, offset + 124, 12);
    const type = bytes[offset + 156];
    const start = offset + 512;
    if (start + size > bytes.length) throw new Error('The model archive is incomplete.');
    // '0' or NUL = regular file; skip dirs ('5'), pax headers ('x', 'g'), links
    if ((type === 0 || type === 0x30) && name && !isMetadata(name)) {
      entries.set(normName(name), bytes.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function tarEntry(entries, name) {
  const want = normName(name);
  if (entries.has(want)) return entries.get(want);
  for (const [key, value] of entries) if (key.endsWith('/' + want)) return value;
  throw new Error(`The model archive has no ${want}.`);
}

// --- inference.yml (the subset PaddleX writes) -------------------------------

// YAML white space is only space and tab: U+3000 or NBSP are characters
// (and appear in CJK dictionaries), so never use String#trim here.
const yamlTrim = (s) => s.replace(/^[ \t]+|[ \t]+$/g, '');
const indentOf = (line) => line.length - line.replace(/^[ \t]+/, '').length;

// One YAML scalar as js-yaml would read it for the values PaddleX emits.
export function parseYamlScalar(raw) {
  const s = yamlTrim(raw);
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|.)/g, (m, e) => {
      if (/^[uUx]/.test(e) && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
      return {
        n: '\n', t: '\t', '\t': '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v',
        '"': '"', '\\': '\\', '/': '/', ' ': ' ', _: '\u00a0', N: '\u0085', L: '\u2028', P: '\u2029'
      }[e] ?? e;
    });
  }
  // plain scalar: drop an inline comment
  return s.replace(/[ \t]+#.*$/, '');
}

// Lines of the block sequence that follows `key:` (items at any deeper or
// equal indent starting with "- "), as raw strings.
function yamlSequence(lines, keyIndex) {
  const keyIndent = indentOf(lines[keyIndex]);
  const items = [];
  for (let i = keyIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!yamlTrim(line)) continue;
    const indent = indentOf(line);
    if (indent < keyIndent || (indent === keyIndent && !line.slice(indent).startsWith('-'))) break;
    const m = /^[ \t]*-[ \t](.*)$/.exec(line) || /^[ \t]*-$/.exec(line);
    if (!m) break;
    items.push(m[1] ?? '');
  }
  return items;
}

function findKey(lines, key, from = 0) {
  const re = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`);
  for (let i = from; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) return { index: i, value: m[1] };
  }
  return null;
}

function toNumber(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).replace(/\s/g, '');
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  const parts = s.split('/'); // "1./255."
  if (parts.length === 2) {
    const n = Number(parts[0].replace(/\.+$/, ''));
    const d = Number(parts[1].replace(/\.+$/, ''));
    if (Number.isFinite(n) && Number.isFinite(d) && d) return n / d;
  }
  return fallback;
}

function modelName(lines) {
  const m = findKey(lines, 'model_name');
  return m ? parseYamlScalar(m.value) : '';
}

// Recognition config: input shape and the CTC alphabet. Like the SDK (and
// PaddleOCR's use_space_char), a space is appended as the last class.
export function parseRecConfig(text) {
  const lines = String(text).split(/\r?\n/);
  const dictKey = findKey(lines, 'character_dict');
  if (!dictKey) throw new Error('The recognition model has no character list.');
  const charDict = yamlSequence(lines, dictKey.index).map(parseYamlScalar);
  if (!charDict.length) throw new Error('The recognition model has an empty character list.');
  charDict.push(' ');
  const shapeKey = findKey(lines, 'image_shape');
  const shape = shapeKey ? yamlSequence(lines, shapeKey.index).map((v) => toNumber(parseYamlScalar(v), NaN)) : [];
  const [channels, height, width] = shape.length >= 3 && shape.every(Number.isFinite) ? shape : [3, 48, 320];
  if (channels !== 3) throw new Error(`Unexpected recognition input with ${channels} channels.`);
  return { modelName: modelName(lines), height, baseWidth: width, charDict };
}

const DET_DEFAULTS = Object.freeze({
  thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, maxCandidates: 1000,
  mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], scale: 1 / 255
});

export function parseDetConfig(text) {
  const lines = String(text).split(/\r?\n/);
  const out = { modelName: modelName(lines), ...DET_DEFAULTS };
  const post = findKey(lines, 'PostProcess');
  if (post) {
    const num = (key, fallback) => {
      const m = findKey(lines, key, post.index + 1);
      return m ? toNumber(parseYamlScalar(m.value), fallback) : fallback;
    };
    out.thresh = num('thresh', out.thresh);
    out.boxThresh = num('box_thresh', out.boxThresh);
    out.unclipRatio = num('unclip_ratio', out.unclipRatio);
    out.maxCandidates = num('max_candidates', out.maxCandidates);
  }
  const norm = findKey(lines, 'NormalizeImage');
  if (norm) {
    const list = (key, fallback) => {
      const m = findKey(lines, key, norm.index + 1);
      if (!m) return fallback;
      const v = yamlSequence(lines, m.index).map((x) => toNumber(parseYamlScalar(x), NaN));
      return v.length === 3 && v.every(Number.isFinite) ? v : fallback;
    };
    out.mean = list('mean', out.mean);
    out.std = list('std', out.std);
    const sc = findKey(lines, 'scale', norm.index + 1);
    if (sc) out.scale = toNumber(parseYamlScalar(sc.value), out.scale);
  }
  return out;
}

// --- resampling ---------------------------------------------------------------

// OpenCV INTER_LINEAR source taps for one axis: pixel-centre aligned and
// clamped exactly like cv::resize, so tensors match the SDK's.
function linearTaps(srcLen, dstLen) {
  const i0 = new Int32Array(dstLen);
  const f = new Float32Array(dstLen);
  const scale = srcLen / dstLen;
  for (let d = 0; d < dstLen; d++) {
    let x = (d + 0.5) * scale - 0.5;
    let s = Math.floor(x);
    x -= s;
    if (s < 0) { x = 0; s = 0; }
    if (s >= srcLen - 1) { x = 0; s = srcLen - 1; }
    i0[d] = s;
    f[d] = x;
  }
  return { i0, f };
}

// Bilinear-resize img to dstW x dstH and write BGR planes, normalised as
// (v * scale - mean[c]) / std[c], into out (planar CHW). `stride` is the
// padded row width of the tensor and `base` the sample's offset; columns
// beyond dstW are left untouched (callers zero-fill = SDK padding).
export function writeTensor(img, dstW, dstH, out, { base = 0, stride = dstW, planeH = dstH, mean, std, scale = 1 / 255 }) {
  const { width: sw, height: sh, data } = img;
  const tx = linearTaps(sw, dstW);
  const ty = linearTaps(sh, dstH);
  const plane = planeH * stride;
  // mean/std are indexed by tensor channel; channel 0 is B (BGR models)
  const k0 = scale / std[0], k1 = scale / std[1], k2 = scale / std[2];
  const m0 = mean[0] / std[0], m1 = mean[1] / std[1], m2 = mean[2] / std[2];
  const sx1 = new Int32Array(dstW);
  for (let x = 0; x < dstW; x++) sx1[x] = Math.min(tx.i0[x] + 1, sw - 1);
  for (let y = 0; y < dstH; y++) {
    const y0 = ty.i0[y];
    const y1 = Math.min(y0 + 1, sh - 1);
    const fy = ty.f[y];
    const r0 = y0 * sw * 4;
    const r1 = y1 * sw * 4;
    const rowOut = base + y * stride;
    for (let x = 0; x < dstW; x++) {
      const fx = tx.f[x];
      const a = r0 + tx.i0[x] * 4, b = r0 + sx1[x] * 4, c = r1 + tx.i0[x] * 4, d = r1 + sx1[x] * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      // round to 8 bits like cv::resize on CV_8U before normalising
      const R = Math.round(data[a] * w00 + data[b] * w01 + data[c] * w10 + data[d] * w11);
      const G = Math.round(data[a + 1] * w00 + data[b + 1] * w01 + data[c + 1] * w10 + data[d + 1] * w11);
      const B = Math.round(data[a + 2] * w00 + data[b + 2] * w01 + data[c + 2] * w10 + data[d + 2] * w11);
      const o = rowOut + x;
      out[o] = B * k0 - m0;
      out[o + plane] = G * k1 - m1;
      out[o + 2 * plane] = R * k2 - m2;
    }
  }
  return out;
}

export function cropImage(img, { x, y, w, h }) {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.round(x + w)));
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.round(y + h)));
  const cw = x1 - x0, ch = y1 - y0;
  const data = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const s = ((y0 + row) * img.width + x0) * 4;
    data.set(img.data.subarray(s, s + cw * 4), row * cw * 4);
  }
  return { width: cw, height: ch, data, x: x0, y: y0 };
}

// --- recognition (CTC) -------------------------------------------------------

export const REC_NORMALIZE = Object.freeze({ mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], scale: 1 / 255 });
export const MAX_REC_WIDTH = 3200;

// SDK preprocessSample: height 48, width from the aspect ratio, padded to at
// least the model's base width (320) so short words keep their proportions.
export function recGeometry(srcW, srcH, height = 48, baseWidth = 320) {
  const ratio = srcW / Math.max(1, srcH);
  const maxRatio = Math.max(baseWidth / Math.max(1, height), ratio);
  const recW = Math.max(1, Math.min(MAX_REC_WIDTH, Math.trunc(height * maxRatio)));
  const resizedW = Math.max(1, Math.min(recW, Math.ceil(height * ratio)));
  return { recW, resizedW };
}

// Glyph shape of a text strip: median ink-run width / ink height. Tile
// fonts (8×8 cells: GB, NES, SNES) are ~0.7–0.9; proportional fonts and
// the printed text the recogniser was trained on are ~0.4–0.55. Returns
// null when the strip has no clear ink.
export function inkShape(img) {
  const { width: w, height: h, data } = img;
  if (w < 4 || h < 4) return null;
  // background = the most common corner colour (strips are padded with it)
  const corner = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const cs = [corner(0, 0), corner(w - 1, 0), corner(0, h - 1), corner(w - 1, h - 1)];
  const same = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 30;
  const bg = cs.reduce((best, c) => (cs.filter((o) => same(o, c)).length > cs.filter((o) => same(o, best)).length ? c : best), cs[0]);
  const dist = new Uint16Array(w * h);
  let maxD = 0;
  for (let i = 0, p = 0; i < dist.length; i++, p += 4) {
    const d = Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) + Math.abs(data[p + 2] - bg[2]);
    dist[i] = d;
    if (d > maxD) maxD = d;
  }
  if (maxD < 90) return null;
  const cut = maxD / 2;
  const rowInk = new Uint32Array(h);
  const colInk = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (dist[y * w + x] > cut) { rowInk[y]++; colInk[x] = 1; }
    }
  }
  const peak = Math.max(...rowInk);
  // rows carrying the bulk of the glyphs (accents and descenders excluded),
  // and the full extent from the highest to the lowest ink row
  let inkH = 0;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    if (rowInk[y] >= 0.2 * peak) inkH++;
    if (rowInk[y]) { if (top < 0) top = y; bottom = y; }
  }
  const runs = [];
  for (let x = 0, run = 0; x <= w; x++) {
    if (x < w && colInk[x]) run++;
    else if (run) { runs.push(run); run = 0; }
  }
  const glyphRuns = runs.filter((r) => r < 3 * inkH); // drop rules and bars
  if (!inkH || !glyphRuns.length) return null;
  glyphRuns.sort((a, b) => a - b);
  const median = glyphRuns[glyphRuns.length >> 1];
  return { inkH, extent: bottom - top + 1, run: median, ratio: median / inkH, runs: glyphRuns.length };
}

// Horizontal squeeze for recognition: wide tile-font glyphs read better
// at proportions closer to the printed text the model was trained on
// (bench: "TAUESI" → "TAUBSI", "Aquf" → "Aquí", "SI CHERN" → "SICHERN").
// Tile fonts are recognised by shape AND size: a line whose ink, accents
// and descenders included, spans at most `maxTileH` native pixels (an 8×8
// cell; the GBA font with its shadow spans 9–12), so proportional fonts are
// never squeezed. `k` is the strip's upscale factor.
export function autoAspect(img, { k = 1, wide = 0.6, maxTileH = 8.5, squeeze = 0.75 } = {}) {
  const shape = inkShape(img);
  return shape && shape.ratio >= wide && shape.extent / Math.max(1, k) <= maxTileH ? squeeze : 1;
}

// Group samples for batched inference. Samples are sorted by width and only
// share a batch when their padded widths are close, because extra right
// padding can change what the recogniser reads at the end of a line.
export function planRecBatches(widths, { maxBatch = 6, maxPadRatio = 1.15 } = {}) {
  const order = widths.map((w, i) => ({ w, i })).sort((a, b) => a.w - b.w);
  const batches = [];
  let cur = null;
  for (const s of order) {
    if (!cur || cur.items.length >= maxBatch || s.w > cur.minW * maxPadRatio) {
      cur = { minW: s.w, width: s.w, items: [] };
      batches.push(cur);
    }
    cur.items.push(s.i);
    cur.width = Math.max(cur.width, s.w);
  }
  return batches.map(({ width, items }) => ({ width, items }));
}

// Greedy CTC decode of one sample: class 0 is blank, repeats collapse, the
// score is the mean probability of the emitted characters (as the SDK).
export function ctcDecode(data, offset, steps, classes, dict) {
  let prev = -1;
  let text = '';
  let sum = 0;
  let n = 0;
  for (let t = 0; t < steps; t++) {
    const base = offset + t * classes;
    let best = 0;
    let bestVal = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = data[base + c];
      if (v > bestVal) { bestVal = v; best = c; }
    }
    if (best > 0 && best !== prev && best - 1 < dict.length) {
      text += dict[best - 1];
      sum += bestVal;
      n++;
    }
    prev = best;
  }
  return { text, score: n ? sum / n : 0 };
}

// --- detection (DB) ------------------------------------------------------------

// SDK preprocessSample$1: 'max' only ever shrinks, 'min' grows; sides are
// rounded to multiples of 32.
export function detGeometry(srcW, srcH, { limitSideLen = 960, limitType = 'max', maxSideLimit = 4000 } = {}) {
  const limit = Math.max(32, limitSideLen);
  const maxSide = Math.max(32, maxSideLimit);
  let scale = 1;
  if (limitType === 'max') {
    if (Math.max(srcW, srcH) > limit) scale = limit / Math.max(srcW, srcH);
  } else if (Math.min(srcW, srcH) < limit) {
    scale = limit / Math.max(1, Math.min(srcW, srcH));
  }
  let dstW = Math.max(32, Math.round((srcW * scale) / 32) * 32);
  let dstH = Math.max(32, Math.round((srcH * scale) / 32) * 32);
  if (Math.max(dstW, dstH) > maxSide) {
    const s = maxSide / Math.max(dstW, dstH);
    dstW = Math.max(32, Math.floor(dstW * s));
    dstH = Math.max(32, Math.floor(dstH * s));
  }
  dstW = Math.max(32, Math.round(Math.min(dstW, maxSide) / 32) * 32);
  dstH = Math.max(32, Math.round(Math.min(dstH, maxSide) / 32) * 32);
  return { dstW, dstH };
}

const DET_BOX_MIN_SIZE = 3;

// DB post-processing on the probability map (mapW x mapH): threshold,
// 8-connected components, mean-score filter, unclip (offset by
// area * ratio / perimeter, as the Clipper offset of a rectangle) and
// scaling back to source pixels. Returns [{ x, y, w, h, score }] sorted by
// top then left. Axis-aligned stand-in for the SDK's findContours +
// minAreaRect path.
export function detBoxes(prob, mapW, mapH, srcW, srcH, { thresh = 0.3, boxThresh = 0.6, unclipRatio = 1.5, maxCandidates = 1000 } = {}) {
  const n = mapW * mapH;
  const label = new Int32Array(n); // 0 = unvisited
  const stack = new Int32Array(n);
  const boxes = [];
  let comp = 0;
  for (let start = 0; start < n && comp < maxCandidates; start++) {
    if (label[start] || !(prob[start] > thresh)) continue;
    comp++;
    let sp = 0;
    stack[sp++] = start;
    label[start] = comp;
    let minX = mapW, minY = mapH, maxX = -1, maxY = -1, count = 0;
    while (sp) {
      const p = stack[--sp];
      const px = p % mapW;
      const py = (p - px) / mapW;
      count++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= mapH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= mapW) continue;
          const q = ny * mapW + nx;
          if (!label[q] && prob[q] > thresh) { label[q] = comp; stack[sp++] = q; }
        }
      }
    }
    // findContours needs >= 4 boundary points; minAreaRect side >= 3
    const bw = maxX - minX;
    const bh = maxY - minY;
    if (count < 4 || Math.min(bw, bh) < DET_BOX_MIN_SIZE) continue;
    let sum = 0;
    for (let y = minY; y <= maxY; y++) {
      const row = y * mapW;
      for (let x = minX; x <= maxX; x++) sum += prob[row + x];
    }
    const score = sum / ((bw + 1) * (bh + 1));
    if (score < boxThresh) continue;
    const dist = (bw * bh * unclipRatio) / (2 * (bw + bh));
    const ux0 = minX - dist, uy0 = minY - dist, ux1 = maxX + dist, uy1 = maxY + dist;
    if (Math.min(ux1 - ux0, uy1 - uy0) < DET_BOX_MIN_SIZE + 2) continue;
    const sx = srcW / mapW, sy = srcH / mapH;
    const x0 = clamp(Math.round(ux0 * sx), 0, srcW), x1 = clamp(Math.round(ux1 * sx), 0, srcW);
    const y0 = clamp(Math.round(uy0 * sy), 0, srcH), y1 = clamp(Math.round(uy1 * sy), 0, srcH);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score });
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// --- line merging ---------------------------------------------------------------

function verticalOverlap(a, b) {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, bottom - top) / Math.max(1, Math.min(a.h, b.h));
}

function horizontalGap(a, b) {
  return Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w); // < 0 when overlapping
}

export function canMergeBoxes(a, b, { minOverlap = 0.5, maxGap = 1.5, minHeightRatio = 0.5 } = {}) {
  const hMin = Math.min(a.h, b.h);
  const hMax = Math.max(a.h, b.h);
  return hMin / Math.max(1, hMax) >= minHeightRatio &&
    verticalOverlap(a, b) > minOverlap &&
    horizontalGap(a, b) < maxGap * hMin;
}

function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.max(a.x + a.w, b.x + b.w) - x;
  const h = Math.max(a.y + a.h, b.y + b.h) - y;
  const wa = a.w * a.h, wb = b.w * b.h;
  return { x, y, w, h, score: (a.score * wa + b.score * wb) / Math.max(1, wa + wb), parts: (a.parts || 1) + (b.parts || 1) };
}

// Union det boxes that belong to the same text line BEFORE recognition:
// the detector splits pixel-font lines into overlapping word boxes, and
// joining their texts afterwards duplicates the glyphs where they overlap
// ("Hello t" + "there!"). Returns boxes sorted in reading order.
export function mergeLineBoxes(boxes, opts) {
  let list = boxes.map((b) => ({ ...b, parts: b.parts || 1 }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (canMergeBoxes(list[i], list[j], opts)) {
          list[i] = unionBox(list[i], list[j]);
          list.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return sortReadingOrder(list);
}

// Top-to-bottom rows (vertical-centre overlap), left-to-right within a row.
export function sortReadingOrder(boxes) {
  const rows = [];
  for (const b of [...boxes].sort((p, q) => p.y + p.h / 2 - (q.y + q.h / 2))) {
    const cy = b.y + b.h / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < 0.5 * Math.min(r.h, b.h));
    if (row) row.items.push(b);
    else rows.push({ cy, h: b.h, items: [b] });
  }
  return rows.flatMap((r) => r.items.sort((p, q) => p.x - q.x));
}

// --- coordinates --------------------------------------------------------------

// Box in an image upscaled by k whose (0,0) is `offset` in the native frame.
export function toNativeBox(box, k = 1, offset = { x: 0, y: 0 }) {
  const s = k > 0 ? k : 1;
  const r = (v) => Math.round(v * 100) / 100;
  return {
    x: r((offset?.x || 0) + box.x / s),
    y: r((offset?.y || 0) + box.y / s),
    w: r(box.w / s),
    h: r(box.h / s)
  };
}
