// Tesseract.js-based OCR engine with canvas pre-processing.

let worker = null;
let workerPromise = null;
let currentLang = null;

async function ensureWorker(lang) {
  if (worker && currentLang === lang) return worker;
  if (workerPromise && currentLang === lang) return workerPromise;
  currentLang = lang;
  workerPromise = (async () => {
    if (worker) { await worker.terminate(); worker = null; }
    worker = await Tesseract.createWorker(lang, 1, {
      logger: () => {},
      errorHandler: () => {}
    });
    return worker;
  })();
  return workerPromise;
}

export async function terminateOcr() {
  if (worker) { try { await worker.terminate(); } catch {} worker = null; workerPromise = null; currentLang = null; }
}

// Pre-process: crop, scale up, grayscale, contrast, binarize (Otsu threshold)
function preprocess(canvas, rect, scale) {
  const s = scale || 3;
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
export async function ocrRegion(canvas, rect, lang) {
  const processed = preprocess(canvas, rect, 3);
  const wrk = await ensureWorker(lang);
  const { data } = await wrk.recognize(processed);
  return {
    text: (data.text || '').replace(/\s+/g, ' ').trim(),
    confidence: data.confidence || 0
  };
}

// Find dark (text-like) rows in the top 60% of the frame to auto-locate dialog text.
export function detectTextRect(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const rowThreshold = Math.max(6, Math.round(w * 0.06));
  const rows = [];
  for (let y = 0; y < Math.floor(h * 0.62); y++) {
    let dark = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      if (lum < 90) dark++;
    }
    rows.push(dark >= rowThreshold);
  }
  // find contiguous dark band
  let start = -1, end = -1;
  for (let y = 0; y < rows.length; y++) {
    if (rows[y]) { if (start === -1) start = y; end = y; }
    else if (start !== -1 && y - end > 4) break;
  }
  if (start === -1) return { x: Math.round(w * 0.06), y: Math.round(h * 0.70), w: Math.round(w * 0.88), h: Math.round(h * 0.26) };
  const pad = 2;
  const y0 = Math.max(0, start - pad);
  const y1 = Math.min(h, end + pad + 1);
  // horizontal extent of dark pixels in the band
  let minX = w, maxX = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      if (lum < 90) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
  }
  if (maxX <= minX) { minX = Math.round(w * 0.06); maxX = Math.round(w * 0.94); }
  const padX = 3;
  return {
    x: Math.max(0, minX - padX),
    y: y0,
    w: Math.min(w - Math.max(0, minX - padX), (maxX - minX) + padX * 2),
    h: y1 - y0
  };
}
