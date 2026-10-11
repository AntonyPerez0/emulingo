// Shared v2 bench pipeline (helper, not an adapter). Runs the app's real
// OCR path on one presented frame, the way src/core/scanner.js does:
//   capture.createFrameSource → containers.createContainerTracker →
//   engine.read ('lines' on a framed container's cells(), 'free' otherwise)
//   → layout.buildRegions → regions
// Spell correction and translation are left out (the scanner applies them
// after layout).

import { createFrameSource, upscaleNearest } from '../../src/core/ocr/capture.js';
import { createContainerTracker } from '../../src/core/ocr/containers.js';
import { buildRegions } from '../../src/core/ocr/layout.js';
import { upscaleFactor } from '../../src/core/scanner.js';

// EmulatorJS letterbox bars are transparent (alpha 0) and capture.js finds
// the picture by alpha; the bench presents opaque black bars, so rebuild
// the bars as transparent.
function emulatorLikeCanvas(canvas, grid) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, grid.x0, grid.y0, grid.contentW, grid.contentH, grid.x0, grid.y0, grid.contentW, grid.contentH);
  return c;
}

export function grabFrame(canvas, grid) {
  const presented = emulatorLikeCanvas(canvas, grid);
  const frame = createFrameSource({
    getCanvas: () => presented,
    getVideoDims: () => ({ w: grid.nativeW, h: grid.nativeH })
  }).grab();
  if (!frame) throw new Error('capture.grab() returned null for a presented frame');
  return frame;
}

// The tracker is stateful: show it the same picture three times, 250 ms
// apart, so every container is settled (as on a static game screen).
export function findContainers(frame) {
  const tracker = createContainerTracker({});
  let list = [];
  for (let i = 0; i < 3; i++) list = tracker.update({ ...frame, t: frame.t + i * 250 });
  return list;
}

const FRAMED = new Set(['dialog', 'menu', 'battle', 'box', 'zone']);

// The v2 path with any engine implementing read(job). Options:
//   forceFree: one det+rec read of the whole frame instead of containers
//   stripK:    override the strip scale (tuning)
export async function readV2(engine, canvas, grid, ctx, { forceFree = false, stripK = null } = {}) {
  const t0 = performance.now();
  const frame = grabFrame(canvas, grid);
  const tCapture = performance.now() - t0;
  const containers = forceFree
    ? [{ key: 'free', kind: 'free', x: 0, y: 0, w: frame.w, h: frame.h, crop: () => ({ img: frame.img, offset: { x: 0, y: 0 } }) }]
    : findContainers(frame);
  const tContainers = performance.now() - t0 - tCapture;
  const regions = [];
  const dbg = [];
  let engineMs = 0;
  let engineName = null;
  for (const c of containers) {
    let lines;
    const info = { kind: c.kind, box: [c.x, c.y, c.w, c.h] };
    if (FRAMED.has(c.kind) && typeof c.cells === 'function') {
      const cells = c.cells() || [];
      if (!cells.length) continue; // an empty box
      const strips = cells.map((cell) => {
        const { img, offset } = cell.crop();
        const k = stripK || upscaleFactor(frame.w, img.width, img.height);
        return { img: upscaleNearest(img, k), k, offset };
      });
      const res = await engine.read({ mode: 'lines', strips, lang: ctx.lang });
      engineMs += res.ms;
      engineName = res.engine;
      info.cells = cells.map((cell, i) => {
        const l = res.lines[i];
        return [cell.row, cell.col, l.text || (l.raw ? `(${l.raw})` : ''), +(l.score || l.rawScore || 0).toFixed(3)];
      });
      // like the scanner: a cell's ink box is its line's box
      lines = cells
        .map((cell, i) => ({ text: res.lines[i].text, score: res.lines[i].score, box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h } }))
        .filter((l) => l.text);
    } else {
      const { img, offset } = c.crop();
      const k = upscaleFactor(frame.w, img.width, img.height);
      const res = await engine.read({ mode: c.kind === 'free' ? 'free' : 'container', img: upscaleNearest(img, k), k, offset, lang: ctx.lang });
      engineMs += res.ms;
      engineName = res.engine;
      lines = res.lines;
      info.lines = lines.map((l) => [l.text, +l.score.toFixed(3)]);
    }
    dbg.push(info);
    // like the scanner: Tesseract scores run lower (engine MIN_SCORE.tesseract)
    const minScore = engineName === 'tesseract' ? 0.3 : undefined;
    for (const r of buildRegions(lines, c, { w: frame.w, h: frame.h }, { lang: ctx.lang, minScore })) {
      if (r && r.text) regions.push({ text: r.text, conf: Math.round((r.score ?? 0) * 100), kind: r.kind });
    }
  }
  return {
    regions,
    debug: {
      engine: engineName,
      ms: { capture: +tCapture.toFixed(1), containers: +tContainers.toFixed(1), engine: Math.round(engineMs), total: Math.round(performance.now() - t0) },
      containers: dbg
    }
  };
}
