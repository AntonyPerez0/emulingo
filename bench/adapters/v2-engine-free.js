// 'v2-engine-free' - the v2 engine's det+rec 'free' mode (with line-box
// merging) on the whole native frame x k, no containers. Compares detection
// on the full frame against the container 'lines' path of the 'v2' adapter.

import { createOcrEngine } from '../../src/core/ocr/engine.js';
import { readV2 } from './_v2-shared.js';

let engine = null;
const statusLog = [];

function getEngine() {
  engine = engine || createOcrEngine({ onStatus: (s) => statusLog.push(s) });
  return engine;
}

export default {
  name: 'v2-engine-free',
  description: 'v2 engine det+rec with box merging on the whole native frame (no containers)',
  spell: false,
  async init(ctx) {
    await getEngine().prepare(ctx.lang);
    const last = statusLog[statusLog.length - 1];
    if (last && last.phase === 'error') throw new Error(last.message);
    return { note: 'engine ready' };
  },
  read(canvas, grid, ctx) {
    return readV2(getEngine(), canvas, grid, ctx, { forceFree: true });
  }
};
