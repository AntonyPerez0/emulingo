// 'legacy-tesseract' - the app's Tesseract path (Settings -> OCR engine:
// Tesseract, or the neural fallback) as of the frozen baseline, with the
// automatic zone: detectTextRects(canvas, 6, grid) -> ocrRegion per rect
// (bottom-band fallback rect when nothing is detected) -> cleanOcrText ->
// conf >= 42 -> the "uncertain read" gate. The per-region memo cache is
// irrelevant for single frames and is not reproduced.

import * as ocr from '../legacy/ocr.js';
import { cleanOcrText, appConfidenceGate } from './_app.js';

let readyLang = null;

export default {
  name: 'legacy-tesseract',
  description: 'Frozen Tesseract path: detectTextRects + ocrRegion (tesseract.js 5, 4.0.0_best) + cleanOcrText + conf gates',
  spell: true,
  async init(ctx) {
    if (!globalThis.Tesseract) throw new Error('global Tesseract is missing - the tesseract.js <script> did not load');
    if (readyLang === ctx.ocrLang) return { note: 'worker already initialised for ' + ctx.ocrLang };
    // ensureWorker() is internal to ocr.js; a tiny ocrRegion call creates
    // the worker for this language (and surfaces download/init errors)
    const c = document.createElement('canvas');
    c.width = 64; c.height = 24;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 24);
    x.fillStyle = '#000'; x.fillRect(8, 8, 40, 8);
    await ocr.ocrRegion(c, { x: 0, y: 0, w: 64, h: 24 }, ctx.ocrLang, ctx.onStatus);
    readyLang = ctx.ocrLang;
    return { note: 'tesseract worker ready for ' + ctx.ocrLang };
  },
  async read(canvas, grid, ctx) {
    const det = ocr.detectTextRects(canvas, 6, grid);
    const work = det.canvas;
    let rects = det.rects;
    const fallback = !rects.length;
    if (fallback) {
      const W = work.width, H = work.height;
      rects = [{ x: Math.round(W * 0.06), y: Math.round(H * 0.70), w: Math.round(W * 0.88), h: Math.round(H * 0.26) }];
    }
    const results = [];
    const reads = [];
    for (const rect of rects) {
      const result = await ocr.ocrRegion(work, rect, ctx.ocrLang);
      reads.push({ rect, text: result.text, conf: Math.round(result.confidence) });
      const clean = cleanOcrText(result.text);
      if (clean && result.confidence >= 42) results.push({ text: clean, conf: result.confidence });
    }
    return {
      regions: appConfidenceGate(results),
      debug: { detected: det.rects.length, fallbackRect: fallback, analysis: `${work.width}x${work.height}`, reads }
    };
  }
};
