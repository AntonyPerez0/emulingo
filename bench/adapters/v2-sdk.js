// 'v2-sdk' / 'v2-sdk-free' - option A of the engine decision: the same v2
// pipeline as 'v2' / 'v2-engine-free', but recognition (and detection) run by
// the @paddleocr/paddleocr-js SDK models (OpenCV preprocessing, rotated-box
// DB post-processing) instead of the app's own onnxruntime-web code (option
// B, src/core/ocr/models.js). Runs on the main thread: compare accuracy and
// read time, not long tasks. Line merging and filtering are shared with B.

import { PaddleOCR } from '@paddleocr/paddleocr-js';
import { mergeLineBoxes } from '../../src/core/ocr/models.js';
import { stripLine, linesFromItems, DET_PARAMS, MERGE_OPTS } from '../../src/core/ocr/engine.js';
import { readV2 } from './_v2-shared.js';

let ocrPromise = null;

function getOcr() {
  ocrPromise = ocrPromise || PaddleOCR.create({
    textDetectionModelName: 'PP-OCRv5_mobile_det',
    textDetectionModelAsset: { url: new URL('models/det.tar', document.baseURI).href },
    textRecognitionModelName: 'latin_PP-OCRv5_mobile_rec',
    textRecognitionModelAsset: { url: new URL('models/rec.tar', document.baseURI).href },
    ortOptions: { backend: 'wasm', wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/', numThreads: 1 }
  }).then(async (ocr) => {
    await ocr.initialize();
    return ocr;
  });
  return ocrPromise;
}

const sdkEngine = {
  async read(job) {
    const ocr = await getOcr();
    const cv = ocr.cv;
    const t0 = performance.now();
    if (job.mode === 'lines') {
      const mats = job.strips.map((s) => cv.matFromImageData(s.img));
      let recs;
      try { recs = await ocr.recModel.predict(cv, mats); } finally { mats.forEach((m) => m.delete()); }
      const lines = job.strips.map((s, i) => stripLine(recs[i], { width: s.img.width, height: s.img.height, k: s.k, offset: s.offset }));
      return { lines, ms: performance.now() - t0, engine: 'sdk' };
    }
    const img = job.img;
    const mat = cv.matFromImageData(img);
    try {
      const [det] = await ocr.detModel.predict(cv, [mat], {
        limitSideLen: Math.max(img.width, img.height), limitType: 'max', maxSideLimit: 4000, ...DET_PARAMS
      });
      const boxes = det.boxes.map(({ poly, score }) => {
        const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
        const x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys));
        return { x, y, w: Math.min(img.width, Math.max(...xs)) - x, h: Math.min(img.height, Math.max(...ys)) - y, score };
      }).filter((b) => b.w >= 2 && b.h >= 2);
      const merged = mergeLineBoxes(boxes, MERGE_OPTS);
      const crops = merged.map((b) => mat.roi(new cv.Rect(Math.round(b.x), Math.round(b.y), Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)))).clone());
      let recs = [];
      try { recs = crops.length ? await ocr.recModel.predict(cv, crops) : []; } finally { crops.forEach((m) => m.delete()); }
      const lines = linesFromItems(merged.map((b, i) => ({ box: b, ...recs[i] })), job);
      return { lines, ms: performance.now() - t0, engine: 'sdk' };
    } finally {
      mat.delete();
    }
  }
};

export default [
  {
    name: 'v2-sdk',
    description: 'v2 pipeline with the PaddleOCR SDK models (option A, main thread)',
    spell: false,
    async init() { await getOcr(); return { note: 'SDK ready' }; },
    read: (canvas, grid, ctx) => readV2(sdkEngine, canvas, grid, ctx)
  },
  {
    name: 'v2-sdk-free',
    description: 'SDK det+rec with box merging on the whole native frame (option A)',
    spell: false,
    async init() { await getOcr(); return { note: 'SDK ready' }; },
    read: (canvas, grid, ctx) => readV2(sdkEngine, canvas, grid, ctx, { forceFree: true })
  }
];
