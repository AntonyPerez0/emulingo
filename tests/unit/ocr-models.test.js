import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractTar, tarEntry, parseYamlScalar, parseRecConfig, parseDetConfig, writeTensor, cropImage,
  recGeometry, planRecBatches, ctcDecode, REC_NORMALIZE, detGeometry, detBoxes, canMergeBoxes, inkShape, autoAspect,
  mergeLineBoxes, sortReadingOrder, toNativeBox, RUNTIME_SIZE, hasWasmSimd
} from '../../src/core/ocr/models.js';

const MODELS = path.resolve(__dirname, '../../public/models');

// minimal ustar writer for synthetic archives
function tar(files) {
  const blocks = [];
  for (const [name, content, type = '0'] of files) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const h = new Uint8Array(512);
    h.set(new TextEncoder().encode(name).subarray(0, 100), 0);
    h.set(new TextEncoder().encode(data.length.toString(8).padStart(11, '0') + '\0'), 124);
    h[156] = type.charCodeAt(0);
    h.set(new TextEncoder().encode('ustar\0'), 257);
    blocks.push(h);
    const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
    body.set(data);
    blocks.push(body);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

function image(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

describe('extractTar', () => {
  it('reads regular files and skips directories and macOS metadata', () => {
    const t = tar([
      ['model/', '', '5'],
      ['model/inference.yml', 'Global:\n  model_name: x\n'],
      ['model/._inference.yml', 'junk'],
      ['./model/inference.onnx', new Uint8Array(700).fill(7)]
    ]);
    const entries = extractTar(t.buffer);
    expect([...entries.keys()].sort()).toEqual(['model/inference.onnx', 'model/inference.yml']);
    expect(tarEntry(entries, 'inference.onnx').length).toBe(700);
    expect(tarEntry(entries, 'inference.onnx')[699]).toBe(7);
    expect(new TextDecoder().decode(tarEntry(entries, 'inference.yml'))).toContain('model_name');
  });

  it('names a missing entry and a truncated archive', () => {
    expect(() => tarEntry(new Map(), 'inference.yml')).toThrow(/no inference\.yml/);
    const t = tar([['a.bin', new Uint8Array(2000)]]);
    expect(() => extractTar(t.subarray(0, 1024))).toThrow(/incomplete/);
  });

  it('parses the shipped model archives', () => {
    for (const [file, size] of [['det.tar', 4826518], ['rec.tar', 8042023]]) {
      const entries = extractTar(fs.readFileSync(path.join(MODELS, file)));
      expect(tarEntry(entries, 'inference.onnx').length).toBe(size);
      expect(tarEntry(entries, 'inference.yml').length).toBeGreaterThan(500);
    }
  });
});

describe('inference.yml parsing', () => {
  it('reads YAML scalars like js-yaml', () => {
    expect(parseYamlScalar("'0'")).toBe('0');
    expect(parseYamlScalar("''''")).toBe("'");
    expect(parseYamlScalar("'\"'")).toBe('"');
    expect(parseYamlScalar('"\\u00e9\\\\"')).toBe('é\\');
    expect(parseYamlScalar('ß')).toBe('ß');
    expect(parseYamlScalar('abc # note')).toBe('abc');
    expect(parseYamlScalar('"\\L\\b\\_\\N\\e"')).toBe('\u2028\b\u00a0\u0085\x1b');
  });

  it('reads the Latin character list and appends the space class', async () => {
    const entries = extractTar(fs.readFileSync(path.join(MODELS, 'rec.tar')));
    const text = new TextDecoder().decode(tarEntry(entries, 'inference.yml'));
    const cfg = parseRecConfig(text);
    expect(cfg.modelName).toBe('latin_PP-OCRv5_mobile_rec');
    expect(cfg.height).toBe(48);
    expect(cfg.baseWidth).toBe(320);
    expect(cfg.charDict.length).toBe(837);
    expect(cfg.charDict.slice(0, 10).join('')).toBe('0123456789');
    expect(cfg.charDict[cfg.charDict.length - 1]).toBe(' ');
    for (const c of ["'", '"', 'é', 'ß', '¿', '▶', '…']) expect(cfg.charDict).toContain(c);
    for (const c of ['♂', '♀', '▼', '¡']) expect(cfg.charDict).not.toContain(c);
    // cross-check against a real YAML parser when one is installed
    let yaml = null;
    try { yaml = (await import('js-yaml')).default; } catch { /* optional */ }
    if (yaml) expect(cfg.charDict.slice(0, -1)).toEqual(yaml.load(text).PostProcess.character_dict);
  });

  it('reads the detection post-processing defaults', () => {
    const entries = extractTar(fs.readFileSync(path.join(MODELS, 'det.tar')));
    const cfg = parseDetConfig(new TextDecoder().decode(tarEntry(entries, 'inference.yml')));
    expect(cfg).toMatchObject({ modelName: 'PP-OCRv5_mobile_det', thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, maxCandidates: 1000 });
    expect(cfg.mean).toEqual([0.485, 0.456, 0.406]);
    expect(cfg.std).toEqual([0.229, 0.224, 0.225]);
    expect(cfg.scale).toBeCloseTo(1 / 255, 10);
  });

  it('keeps characters YAML does not treat as white space (CJK dictionaries)', async () => {
    // exactly as PyYAML (allow_unicode) dumps them for PaddleX
    const text = [
      'PreProcess:',
      '  transform_ops:',
      '  - RecResizeImg:',
      '      image_shape:',
      '      - 3',
      '      - 48',
      '      - 320',
      'PostProcess:',
      '  character_dict:',
      '  - 　', '  - あ', "  - '#'", "  - '- '", "  - ''''", '  - \\', "  - 'null'",
      '  -  ', '  - "\\uFEFF"', '  - 😀', "  - ' '", '  - 漢'
    ].join('\n');
    const cfg = parseRecConfig(text);
    expect(cfg.charDict).toEqual(['　', 'あ', '#', '- ', "'", '\\', 'null', ' ', '﻿', '😀', ' ', '漢', ' ']);
    let yaml = null;
    try { yaml = (await import('js-yaml')).default; } catch { /* optional */ }
    if (yaml) expect(cfg.charDict.slice(0, -1)).toEqual(yaml.load(text).PostProcess.character_dict);
  });

  it('rejects a recogniser without a character list', () => {
    expect(() => parseRecConfig('Global:\n  model_name: x\n')).toThrow(/character list/);
  });
});

describe('writeTensor', () => {
  it('writes BGR planes with the model normalisation', () => {
    const img = image(1, 1, () => [255, 0, 51]);
    const out = new Float32Array(3);
    writeTensor(img, 1, 1, out, { ...REC_NORMALIZE });
    expect([...out].map((v) => +v.toFixed(3))).toEqual([-0.6, -1, 1]); // B, G, R
  });

  it('resamples like cv::resize INTER_LINEAR', () => {
    const img = image(2, 1, (x) => [x ? 255 : 0, 0, 0]);
    const out = new Float32Array(3 * 4);
    writeTensor(img, 4, 1, out, { mean: [0, 0, 0], std: [1, 1, 1], scale: 1 });
    expect([...out.subarray(8, 12)]).toEqual([0, 64, 191, 255]); // R plane
  });

  it('pads into a wider tensor row and leaves the padding untouched', () => {
    const img = image(2, 2, () => [255, 255, 255]);
    const out = new Float32Array(3 * 2 * 5);
    writeTensor(img, 2, 2, out, { stride: 5, planeH: 2, ...REC_NORMALIZE });
    expect([...out.subarray(0, 5)]).toEqual([1, 1, 0, 0, 0]);
  });
});

describe('recognition helpers', () => {
  it('sizes recognition inputs like the SDK', () => {
    expect(recGeometry(100, 50)).toEqual({ recW: 320, resizedW: 96 });
    expect(recGeometry(2000, 48)).toEqual({ recW: 2000, resizedW: 2000 });
    expect(recGeometry(100000, 48).recW).toBe(3200);
  });

  // a strip of n glyph blocks (gw × gh ink, gap px apart) on a light background, ×k
  function glyphStrip({ n = 8, gw, gh, gap, k = 4, pad = 3, ink = [40, 40, 40], bg = [248, 248, 248] }) {
    const w = (n * (gw + gap) + 2 * pad) * k, h = (gh + 2 * pad) * k;
    return image(w, h, (x, y) => {
      const nx = Math.floor(x / k) - pad, ny = Math.floor(y / k) - pad;
      const inGlyph = ny >= 0 && ny < gh && nx >= 0 && nx < n * (gw + gap) && nx % (gw + gap) < gw;
      return inGlyph ? ink : bg;
    });
  }

  it('measures glyph shape and squeezes only wide tile fonts', () => {
    const tile = glyphStrip({ gw: 6, gh: 7, gap: 2 }); // GB bold-like 8×8 cells
    const prop = glyphStrip({ gw: 4, gh: 10, gap: 1 }); // GBA-like proportional
    expect(inkShape(tile)).toMatchObject({ inkH: 28, extent: 28, run: 24, runs: 8 });
    expect(inkShape(tile).ratio).toBeCloseTo(6 / 7, 5);
    expect(inkShape(prop).ratio).toBeCloseTo(0.4, 5);
    expect(autoAspect(tile, { k: 4 })).toBe(0.75);
    expect(autoAspect(prop, { k: 4 })).toBe(1);
    // wide but tall glyphs (a proportional font with touching letters) stay
    expect(autoAspect(glyphStrip({ gw: 9, gh: 11, gap: 1 }), { k: 4 })).toBe(1);
    // light text on a dark box works the same
    expect(autoAspect(glyphStrip({ gw: 6, gh: 7, gap: 2, ink: [250, 250, 250], bg: [40, 80, 90] }), { k: 4 })).toBe(0.75);
    // 9 native px tall: the GBA font size, never squeezed
    expect(autoAspect(glyphStrip({ gw: 8, gh: 9, gap: 1 }), { k: 4 })).toBe(1);
    // no ink: leave the strip alone
    expect(inkShape(image(40, 20, () => [255, 255, 255]))).toBeNull();
    expect(autoAspect(image(40, 20, () => [255, 255, 255]))).toBe(1);
  });

  it('batches only similar widths', () => {
    expect(planRecBatches([320, 330, 900, 320])).toEqual([
      { width: 330, items: [0, 3, 1] },
      { width: 900, items: [2] }
    ]);
    expect(planRecBatches([320, 320, 320], { maxBatch: 2 }).map((b) => b.items.length)).toEqual([2, 1]);
  });

  it('greedy-decodes CTC output with blanks and repeats', () => {
    const dict = ['a', 'b', ' '];
    const steps = [[0, 0.9, 0.1, 0, 0], [0, 0.8, 0, 0, 0.2], [1, 0, 0, 0, 0], [0, 0.7, 0, 0, 0], [0, 0, 0.6, 0, 0], [0, 0, 0, 0.5, 0]];
    const data = new Float32Array(steps.flat());
    const res = ctcDecode(data, 0, steps.length, 5, dict);
    expect(res.text).toBe('aab ');
    expect(res.score).toBeCloseTo((0.9 + 0.7 + 0.6 + 0.5) / 4, 5);
    expect(ctcDecode(new Float32Array(10).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0)), 0, 2, 5, dict)).toEqual({ text: '', score: 0 });
  });
});

describe('detection helpers', () => {
  it('never downscales with the image long side as the limit', () => {
    expect(detGeometry(640, 576, { limitSideLen: 640 })).toEqual({ dstW: 640, dstH: 576 });
    expect(detGeometry(720, 480, { limitSideLen: 720 })).toEqual({ dstW: 736, dstH: 480 });
    expect(detGeometry(1920, 1080, { limitSideLen: 960 })).toEqual({ dstW: 960, dstH: 544 });
    expect(detGeometry(100, 50, { limitSideLen: 100 })).toEqual({ dstW: 96, dstH: 64 });
  });

  function probMap(w, h, rects) {
    const p = new Float32Array(w * h);
    for (const [x0, y0, x1, y1, v] of rects) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) p[y * w + x] = v;
    return p;
  }

  it('finds, scores and unclips text regions', () => {
    const p = probMap(64, 32, [[10, 5, 29, 9, 0.9], [40, 20, 41, 21, 0.9], [40, 25, 60, 30, 0.4]]);
    const boxes = detBoxes(p, 64, 32, 64, 32, { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5 });
    expect(boxes).toHaveLength(1); // the 2×2 speck is too small, the 0.4 region scores too low
    expect(boxes[0]).toMatchObject({ x: 8, y: 3, w: 23, h: 8 });
    expect(boxes[0].score).toBeCloseTo(0.9, 5);
  });

  it('maps boxes back to the source size', () => {
    const p = probMap(64, 32, [[10, 5, 29, 9, 0.9]]);
    const [box] = detBoxes(p, 64, 32, 128, 64, {});
    expect(box).toMatchObject({ x: 15, y: 5, w: 48, h: 18 });
  });
});

describe('line merging', () => {
  const b = (x, y, w, h, score = 0.9) => ({ x, y, w, h, score });

  it('merges overlapping word boxes of one line', () => {
    const merged = mergeLineBoxes([b(120, 40, 90, 30), b(10, 41, 120, 30)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ x: 10, y: 40, w: 200, h: 31, parts: 2 });
  });

  it('keeps stacked lines, far columns and different sizes apart', () => {
    expect(mergeLineBoxes([b(10, 10, 100, 30), b(10, 50, 100, 30)])).toHaveLength(2);
    expect(mergeLineBoxes([b(10, 10, 100, 30), b(200, 10, 60, 30)])).toHaveLength(2);
    expect(canMergeBoxes(b(10, 10, 100, 30), b(130, 10, 60, 30))).toBe(true); // gap 20 < 45
    expect(canMergeBoxes(b(10, 10, 100, 60), b(112, 30, 60, 20))).toBe(false); // height ratio
  });

  it('orders boxes in reading order', () => {
    const order = sortReadingOrder([b(200, 12, 50, 20), b(10, 50, 50, 20), b(10, 10, 50, 20)]);
    expect(order.map((x) => [x.x, x.y])).toEqual([[10, 10], [200, 12], [10, 50]]);
  });
});

describe('coordinates and crops', () => {
  it('maps ×k boxes to native pixels', () => {
    expect(toNativeBox({ x: 40, y: 8, w: 400, h: 56 }, 4, { x: 4, y: 100 })).toEqual({ x: 14, y: 102, w: 100, h: 14 });
    expect(toNativeBox({ x: 10, y: 10, w: 3, h: 3 }, 3)).toEqual({ x: 3.33, y: 3.33, w: 1, h: 1 });
  });

  it('crops with clamping', () => {
    const img = image(10, 10, (x, y) => [x, y, 0]);
    const c = cropImage(img, { x: 8, y: -2, w: 5, h: 4 });
    expect([c.x, c.y, c.width, c.height]).toEqual([8, 0, 2, 2]);
    expect([...c.data.subarray(0, 4)]).toEqual([8, 0, 0, 255]);
  });
});

describe('runtime', () => {
  it('knows the size of the onnxruntime-web WASM the worker downloads', () => {
    // fails after an onnxruntime-web upgrade: update RUNTIME_SIZE with it
    const wasm = path.resolve(__dirname, '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm');
    expect(fs.statSync(wasm).size).toBe(RUNTIME_SIZE);
  });

  it('detects WASM SIMD', () => {
    expect(hasWasmSimd()).toBe(true); // Node has it
  });
});
