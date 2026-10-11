// 'v2' - the rewritten OCR path: native capture -> framed text containers ->
// neural engine in a module worker ('lines' recognition on the containers'
// text-row cells, det+rec 'free' mode when no container is found) -> layout
// (the shared pipeline is in _v2-shared.js).

import { createOcrEngine } from '../../src/core/ocr/engine.js';
import { readV2 } from './_v2-shared.js';

let engine = null;
const statusLog = [];

function getEngine() {
  engine = engine || createOcrEngine({ onStatus: (s) => statusLog.push(s) });
  return engine;
}

export default {
  name: 'v2',
  description: 'v2 pipeline: capture -> containers -> engine worker (lines / free) -> layout',
  spell: false,
  async init(ctx) {
    const t0 = performance.now();
    await getEngine().prepare(ctx.lang);
    const last = statusLog[statusLog.length - 1];
    if (last && last.phase === 'error') throw new Error(last.message);
    return { note: `engine ready in ${Math.round(performance.now() - t0)} ms (${getEngine().supports(ctx.lang)})` };
  },
  read(canvas, grid, ctx) {
    return readV2(getEngine(), canvas, grid, ctx);
  }
};
