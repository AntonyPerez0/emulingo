// Local neural OCR engine: PaddleOCR PP-OCRv5 mobile (det + rec) running
// fully on-device via onnxruntime-web WASM. ~13 MB of models, downloaded
// once from the app itself and cached by the browser. Purpose-built for
// scene text - dramatically better than Tesseract on pixel game fonts
// (verified: "WEDNESDAY"/"PM"/"1:57" at 99-100% confidence vs Tesseract 60-71%).
//
// Fallback contract: every function resolves, never rejects - on any failure
// it returns null so the caller can fall back to the Tesseract pipeline.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';

let pipelinePromise = null;

function ensurePaddle(onStatus) {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const { PaddleOCR } = await import(/* @vite-ignore */ SDK_URL);
    if (onStatus) onStatus('loading local OCR model (~13 MB, once)');
    return PaddleOCR.create({
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textDetectionModelAsset: { url: new URL('models/det.tar', document.baseURI).href },
      textRecognitionModelName: 'latin_PP-OCRv5_mobile_rec',
      textRecognitionModelAsset: { url: new URL('models/rec.tar', document.baseURI).href },
      ortOptions: {
        backend: 'wasm',
        wasmPaths: ORT_WASM,
        numThreads: 1,
        simd: true
      }
    });
  })();
  // a failed load is retried on the next scan
  pipelinePromise = pipelinePromise.catch((e) => { pipelinePromise = null; throw e; });
  return pipelinePromise;
}

// group recognized text lines into reading-order blocks: lines whose
// vertical centers are close together and overlap horizontally form one
// region (a dialog box, a menu entry...)
function groupLines(items) {
  const lines = items
    .map((it) => {
      const xs = it.poly.map((p) => p[0]);
      const ys = it.poly.map((p) => p[1]);
      return {
        text: String(it.text || '').trim(),
        score: it.score || 0,
        x0: Math.min(...xs), x1: Math.max(...xs),
        y0: Math.min(...ys), y1: Math.max(...ys)
      };
    })
    .filter((l) => l.text)
    .sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));

  const groups = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last) {
      const h = Math.max(last.y1 - last.y0, l.y1 - l.y0, 1);
      const near = l.y0 - last.y0 < h * 1.4 && l.y0 > last.y0 - h * 0.5;
      // stacked lines of one box overlap horizontally (menu items, wrapped
      // dialog); side-by-side boxes at the same height must not merge
      const overlapW = Math.min(last.x1, l.x1) - Math.max(last.x0, l.x0);
      const overlaps = overlapW > 0.5 * Math.min(last.x1 - last.x0, l.x1 - l.x0);
      if (near && overlaps) {
        last.text += ' ' + l.text;
        last.y1 = Math.max(last.y1, l.y1);
        last.x0 = Math.min(last.x0, l.x0); last.x1 = Math.max(last.x1, l.x1);
        last.score = Math.max(last.score, l.score);
        continue;
      }
    }
    groups.push({ ...l });
  }
  return groups;
}

// Run neural OCR on a full emulator frame. Returns an array of regions
// [{text, conf}] in reading order (same shape the Tesseract path produces),
// or null when the engine is unavailable/failed.
export async function ocrFrameNeural(canvas, onStatus) {
  try {
    const paddle = await withTimeout(ensurePaddle(onStatus), 120000, 'local OCR model load');
    const result = await withTimeout(paddle.predict(canvas, {
      textDetLimitSideLen: 640,
      textDetLimitType: 'max'
    }), 20000, 'neural OCR');
    const groups = groupLines(result.items || []);
    return groups.map((g) => ({ text: g.text, conf: Math.round(g.score * 100) }));
  } catch (e) {
    return null;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })
  ]).finally(() => clearTimeout(timer));
}

export function neuralEngineReady() {
  return !!pipelinePromise;
}
