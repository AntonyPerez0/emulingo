// Native frame capture from the emulator canvas.
//
// EmulatorJS draws the core's frame into a WebGL canvas sized to its CSS box
// (× devicePixelRatio): aspect-fit, nearest-neighbour, with fully transparent
// (alpha 0) letterbox bars. Portrait layouts top-align the picture, and the
// rounded viewport can then start a pixel above the canvas. We
// recover the exact native frame with ONE drawImage of the content rect into a
// native-size canvas with smoothing OFF — every destination pixel samples the
// middle of its source run, so the result is pixel-exact (0 % error, against
// 6–16 % with smoothing) — and ONE getImageData of native size (92 KB for GB).
//
// The content rect is cached per canvas/native size and re-measured from the
// alpha channel when the size changes, every few seconds, or when a grabbed
// frame shows transparent edges (the rect went stale).
//
// The scratch canvases are deliberately GPU-backed (willReadFrequently:
// false): drawImage from the WebGL canvas is then a GPU blit of only the
// native-size result and the readback is 92 KB. A CPU canvas would force a
// readback of the whole WebGL backing store (5.9 MB at 1280×1152) per grab.

// Native sizes we can infer from the picture's aspect ratio when the core
// does not report its video dimensions.
const KNOWN_DIMS = [[160, 144], [240, 160], [256, 224], [256, 240], [256, 192], [320, 224], [320, 240]];
const PROBE_LINES = 9;        // strips sampled to find the alpha>0 bounds
const RECHECK_EVERY = 50;     // grabs between content-rect re-measurements (~10 s at 200 ms)
const MAX_NATIVE = 1024;      // sanity cap on reported video dimensions

export function createFrameSource({ getCanvas, getVideoDims } = {}) {
  let work = null;            // native-size canvas, reused
  let wctx = null;
  let probe = null;           // strip canvas for the alpha scan, reused
  let pctx = null;
  let rect = null;            // { x, y, w, h } content rect in canvas px
  let rectKey = '';
  let sinceCheck = 0;

  function ensureWork(w, h) {
    if (!work) ({ canvas: work, ctx: wctx } = canvas2d(w, h));
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    // resizing resets the context state, so set this every time
    wctx.imageSmoothingEnabled = false;
    return wctx;
  }

  function ensureProbe(w, h) {
    if (!probe) ({ canvas: probe, ctx: pctx } = canvas2d(w, h));
    if (probe.width !== w || probe.height !== h) { probe.width = w; probe.height = h; }
    pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, w, h);
    return pctx;
  }

  // Bounding box of alpha>0 pixels, from a few full-resolution rows and
  // columns (nearest-sampled strips: exact along their long axis).
  function measureAlpha(canvas, cw, ch) {
    const rows = ensureProbe(cw, PROBE_LINES);
    rows.drawImage(canvas, 0, 0, cw, ch, 0, 0, cw, PROBE_LINES);
    const a = rows.getImageData(0, 0, cw, PROBE_LINES).data;
    let left = cw, right = -1;
    for (let j = 0; j < PROBE_LINES; j++) {
      const o = j * cw;
      for (let x = 0; x < cw; x++) if (a[(o + x) * 4 + 3]) { if (x < left) left = x; break; }
      for (let x = cw - 1; x >= 0; x--) if (a[(o + x) * 4 + 3]) { if (x > right) right = x; break; }
    }
    if (right < 0) return null;
    const cols = ensureProbe(PROBE_LINES, ch);
    cols.drawImage(canvas, 0, 0, cw, ch, 0, 0, PROBE_LINES, ch);
    const b = cols.getImageData(0, 0, PROBE_LINES, ch).data;
    let top = ch, bottom = -1;
    for (let i = 0; i < PROBE_LINES; i++) {
      for (let y = 0; y < ch; y++) if (b[(y * PROBE_LINES + i) * 4 + 3]) { if (y < top) top = y; break; }
      for (let y = ch - 1; y >= 0; y--) if (b[(y * PROBE_LINES + i) * 4 + 3]) { if (y > bottom) bottom = y; break; }
    }
    if (bottom < 0) return null;
    return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  }

  function locate(canvas, cw, ch, dims) {
    const measured = measureAlpha(canvas, cw, ch);
    if (!measured) return null;
    const native = dims || inferDims(measured.w, measured.h);
    if (!native) return null;
    return { rect: contentRect(measured, cw, ch, native), native };
  }

  // Measures the content rect again; false when nothing is drawn.
  function relocate(canvas, cw, ch, dims, key) {
    const found = locate(canvas, cw, ch, dims);
    if (!found) { rect = null; rectKey = ''; return false; }
    rect = found.rect; rect.native = found.native; rectKey = key; sinceCheck = 0;
    return true;
  }

  function grabUnsafe() {
    const canvas = getCanvas?.();
    if (!canvas) return null;
    const cw = canvas.width | 0, ch = canvas.height | 0;
    if (cw < 2 || ch < 2) return null;
    const dims = videoDims();
    const key = `${cw}x${ch}|${dims ? `${dims.w}x${dims.h}@${dims.aspect || ''}` : '?'}`;
    let fresh = false;
    if (key !== rectKey || !rect || ++sinceCheck >= RECHECK_EVERY) {
      if (!relocate(canvas, cw, ch, dims, key)) return null;
      fresh = true;
    }
    let img = readNative(canvas, rect, rect.native);
    let edges = transparentEdges(img);
    if (edges === 'all') return null;
    if (edges && !fresh && !rect.edgy) {
      // the viewport moved inside an unchanged canvas: measure again, once
      if (!relocate(canvas, cw, ch, dims, key)) return null;
      img = readNative(canvas, rect, rect.native);
      edges = transparentEdges(img);
      if (edges === 'all') return null;
    }
    // edges that survive a fresh measurement belong to this layout: do not
    // pay for two extra readbacks on every grab until the next re-check
    if (edges) rect.edgy = true;
    opaque(img.data);
    return { img, w: rect.native.w, h: rect.native.h, t: now() };
  }

  // A core that cannot report its size is not fatal: infer it instead.
  function videoDims() {
    try { return validDims(getVideoDims?.()); } catch { return null; }
  }

  // A transform instead of a source rect: the viewport can start outside
  // the canvas (portrait top alignment clips its first row), and source
  // rects outside the image are clipped rather than mapped.
  function readNative(canvas, r, native) {
    const ctx = ensureWork(native.w, native.h);
    const sx = native.w / r.w, sy = native.h / r.h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, native.w, native.h);
    ctx.setTransform(sx, 0, 0, sy, -r.x * sx, -r.y * sy);
    ctx.drawImage(canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx.getImageData(0, 0, native.w, native.h);
  }

  return {
    grab() {
      try { return grabUnsafe(); } catch { return null; }
    },
    // for diagnostics: the content rect (canvas px) of the last grab
    get contentRect() { return rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null; }
  };
}

// RetroArch's aspect-fit viewport size (gl2_set_viewport arithmetic): the
// constrained side fills the canvas, the other is rounded.
export function viewportSize(cw, ch, aspect) {
  const device = cw / ch;
  if (Math.abs(device - aspect) < 0.0001) return { w: cw, h: ch };
  return device > aspect ? { w: Math.round(ch * aspect), h: ch } : { w: cw, h: Math.round(cw / aspect) };
}

// The core's viewport (canvas px) from the alpha>0 box. The box is exact,
// except that RetroArch may push a rounded viewport 1–2 px past a canvas
// edge (portrait top alignment: 374×610 canvas, viewport y = -1, h = 337);
// the visible box is then short and touches that edge, so extend it out.
export function contentRect(measured, cw, ch, native) {
  const aspect = native.aspect > 0 ? native.aspect : native.w / native.h;
  const fit = viewportSize(cw, ch, aspect);
  const [x, w] = place(measured.x, measured.w, fit.w, cw);
  const [y, h] = place(measured.y, measured.h, fit.h, ch);
  return { x, y, w, h };
}

function place(start, len, fit, total) {
  if (len >= fit || fit - len > 2) return [start, len];
  if (start === 0 && len < total) return [len - fit, fit];
  if (start + len === total && start > 0) return [start, fit];
  return [start, len];
}

// Nearest-neighbour integer upscale. Rows are built once and copied, which
// keeps a 640×576 GB ×4 upscale well under a millisecond.
export function upscaleNearest(img, k) {
  k = Math.max(1, Math.floor(k) || 1);
  const w = img.width, h = img.height, W = w * k, H = h * k;
  const bytes = img.data.byteOffset % 4 ? img.data.slice() : img.data;
  const src = new Uint32Array(bytes.buffer, bytes.byteOffset, w * h);
  const out = new Uint8ClampedArray(W * H * 4);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    const row = y * k * W;
    let o = row;
    for (let x = 0, s = y * w; x < w; x++, s++) {
      const v = src[s];
      for (let i = 0; i < k; i++) dst[o++] = v;
    }
    for (let i = 1; i < k; i++) dst.copyWithin(row + i * W, row, row + W);
  }
  return makeImageData(out, W, H);
}

// FNV-1a over the RGB of every pixel in rect, each channel quantised to its
// top 4 bits so filtering noise cannot change the hash. One 12-bit symbol per
// pixel: xor-then-multiply by an odd constant is a bijection, so a frame
// differing in a single (quantised) pixel can never collide.
export function fnv1a(img, rect) {
  const { data, width, height } = img;
  const x0 = rect ? clampInt(rect.x, 0, width) : 0;
  const y0 = rect ? clampInt(rect.y, 0, height) : 0;
  const x1 = rect ? clampInt(rect.x + rect.w, x0, width) : width;
  const y1 = rect ? clampInt(rect.y + rect.h, y0, height) : height;
  let h = 0x811c9dc5;
  for (let y = y0; y < y1; y++) {
    for (let i = (y * width + x0) * 4, e = (y * width + x1) * 4; i < e; i += 4) {
      h ^= ((data[i] & 0xf0) << 4) | (data[i + 1] & 0xf0) | (data[i + 2] >> 4);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

// ImageData where the platform has it (browsers, workers); a structurally
// identical object elsewhere (Node tests).
export function makeImageData(data, w, h) {
  if (typeof ImageData === 'function') {
    try { return new ImageData(data, w, h); } catch { /* fall through */ }
  }
  return { data, width: w, height: h, colorSpace: 'srgb' };
}

// ---------------------------------------------------------------- helpers

// A 2D scratch canvas: OffscreenCanvas where it has a 2D context (Safari
// < 16.4 lacks one), else a detached <canvas>.
function canvas2d(w, h) {
  const opts = { willReadFrequently: false, alpha: true };
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', opts);
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d', opts) };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function validDims(d) {
  const w = d && Math.round(+d.w), h = d && Math.round(+d.h);
  if (!(w > 0 && h > 0 && w <= MAX_NATIVE && h <= MAX_NATIVE)) return null;
  // optional display aspect (e.g. NES 256×240 shown at 4:3), as EmulatorJS reports it
  const aspect = +d.aspect;
  return aspect > 0.2 && aspect < 5 ? { w, h, aspect } : { w, h };
}

function inferDims(w, h) {
  const ar = w / h;
  let best = null, err = 0.03;
  for (const [nw, nh] of KNOWN_DIMS) {
    const e = Math.abs(nw / nh - ar) / ar;
    if (e < err) { err = e; best = { w: nw, h: nh }; }
  }
  return best;
}

// 'all' when the frame is fully transparent (nothing drawn / buffer
// cleared), true when an outer row or column has transparent pixels (the
// content rect is stale), false otherwise.
function transparentEdges(img) {
  const { data, width: w, height: h } = img;
  let any = false;
  for (let i = 3; i < data.length; i += 4) if (data[i]) { any = true; break; }
  if (!any) return 'all';
  for (let x = 0; x < w; x++) if (!data[x * 4 + 3] || !data[((h - 1) * w + x) * 4 + 3]) return true;
  for (let y = 0; y < h; y++) if (!data[y * w * 4 + 3] || !data[(y * w + w - 1) * 4 + 3]) return true;
  return false;
}

function opaque(data) {
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
}

function clampInt(v, lo, hi) {
  v = Math.round(+v || 0);
  return v < lo ? lo : v > hi ? hi : v;
}
