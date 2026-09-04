// Tesseract.js-based OCR engine with canvas pre-processing.

let worker = null;
let workerPromise = null;
let currentLang = null;

async function ensureWorker(lang, onProgress) {
  if (worker && currentLang === lang) return worker;
  if (workerPromise && currentLang === lang) return workerPromise;
  currentLang = lang;
  workerPromise = (async () => {
    if (worker) { await worker.terminate(); worker = null; }
    if (onProgress) onProgress({ status: `downloading ${lang} OCR data (once, ~12 MB)`, progress: 0 });
    worker = await Tesseract.createWorker(lang, 1, {
      // float LSTM models: noticeably better on tiny game fonts than the default
      langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
      logger: (m) => { if (onProgress) onProgress(m); },
      errorHandler: () => {}
    });
    // dialogue boxes are one uniform block of text; fake a print DPI and
    // keep common border-art characters out of the output
    const psm = (window.Tesseract && Tesseract.PSM && Tesseract.PSM.SINGLE_BLOCK) || '6';
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      user_defined_dpi: '300',
      tessedit_char_blacklist: '_|~{}[]<>^°'
    });
    return worker;
  })();
  return workerPromise;
}

export async function terminateOcr() {
  if (worker) { try { await worker.terminate(); } catch {} worker = null; workerPromise = null; currentLang = null; }
}

// Pre-process: crop, upscale (nearest neighbour - keeps pixel-font edges
// crisp), grayscale, binarize (Otsu threshold)
function preprocess(canvas, rect, scale) {
  // aim for a crop around 400px tall; native-pixel crops are crisp so a
  // strong upscale is safe
  let s = scale || 3;
  if (rect.h > 10) s = Math.round(400 / rect.h);
  s = Math.max(2, Math.min(10, s));
  const maxDim = Math.max(rect.w, rect.h);
  if (maxDim * s > 1600) s = Math.max(1, Math.floor(1600 / maxDim));
  s = Math.max(1, s);
  const w = Math.max(8, Math.round((rect.w) * s));
  const h = Math.max(8, Math.round((rect.h) * s));
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // grayscale histogram for Otsu
  const hist = new Array(256).fill(0);
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[p] = g;
    hist[g]++;
  }
  // Otsu
  const total = w * h;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    const v = gray[p] > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// rect: {x, y, w, h} in canvas coordinates. lang: e.g. "deu", "eng"
export async function ocrRegion(canvas, rect, lang, onProgress) {
  const processed = preprocess(canvas, rect, 3);
  const wrk = await ensureWorker(lang, onProgress);
  const { data } = await wrk.recognize(processed);
  // join lines, de-hyphenating words the game wrapped across lines
  // ("auf-" + "geweckt" -> "aufgeweckt")
  const lines = (data.text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let text = '';
  for (const line of lines) {
    if (!text) { text = line; continue; }
    if (/\p{L}-$/u.test(text)) text = text.slice(0, -1) + line;
    else text += ' ' + line;
  }
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    confidence: data.confidence || 0
  };
}

// Locate dialog boxes. If a grid is provided, the frame is first downscaled
// to the core's native resolution (160x144 for GB) - recovering the crisp
// pixel grid from the blurry GL upscale - and detection + cropping happen
// there. Returns { canvas: analysisCanvas, rects } with rects in that
// canvas' coordinates. Returns up to `max` rects, bottom-most first.
export function detectTextRects(canvas, max = 2, grid = null) {
  let work = canvas;
  if (grid && grid.nativeW) {
    const nc = document.createElement('canvas');
    nc.width = grid.nativeW; nc.height = grid.nativeH;
    const nctx = nc.getContext('2d', { willReadFrequently: true });
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(canvas, grid.x0, grid.y0, grid.contentW, grid.contentH, 0, 0, grid.nativeW, grid.nativeH);
    work = nc;
  }
  const w = work.width, h = work.height;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  const colDark = new Uint16Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      lum[y * w + x] = l;
      if (l < 90) colDark[x]++;
    }
  }
  // trim letterbox bars (columns that are almost solid dark)
  let cx0 = 0, cx1 = w - 1;
  while (cx0 < cx1 && colDark[cx0] >= h * 0.95) cx0++;
  while (cx1 > cx0 && colDark[cx1] >= h * 0.95) cx1--;
  if (cx1 - cx0 < 8) return { canvas: work, rects: [] };
  const cw = cx1 - cx0 + 1;
  const contrastThreshold = Math.max(4, Math.round(cw * 0.03));
  // per-row light/dark counts within content columns
  const rowLight = new Uint16Array(h), rowDark = new Uint16Array(h);
  for (let y = 0; y < h; y++) {
    let li = 0, da = 0;
    for (let x = cx0; x <= cx1; x++) {
      const l = lum[y * w + x];
      if (l < 90) da++; else if (l > 150) li++;
    }
    rowLight[y] = li; rowDark[y] = da;
  }
  // bands of "contrast" rows that are LIGHT-dominant: box interiors mix
  // white background with dark text/borders. Dark-dominant rows (the box
  // borders, black letterbox) must NOT seed - otherwise the interior
  // expansion walks from a border into the background and swallows the
  // whole frame into one unusable band.
  const rawBands = [];
  let cur = null, miss = 0;
  for (let y = 0; y < h; y++) {
    if (rowDark[y] >= contrastThreshold && rowLight[y] > rowDark[y]) {
      if (!cur) cur = { y0: y, y1: y };
      cur.y1 = y; miss = 0;
    } else if (cur) {
      if (++miss > 5) { rawBands.push(cur); cur = null; }
    }
  }
  if (cur) rawBands.push(cur);
  // expand each seed band until a dark-dominant row (box border / black
  // background) - text rows and white gap rows are all interior. On the
  // native grid borders are ~90% dark vs ~25% for text rows, so this
  // cleanly spans multi-line boxes without leaking into the background.
  const boxy = (y) => y >= 0 && y < h && rowDark[y] < cw * 0.75;
  for (const b of rawBands) {
    while (boxy(b.y0 - 1)) b.y0--;
    while (boxy(b.y1 + 1)) b.y1++;
  }
  // after interior expansion, each box is already one band; only fuse
  // bands that practically touch (a thin border must NOT re-join separate
  // boxes, otherwise background+sprite bands swallow the dialog again)
  const mergeGap = 2;
  const mergedBands = [];
  for (const b of rawBands) {
    const last = mergedBands[mergedBands.length - 1];
    if (last && b.y0 - last.y1 <= mergeGap) last.y1 = b.y1;
    else mergedBands.push({ ...b });
  }
  const bands = mergedBands.filter((b) => {
    const bh = b.y1 - b.y0;
    if (bh < 4) return false;
    // a band expanded across most of the frame is a background + sprite,
    // not a text box (real GB dialog boxes are ~33% of the screen)
    return bh <= h * 0.42;
  });
  if (!bands.length) return { canvas: work, rects: [] };
  const picked = bands.slice(-max);
  const rects = [];
  for (const b of picked) {
    // horizontal extent of box pixels (light or dark) within the band
    let minX = w, maxX = -1;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        const l = lum[y * w + x];
        if (l < 90 || l > 150) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
      }
    }
    if (maxX <= minX) continue;
    const pad = 2;
    const x0 = Math.max(cx0, minX - pad);
    const y0 = Math.max(0, b.y0 - pad);
    const x1 = Math.min(cx1 + 1, maxX + pad + 1);
    const y1 = Math.min(h, b.y1 + pad + 1);
    // inset past the box border lines
    const insetY = Math.max(2, Math.round((y1 - y0) * 0.08));
    const insetX = Math.max(2, Math.round((x1 - x0) * 0.04));
    rects.push({
      x: x0 + insetX,
      y: y0 + insetY,
      w: Math.max(6, x1 - x0 - insetX * 2),
      h: Math.max(6, y1 - y0 - insetY * 2)
    });
  }
  return { canvas: work, rects };
}

// temporary debug helper (used by romtest.html)
export function debugDetect(canvas, grid = null) {
  const res = detectTextRects(canvas, 4, grid);
  const work = res.canvas;
  const w = work.width, h = work.height;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;
  const rowLight = new Uint16Array(h), rowDark = new Uint16Array(h);
  for (let y = 0; y < h; y++) {
    let li = 0, da = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (l < 90) da++; else if (l > 150) li++;
    }
    rowLight[y] = li; rowDark[y] = da;
  }
  const profile = [];
  for (let y = 0; y < h; y += Math.max(1, Math.round(h / 48))) {
    profile.push(y + ':' + rowLight[y] + '/' + rowDark[y]);
  }
  return { rects: res.rects, rowProfile: profile };
}

// single-rect convenience (manual zone fallback etc.)
export function detectTextRect(canvas) {
  const rects = detectTextRects(canvas, 1);
  if (rects.length) return rects[0];
  return { x: Math.round(canvas.width * 0.06), y: Math.round(canvas.height * 0.70), w: Math.round(canvas.width * 0.88), h: Math.round(canvas.height * 0.26) };
}
