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
    worker = await Tesseract.createWorker(lang, 1, {
      logger: (m) => { if (onProgress) onProgress(m); },
      errorHandler: () => {}
    });
    // dialogue boxes are one uniform block of text
    const psm = (window.Tesseract && Tesseract.PSM && Tesseract.PSM.SINGLE_BLOCK) || '6';
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    return worker;
  })();
  return workerPromise;
}

export async function terminateOcr() {
  if (worker) { try { await worker.terminate(); } catch {} worker = null; workerPromise = null; currentLang = null; }
}

// Pre-process: crop, scale up, grayscale, binarize (Otsu threshold)
function preprocess(canvas, rect, scale) {
  let s = scale || 3;
  const maxDim = Math.max(rect.w, rect.h);
  if (maxDim * s > 1400) s = Math.max(1, Math.floor(1400 / maxDim));
  const w = Math.max(8, Math.round((rect.w) * s));
  const h = Math.max(8, Math.round((rect.h) * s));
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
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
  return {
    text: (data.text || '').replace(/\s+/g, ' ').trim(),
    confidence: data.confidence || 0
  };
}

// Locate the dialog text: trim letterbox bars, find the densest band of
// dark rows (the dialog box), crop to its dark-pixel extent and inset a
// little to skip the box border lines.
export function detectTextRect(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  const colDark = new Uint16Array(w), rowDark = new Uint16Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      lum[y * w + x] = l;
      if (l < 90) { colDark[x]++; rowDark[y]++; }
    }
  }
  // trim letterbox bars (columns/rows that are almost solid dark)
  let cx0 = 0, cx1 = w - 1, cy0 = 0, cy1 = h - 1;
  const solidCol = h * 0.95, solidRow = w * 0.95;
  while (cx0 < cx1 && colDark[cx0] >= solidCol) cx0++;
  while (cx1 > cx0 && colDark[cx1] >= solidCol) cx1--;
  if (cx1 - cx0 < 8) return { x: Math.round(w * 0.06), y: Math.round(h * 0.70), w: Math.round(w * 0.88), h: Math.round(h * 0.26) };
  // re-count row darkness within content columns only (bars would
  // otherwise make every row look text-y)
  rowDark.fill(0);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = cx0; x <= cx1; x++) {
      if (lum[y * w + x] < 90) c++;
    }
    rowDark[y] = c;
  }
  while (cy0 < cy1 && rowDark[cy0] >= solidRow) cy0++;
  while (cy1 > cy0 && rowDark[cy1] >= solidRow) cy1--;
  const cw = cx1 - cx0 + 1;
  const rowThreshold = Math.max(3, Math.round(cw * 0.025));
  // bands of text-y rows (tolerate 2-row dips inside a band)
  const rawBands = [];
  let cur = null, miss = 0;
  for (let y = cy0; y <= cy1; y++) {
    if (rowDark[y] >= rowThreshold) {
      if (!cur) cur = { y0: y, y1: y, total: 0 };
      cur.y1 = y; cur.total += Math.min(rowDark[y], cw); miss = 0;
    } else if (cur) {
      if (++miss > 2) { rawBands.push(cur); cur = null; }
    }
  }
  if (cur) rawBands.push(cur);
  // merge nearby bands so border lines + text land in one region
  const mergeGap = Math.max(6, Math.round(h * 0.07));
  const mergedBands = [];
  for (const b of rawBands) {
    const last = mergedBands[mergedBands.length - 1];
    if (last && b.y0 - last.y1 <= mergeGap) { last.y1 = b.y1; last.total += b.total; }
    else mergedBands.push({ ...b });
  }
  // pick the best band, biased towards the bottom of the screen where
  // dialog boxes live (so HP bars / menus don't win)
  let best = null, bestScore = -1;
  for (const b of mergedBands) {
    const score = b.total * (0.5 + 0.5 * (b.y1 / h));
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (!best) return { x: Math.round(w * 0.06), y: Math.round(h * 0.70), w: Math.round(w * 0.88), h: Math.round(h * 0.26) };
  // horizontal extent of dark pixels within the chosen band
  let minX = w, maxX = -1;
  for (let y = best.y0; y <= best.y1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      if (lum[y * w + x] < 90) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
  }
  if (maxX <= minX) { minX = cx0; maxX = cx1; }
  const pad = 2;
  const x0 = Math.max(cx0, minX - pad);
  const y0 = Math.max(cy0, best.y0 - pad);
  const x1 = Math.min(cx1 + 1, maxX + pad + 1);
  const y1 = Math.min(cy1 + 1, best.y1 + pad + 1);
  const inset = Math.max(2, Math.round(Math.min(x1 - x0, y1 - y0) * 0.05));
  return {
    x: x0 + inset,
    y: y0 + inset,
    w: Math.max(8, x1 - x0 - inset * 2),
    h: Math.max(8, y1 - y0 - inset * 2)
  };
}
