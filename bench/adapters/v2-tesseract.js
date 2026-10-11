// 'v2-tesseract' - the v2 pipeline with the engine forced onto its Tesseract
// fallback (what users get while the neural engine is unavailable, and the
// reader for scripts without a neural model): 'lines' strips read with
// PSM 7, free frames with Tesseract's own layout.

import { createOcrEngine } from '../../src/core/ocr/engine.js';
import { readV2 } from './_v2-shared.js';

let engine = null;

function getEngine() {
  if (!engine) {
    engine = createOcrEngine({});
    engine.setPreference('tesseract');
  }
  return engine;
}

export default {
  name: 'v2-tesseract',
  description: 'v2 pipeline with the Tesseract fallback engine (lazy tesseract.js, PSM 7 strips)',
  spell: false,
  async init(ctx) {
    await getEngine().prepare(ctx.lang);
    return { note: 'Tesseract fallback ready' };
  },
  read(canvas, grid, ctx) {
    return readV2(getEngine(), canvas, grid, ctx);
  }
};
