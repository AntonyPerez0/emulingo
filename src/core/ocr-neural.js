// Local neural OCR engine: PaddleOCR PP-OCRv5 det + rec (latin, ~13 MB
// ONNX) running on-device via onnxruntime-web WASM on the main thread.
// Purpose-built scene-text models that read pixel game fonts far better
// than Tesseract (verified 95-100% confidence on reference frames vs
// 60-71%).
//
// NOTE: runs on the main thread - each scan blocks the UI for ~0.5-1.5s, so
// the caller keeps the scan interval generous. (An off-thread version is
// WIP; the SDK's own worker mode breaks when loaded from a CDN and a DIY
// DBNet postprocess still needs tuning.)
//
// Fallback contract: every function resolves, never rejects - on any failure
// it returns null so the caller can fall back to the Tesseract pipeline.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';

let pipelinePromise = null;

function ensurePaddle(onStatus) {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const { PaddleOCR } = await import(/* @vite-ignore */ SDK_URL);
    if (onStatus) onStatus('loading local OCR models (~13 MB, once)');
    return PaddleOCR.create({
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textDetectionModelAsset: { url: new URL('models/det.tar', document.baseURI).href },
      textRecognitionModelName: 'latin_PP-OCRv5_mobile_rec',
      textRecognitionModelAsset: { url: new URL('models/rec.tar', document.baseURI).href },
      ortOptions: {
        backend: 'wasm',
        wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/',
        numThreads: 1,
        simd: true
      }
    });
  })();
  pipelinePromise = pipelinePromise.catch((e) => { pipelinePromise = null; throw e; });
  return pipelinePromise;
}

// de-hyphenate lines the game wrapped ("TELEFON-" + "Symbol" -> "TELEFON-Symbol")
function joinLines(a, b) {
  if (a && /\p{L}-$/u.test(a)) return a.slice(0, -1) + b;
  return a ? a + ' ' + b : b;
}

// Run the full neural pipeline on a frame. Returns regions [{text, conf}] in
// reading order (same shape the Tesseract path produces), or null when the
// engine is unavailable/failed.
export async function ocrFrameNeural(canvas, onStatus) {
  try {
    const paddle = await withTimeout(ensurePaddle(onStatus), 130000, 'local OCR model init');
    const [result] = await withTimeout(paddle.predict(canvas, {
      textDetLimitSideLen: 640,
      textDetLimitType: 'max'
    }), 30000, 'neural OCR');
    const items = result.items || [];
    // join per-line items into reading-order regions (det emits one item per
    // text line; a dialog box is 1-3 consecutive lines)
    const regions = [];
    for (const it of items) {
      const text = String(it.text || '').trim();
      if (!text) continue;
      const y = it.y || 0, h = it.h || 0;
      const last = regions[regions.length - 1];
      // merge consecutive det lines into one region while the vertical gap
      // stays under ~a line height (a dialog box is 1-3 stacked lines)
      const near = last && (y - last.y1) < Math.max(h, 24) * 0.9;
      if (near) {
        last.text = joinLines(last.text, text);
        last.y1 = Math.max(last.y1, y + h);
        last.score = Math.max(last.score, it.score || 0);
      } else {
        regions.push({
          text,
          score: it.score || 0,
          x: it.x || 0, y, w: it.w || 0, h,
          y1: y + h
        });
      }
    }
    return regions
      .map((r) => ({ text: r.text, conf: Math.round((r.score || 0) * 100) }))
      .filter((r) => r.text && r.conf >= 42);
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
