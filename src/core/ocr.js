// Tesseract.js-based OCR engine with canvas pre-processing.

let worker = null;
let workerPromise = null;
let currentLang = null;
const DEFAULT_PSM = (globalThis.Tesseract && Tesseract.PSM && Tesseract.PSM.SINGLE_BLOCK) || '6';
// second pass with a different segmentation mode rescues low-confidence
// reads (PSM 4 = single variable-size column handles dialog boxes whose
// text sits close to the border better than PSM 6)
const RETRY_PSM = '4';
const MIN_WORD_CONF = 30;   // words below this are noise (border artifacts)
const RETRY_BELOW = 60;     // overall confidence that triggers the retry pass

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
    await worker.setParameters({
      tessedit_pageseg_mode: DEFAULT_PSM,
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

// Pre-process: crop, upscale in two stages (bilinear 2x supplies smooth gray
// gradients across anti-aliased glyph edges, then nearest-neighbour to full
// size so pixel-font stems stay blocky), then grayscale. Binarization is left
// to Tesseract: its internal adaptive thresholding clearly beats a global
// Otsu pass here (measured deu confidence 9 -> 68+ on a Crystal intro box).
function preprocess(canvas, rect, scale) {
  // aim for a crop around 400px tall; native-pixel crops are crisp so a
  // strong upscale is safe
  let s = scale || 3;
  if (rect.h > 10) s = Math.round(400 / rect.h);
  s = Math.max(2, Math.min(10, s));
  // white margin keeps glyphs away from the image border (Tesseract line
  // finding degrades on edge-hugging text)
  const pad = 24;
  const maxDim = Math.max(rect.w, rect.h);
  if (maxDim * s + pad * 2 > 1600) s = Math.max(1, Math.floor((1600 - pad * 2) / maxDim));
  s = Math.max(1, s);
  const pre = Math.min(2, s);
  const nn = Math.max(1, Math.round(s / pre));
  const mid = document.createElement('canvas');
  mid.width = Math.max(8, rect.w * pre);
  mid.height = Math.max(8, rect.h * pre);
  let ctx = mid.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, mid.width, mid.height);
  const w = Math.max(8, mid.width * nn);
  const h = Math.max(8, mid.height * nn);
  const out = document.createElement('canvas');
  out.width = w + pad * 2; out.height = h + pad * 2;
  ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(mid, 0, 0, mid.width, mid.height, pad, pad, w, h);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  // grayscale (RGB = luminance, opaque alpha); Tesseract binarizes internally
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// rect: {x, y, w, h} in canvas coordinates. lang: e.g. "deu", "eng"
export async function ocrRegion(canvas, rect, lang, onProgress) {
  const processed = preprocess(canvas, rect, 3);
  const wrk = await ensureWorker(lang, onProgress);

  // low-confidence words are pure noise (box borders, cursor arrows read as
  // ":" or "/") - dropping them before translation keeps the English clean
  function readOnce(psm) {
    return wrk.setParameters({ tessedit_pageseg_mode: psm }).then(() =>
      wrk.recognize(processed, {}, { text: true, blocks: true })
    ).then(({ data }) => {
      // collect words per line (v6+ nests them under blocks)
      const lines = [];
      let sawWords = false;
      for (const b of data.blocks || []) {
        for (const p of b.paragraphs || []) {
          for (const l of p.lines || []) {
            const words = (l.words || [])
              .map((w) => ({ text: String(w.text || '').trim(), conf: w.confidence ?? 0 }))
              .filter((w) => w.text);
            if (words.length) { lines.push(words); sawWords = true; }
          }
        }
      }
      if (!sawWords) {
        const conf = data.confidence || 0;
        for (const line of (data.text || '').replace(/\r/g, '').split('\n')) {
          const words = line.trim().split(/\s+/).filter(Boolean).map((t) => ({ text: t, conf }));
          if (words.length) lines.push(words);
        }
      }
      const kept = lines
        .map((words) => words.filter((w) => w.conf >= MIN_WORD_CONF).map((w) => w.text))
        .filter((words) => words.length);
      // mean confidence over the words we actually kept
      const confs = kept.length ? lines.flatMap((words) => words.filter((w) => w.conf >= MIN_WORD_CONF).map((w) => w.conf)) : [];
      const conf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : (data.confidence || 0);
      return { text: kept.join('\n'), conf };
    });
  }

  // pass 1 with the default segmentation mode; a second pass with a
  // different mode rescues stubborn low-confidence frames
  let best = await readOnce(DEFAULT_PSM);
  if (best.conf < RETRY_BELOW) {
    try {
      const retry = await readOnce(RETRY_PSM);
      if (retry.text && retry.conf > best.conf) best = retry;
    } catch {}
  }
  try { await wrk.setParameters({ tessedit_pageseg_mode: DEFAULT_PSM }); } catch {}

  // join lines, de-hyphenating words the game wrapped across lines
  // ("auf-" + "geweckt" -> "aufgeweckt")
  const lines = best.text.split('\n').map((l) => l.trim()).filter(Boolean);
  let text = '';
  for (const line of lines) {
    if (!text) { text = line; continue; }
    if (/\p{L}-$/u.test(text)) text = text.slice(0, -1) + line;
    else text += ' ' + line;
  }
  text = text.replace(/\s+/g, ' ').trim();
  // pixel fonts read spaces as commas; real game text always has a space
  // after sentence punctuation and real commas, so a glued comma is a
  // space artifact (decimal numbers "1,50" are digit-digit and survive)
  text = text
    .replace(/([?.!…]),(?=\S)/gu, '$1 ')
    .replace(/(\d),(?=\p{L})/gu, '$1 ')
    .replace(/,(?=\S)/gu, ', ');
  return {
    text,
    confidence: best.conf
  };
}

// Locate text regions. If a grid is provided, the frame is first downscaled
// to the core's native resolution (160x144 for GB) - recovering the crisp
// pixel grid from the blurry GL upscale - and detection + cropping happen
// there. Returns { canvas: analysisCanvas, rects } with rects in that
// canvas' coordinates, sorted top-to-bottom. Three detector passes:
// 1. light boxes with dark text (dialog, menus, HP plates, clock screens)
// 2. tall narrow light columns (START menus run most of the screen height
//    and are filtered out by the band height cap)
// 3. dark boxes with light text (GBA battle message boxes)
export function detectTextRects(canvas, max = 6, grid = null, dbg = null) {
  if (dbg) dbg.passes = { light: [], menu: [], dark: [] }, dbg.merges = [];
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
  // per-row light/dark counts within content columns. "darkish" (l < 125)
  // catches anti-aliased GBA text that smooths to mid-gray at native
  // resolution; strict dark (l < 90) stays for borders and letterbox trim.
  const rowLight = new Uint16Array(h), rowDark = new Uint16Array(h), rowDarkish = new Uint16Array(h);
  for (let y = 0; y < h; y++) {
    let li = 0, da = 0, dsh = 0;
    for (let x = cx0; x <= cx1; x++) {
      const l = lum[y * w + x];
      if (l < 90) { da++; dsh++; } else if (l < 125) dsh++;
      else if (l > 150) li++;
    }
    rowLight[y] = li; rowDark[y] = da; rowDarkish[y] = dsh;
  }
  // seed rows for light boxes: contain text (darkish, incl. anti-aliased
  // gray) while the row is light vs STRICT dark and has real light content.
  // Comparing light against darkish instead would let mid-tone backgrounds
  // (purple map tiles, teal battle boxes) defeat every seed row.
  const gapLimit = 10;
  function bandExtent(y0, y1, minX, maxX) {
    for (let y = y0; y <= y1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        const l = lum[y * w + x];
        if (l <= 150) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
      }
    }
    return [minX, maxX];
  }
  function borderContinues(y0, y1, xl, xr) {
    // the band extent already includes the box borders - check the columns
    // AT the edges: they must stay dark through the gap (border verticals),
    // which is what distinguishes a real box from open sky
    let rows = 0, hitL = 0, hitR = 0;
    for (let y = y0; y < y1; y++) {
      rows++;
      for (let x = xl; x <= Math.min(xl + 2, xr); x++) if (lum[y * w + x] <= 140) { hitL++; break; }
      for (let x = xr; x >= Math.max(xr - 2, xl); x--) if (lum[y * w + x] <= 140) { hitR++; break; }
    }
    return rows > 0 && hitL >= rows * 0.6 && hitR >= rows * 0.6;
  }
  function collectBands(seedFn, betweenFn) {
    const seeds = [];
    let cur = null;
    for (let y = 0; y < h; y++) {
      if (seedFn(y)) { if (!cur) cur = { y0: y, y1: y }; else cur.y1 = y; }
      else if (cur) { seeds.push(cur); cur = null; }
    }
    if (cur) seeds.push(cur);
    for (const b of seeds) [b.minX, b.maxX] = bandExtent(b.y0, b.y1, cx1 + 1, cx0 - 1);
    const merged = [];
    for (const b of seeds) {
      const last = merged[merged.length - 1];
      if (last) {
        const gap = b.y0 - last.y1;
        if (gap <= gapLimit) {
          let interior = true;
          for (let y = last.y1 + 1; y < b.y0; y++) if (!betweenFn(y)) { interior = false; break; }
          const minX = Math.min(last.minX, b.minX), maxX = Math.max(last.maxX, b.maxX);
          if (interior && borderContinues(last.y1 + 1, b.y0, minX, maxX)) {
            last.y1 = b.y1;
            last.minX = minX; last.maxX = maxX;
            continue;
          }
        }
      }
      merged.push({ ...b });
    }
    return merged;
  }
  // keep normal bands; also keep TALL NARROW framed bands - START menus run
  // most of the screen height and would fall to the height cap. A real menu
  // box has two full-height dark border columns bounding a light interior;
  // bright skies and bright maps have no such vertical border pair.
  function menuFramed(b) {
    const rows = b.y1 - b.y0 + 1;
    const counts = new Uint16Array(w);
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = cx0; x <= cx1; x++) if (lum[y * w + x] <= 140) counts[x]++;
    }
    const borders = [];
    for (let x = cx0; x <= cx1; x++) {
      if (counts[x] >= rows * 0.55) borders.push(x);
    }
    const minW = w * 0.15, maxW = w * 0.55;
    let best = null, bestScore = 0;
    for (let i = 0; i < borders.length; i++) {
      for (let j = i + 1; j < borders.length && borders[j] - borders[i] <= maxW; j++) {
        const span = borders[j] - borders[i];
        if (span < minW) continue;
        // interior between the borders must be mostly light; the real menu
        // pair scores highest (white fill) vs map/rock columns
        let light = 0, total = 0;
        for (let y = b.y0; y <= b.y1; y++) {
          for (let x = borders[i] + 1; x < borders[j]; x++) {
            total++;
            if (lum[y * w + x] > 150) light++;
          }
        }
        const score = light / total;
        if (score >= 0.5 && score > bestScore) {
          bestScore = score;
          best = { x0: borders[i], x1: borders[j] };
        }
      }
    }
    return best;
  }
  function bandOk(b) {
    const bh = b.y1 - b.y0;
    if (bh < 4) return false;
    if (bh <= h * 0.42) return true;
    const frame = bh <= h * 0.95 ? menuFramed(b) : null;
    if (frame) { b.menuX0 = frame.x0; b.menuX1 = frame.x1; return true; }
    return false;
  }
  const lightBands = collectBands(
    (y) => rowDarkish[y] >= contrastThreshold && rowLight[y] > rowDark[y] && rowLight[y] >= contrastThreshold,
    (y) => rowLight[y] > rowDark[y]
  ).filter(bandOk);
  const rects = [];

  // horizontal extent of box/text pixels for a band; dark=true finds the
  // light text inside a dark box, dark=false finds box+text on light boxes.
  // Menu bands (b.menuX0 set) are clamped to their border columns so the
  // OCR crop contains the menu, not the surrounding map.
  function bandRect(b, dark) {
    let minX = dark ? cx0 : (b.menuX0 != null ? b.menuX0 : w);
    let maxX = dark ? cx1 : (b.menuX0 != null ? b.menuX1 : -1);
    if (b.menuX0 == null) {
      for (let y = b.y0; y <= b.y1; y++) {
        for (let x = cx0; x <= cx1; x++) {
          const l = lum[y * w + x];
          const hit = dark ? l > 150 : (l < 90 || l > 150);
          if (hit) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
        }
      }
    }
    if (maxX <= minX) return null;
    const pad = 2;
    const x0 = Math.max(cx0, minX - pad);
    const y0 = Math.max(0, b.y0 - pad);
    const x1 = Math.min(cx1 + 1, maxX + pad + 1);
    const y1 = Math.min(h, b.y1 + pad + 1);
    // inset past the box border lines
    const insetY = Math.max(2, Math.round((y1 - y0) * 0.08));
    const insetX = Math.max(2, Math.round((x1 - x0) * 0.04));
    return {
      x: x0 + insetX,
      y: y0 + insetY,
      w: Math.max(6, x1 - x0 - insetX * 2),
      h: Math.max(6, y1 - y0 - insetY * 2)
    };
  }

  // pass 1: light boxes with dark text, bottom-most first
  for (const b of lightBands.slice(-max)) {
    if (dbg) dbg.passes.light.push({ ...b });
    const r = bandRect(b, false);
    if (r) rects.push(r);
  }

  // pass 2: dark boxes with light text (GBA battle message boxes: navy /
  // dark teal with white text). Seeds are dark-dominant (darkish catches
  // teal backgrounds that sit above the strict dark threshold) and contain
  // light text; merging requires dark interior rows between seeds.
  const darkBands = collectBands(
    (y) => rowLight[y] >= contrastThreshold && rowDarkish[y] > rowLight[y],
    (y) => rowDarkish[y] > rowLight[y]
  ).filter(bandOk);
  for (const b of darkBands.slice(-2)) {
    if (dbg) dbg.passes.dark.push({ ...b });
    const r = bandRect(b, true);
    if (r) rects.push(r);
  }

  // dedup overlapping rects (menu column vs band, light vs dark overlap)
  const area = (r) => r.w * r.h;
  const overlap = (a, b) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ix * iy;
  };
  const kept = [];
  for (const r of rects.sort((a, b) => area(b) - area(a))) {
    if (!kept.some((k) => overlap(k, r) > area(r) * 0.5)) kept.push(r);
  }
  // reading order: top-to-bottom, left-to-right
  kept.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return { canvas: work, rects: kept.slice(0, max) };
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
