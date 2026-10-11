// 'legacy-neural' - the app's DEFAULT OCR path as of the frozen baseline:
// ocrFrameNeural(full snapshot canvas) [PaddleOCR PP-OCRv5 det+rec, main
// thread] -> cleanOcrText (incl. applyGameLexicon) per region -> the
// "uncertain read" confidence gate. The optional '+spell' flavour (computed
// by the bench page from the same OCR output) adds correctOcrText with the
// app's 4 s timeout, i.e. the full default pipeline with spellCheck on.
//
// Differences from the live app, by design: when ocrFrameNeural returns
// null the app silently falls back to Tesseract; here that is an ERROR so
// engine failures are visible in the results.

import { ocrFrameNeural } from '../legacy/ocr-neural.js';
import { cleanOcrText, appConfidenceGate, warmupCanvas } from './_app.js';

// same constants as legacy/ocr-neural.js (not exported there) - used only to
// diagnose WHY init failed, because ocrFrameNeural swallows the error
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';

async function diagnose() {
  try {
    const { PaddleOCR } = await import(/* @vite-ignore */ SDK_URL);
    const p = await PaddleOCR.create({
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textDetectionModelAsset: { url: new URL('models/det.tar', document.baseURI).href },
      textRecognitionModelName: 'latin_PP-OCRv5_mobile_rec',
      textRecognitionModelAsset: { url: new URL('models/rec.tar', document.baseURI).href },
      ortOptions: { backend: 'wasm', wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/', numThreads: 1, simd: true }
    });
    await p.predict(warmupCanvas(), { textDetLimitSideLen: 640, textDetLimitType: 'max' });
    return 'a fresh PaddleOCR.create() + predict() succeeded - the failure is inside ocrFrameNeural';
  } catch (e) {
    return (e && (e.stack || e.message)) || String(e);
  }
}

let ready = false;

export default {
  name: 'legacy-neural',
  description: 'Frozen default app path: ocrFrameNeural (PaddleOCR PP-OCRv5, main thread) + cleanOcrText + confidence gate',
  spell: true,
  async init(ctx) {
    if (ready) return { note: 'engine already initialised' };
    const res = await ocrFrameNeural(warmupCanvas(), ctx.onStatus);
    if (res === null) {
      throw new Error('ocrFrameNeural returned null during init (the app would silently fall back to Tesseract). Diagnosis: ' + await diagnose());
    }
    ready = true;
    return { note: 'PaddleOCR initialised via the app code path' };
  },
  async read(canvas, grid, ctx) {
    const raw = await ocrFrameNeural(canvas);
    if (raw === null) throw new Error('ocrFrameNeural returned null (engine failure or 30 s predict timeout) - the app would fall back to Tesseract');
    const results = [];
    for (const r of raw) {
      const clean = cleanOcrText(r.text);
      if (!clean) continue;
      results.push({ text: clean, conf: r.conf });
    }
    return { regions: appConfidenceGate(results), debug: { raw } };
  }
};
