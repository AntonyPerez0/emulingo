import { describe, it, expect, afterEach } from 'vitest';
import { createFrameSource, upscaleNearest, fnv1a, contentRect, viewportSize, makeImageData } from '../../src/core/ocr/capture.js';

// ---------------------------------------------------------------- helpers

function image(w, h, fill = [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  return { data, width: w, height: h };
}

function setPx(img, x, y, rgba) { img.data.set(rgba, (y * img.width + x) * 4); }
function getPx(img, x, y) { return [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)]; }

// A deterministic "native frame": every pixel a different colour.
function pattern(w, h) {
  const img = image(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPx(img, x, y, [(x * 7) & 255, (y * 13) & 255, (x * y) & 255, 255]);
  return img;
}

// Canvas-2D stand-in with nearest sampling at pixel centres (what
// imageSmoothingEnabled = false does), enough for createFrameSource.
class FakeCanvas {
  constructor(w = 0, h = 0) { this._resize(w, h); }
  _resize(w, h) { this._w = w; this._h = h; this.px = new Uint8ClampedArray(w * h * 4); }
  get width() { return this._w; }
  set width(v) { this._resize(v, this._h); }
  get height() { return this._h; }
  set height(v) { this._resize(this._w, v); }
  getContext() {
    const c = this;
    let m = [1, 0, 0, 1, 0, 0];
    return {
      imageSmoothingEnabled: true,
      setTransform(a, b, cc, d, e, f) { m = [a, b, cc, d, e, f]; },
      clearRect(x, y, w, h) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < c._w && j < c._h) c.px.fill(0, (j * c._w + i) * 4, (j * c._w + i) * 4 + 4); },
      drawImage(src, ...a) {
        // 3-arg form uses the transform; 9-arg form maps src rect -> dst rect
        const map = a.length === 2
          ? (i, j) => [((i + 0.5) - m[4]) / m[0] + a[0], ((j + 0.5) - m[5]) / m[3] + a[1]]
          : (i, j) => [a[0] + ((i + 0.5) - a[4]) * a[2] / a[6], a[1] + ((j + 0.5) - a[5]) * a[3] / a[7]];
        for (let j = 0; j < c._h; j++) {
          for (let i = 0; i < c._w; i++) {
            if (a.length === 8 && (i < a[4] || j < a[5] || i >= a[4] + a[6] || j >= a[5] + a[7])) continue;
            const [sx, sy] = map(i, j).map(Math.floor);
            if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
            const so = (sy * src.width + sx) * 4, o = (j * c._w + i) * 4;
            for (let k = 0; k < 4; k++) c.px[o + k] = src.px[so + k];
          }
        }
      },
      getImageData(x, y, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let j = 0; j < h; j++) out.set(c.px.subarray(((y + j) * c._w + x) * 4, ((y + j) * c._w + x + w) * 4), j * w * 4);
        return { data: out, width: w, height: h };
      }
    };
  }
}

// Draw a native frame like RetroArch: nearest upscale into viewport v
// (may start outside the canvas), transparent everywhere else.
function emulatorCanvas(native, cw, ch, v) {
  const c = new FakeCanvas(cw, ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const nx = Math.floor((i + 0.5 - v.x) * native.width / v.w), ny = Math.floor((j + 0.5 - v.y) * native.height / v.h);
      if (nx < 0 || ny < 0 || nx >= native.width || ny >= native.height) continue;
      c.px.set(native.data.subarray((ny * native.width + nx) * 4, (ny * native.width + nx) * 4 + 4), (j * cw + i) * 4);
    }
  }
  return c;
}

function samePixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

const realOffscreen = globalThis.OffscreenCanvas;
function withFakeCanvas() { globalThis.OffscreenCanvas = FakeCanvas; }
afterEach(() => { globalThis.OffscreenCanvas = realOffscreen; });

// ---------------------------------------------------------------- tests

describe('upscaleNearest', () => {
  it('repeats every pixel k×k', () => {
    const src = image(2, 2);
    setPx(src, 0, 0, [255, 0, 0, 255]); setPx(src, 1, 0, [0, 255, 0, 255]);
    setPx(src, 0, 1, [0, 0, 255, 255]); setPx(src, 1, 1, [9, 9, 9, 255]);
    const out = upscaleNearest(src, 3);
    expect([out.width, out.height]).toEqual([6, 6]);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) expect(getPx(out, x, y)).toEqual(getPx(src, (x / 3) | 0, (y / 3) | 0));
  });

  it('copies at k = 1 and floors non-integer factors', () => {
    const src = pattern(5, 3);
    const one = upscaleNearest(src, 1);
    expect(samePixels(one, src)).toBe(true);
    expect(one.data).not.toBe(src.data);
    const two = upscaleNearest(src, 2.7);
    expect([two.width, two.height]).toEqual([10, 6]);
    expect(getPx(two, 9, 5)).toEqual(getPx(src, 4, 2));
  });

  it('handles a GB frame at ×4 quickly', () => {
    const src = pattern(160, 144);
    const t0 = performance.now();
    const out = upscaleNearest(src, 4);
    const ms = performance.now() - t0;
    expect([out.width, out.height]).toEqual([640, 576]);
    expect(getPx(out, 639, 575)).toEqual(getPx(src, 159, 143));
    expect(ms).toBeLessThan(50);
  });
});

describe('fnv1a', () => {
  it('ignores noise in the low 4 bits of each channel', () => {
    const a = pattern(40, 30), b = pattern(40, 30);
    for (let i = 0; i < b.data.length; i += 4) {
      b.data[i] = (b.data[i] & 0xf0) | ((i * 7) & 0xf);
      b.data[i + 2] = (b.data[i + 2] & 0xf0) | 0xf;
      b.data[i + 3] = 17; // alpha is not hashed
    }
    expect(fnv1a(a)).toBe(fnv1a(b));
  });

  it('changes when any single pixel changes visibly', () => {
    const a = pattern(64, 48);
    const base = fnv1a(a);
    for (const [x, y] of [[0, 0], [63, 47], [31, 20]]) {
      const b = pattern(64, 48);
      const p = getPx(b, x, y);
      setPx(b, x, y, [p[0] ^ 0x80, p[1], p[2], 255]);
      expect(fnv1a(b)).not.toBe(base);
    }
  });

  it('hashes only inside rect, clamped to the image', () => {
    const a = pattern(32, 32), b = pattern(32, 32);
    setPx(b, 0, 0, [0x80, 0x40, 0x20, 255]);
    const r = { x: 4, y: 4, w: 10, h: 10 };
    expect(fnv1a(a, r)).toBe(fnv1a(b, r));
    expect(fnv1a(a)).not.toBe(fnv1a(b));
    expect(fnv1a(a, { x: -5, y: -5, w: 100, h: 100 })).toBe(fnv1a(a));
    expect(() => fnv1a(a, { x: 40, y: 40, w: 5, h: 5 })).not.toThrow();
    expect(fnv1a(a, { x: 40, y: 40, w: 5, h: 5 })).toBe(0x811c9dc5);
  });
});

describe('viewportSize / contentRect', () => {
  const gb = { w: 160, h: 144 };

  it('follows RetroArch rounding', () => {
    expect(viewportSize(888, 444, 160 / 144)).toEqual({ w: 493, h: 444 });
    expect(viewportSize(374, 610, 160 / 144)).toEqual({ w: 374, h: 337 });
    expect(viewportSize(640, 576, 160 / 144)).toEqual({ w: 640, h: 576 });
  });

  it('keeps an exact alpha box', () => {
    expect(contentRect({ x: 197, y: 0, w: 493, h: 444 }, 888, 444, gb)).toEqual({ x: 197, y: 0, w: 493, h: 444 });
    expect(contentRect({ x: 0, y: 0, w: 374, h: 337 }, 374, 610, gb)).toEqual({ x: 0, y: 0, w: 374, h: 337 });
  });

  it('extends a viewport clipped by the canvas edge', () => {
    // portrait top alignment: viewport y = -1, h = 337, visible rows 0..335
    expect(contentRect({ x: 0, y: 0, w: 374, h: 336 }, 374, 610, gb)).toEqual({ x: 0, y: -1, w: 374, h: 337 });
    // clipped at the bottom instead
    expect(contentRect({ x: 0, y: 274, w: 374, h: 336 }, 374, 610, gb)).toEqual({ x: 0, y: 274, w: 374, h: 337 });
  });

  it('trusts the alpha box when it disagrees with the aspect a lot', () => {
    // integer scaling or an unusual aspect: use what is drawn
    expect(contentRect({ x: 104, y: 6, w: 480, h: 432 }, 688, 444, gb)).toEqual({ x: 104, y: 6, w: 480, h: 432 });
  });

  it('uses a reported display aspect (NES 256×240 shown at 4:3)', () => {
    expect(contentRect({ x: 48, y: 0, w: 544, h: 408 }, 640, 408, { w: 256, h: 240, aspect: 4 / 3 })).toEqual({ x: 48, y: 0, w: 544, h: 408 });
  });
});

describe('createFrameSource', () => {
  it('returns null instead of throwing for missing, empty or broken canvases', () => {
    expect(createFrameSource({ getCanvas: () => null, getVideoDims: () => null }).grab()).toBeNull();
    expect(createFrameSource({ getCanvas: () => ({ width: 0, height: 0 }), getVideoDims: () => gbDims() }).grab()).toBeNull();
    expect(createFrameSource({ getCanvas: () => { throw new Error('boom'); }, getVideoDims: () => null }).grab()).toBeNull();
    expect(createFrameSource({}).grab()).toBeNull();
    // no canvas implementation at all (Node): still no throw
    globalThis.OffscreenCanvas = undefined;
    expect(createFrameSource({ getCanvas: () => new FakeCanvas(320, 288), getVideoDims: gbDims }).grab()).toBeNull();
  });

  it('recovers the exact native frame from letterboxed canvases', () => {
    withFakeCanvas();
    const native = pattern(160, 144);
    const cases = [
      [640, 576, { x: 0, y: 0, w: 640, h: 576 }],
      [1000, 900, { x: 0, y: 0, w: 1000, h: 900 }],
      [888, 444, { x: 197, y: 0, w: 493, h: 444 }],
      [374, 610, { x: 0, y: -1, w: 374, h: 337 }], // portrait, top row clipped
      [390, 351, { x: 0, y: 0, w: 390, h: 351 }]
    ];
    for (const [cw, ch, v] of cases) {
      const canvas = emulatorCanvas(native, cw, ch, v);
      const src = createFrameSource({ getCanvas: () => canvas, getVideoDims: gbDims });
      const f = src.grab();
      expect(f, `${cw}x${ch}`).not.toBeNull();
      expect([f.w, f.h]).toEqual([160, 144]);
      expect(samePixels(f.img, native), `${cw}x${ch}`).toBe(true);
      expect(typeof f.t).toBe('number');
    }
  });

  it('infers GB/GBA sizes when the core reports none', () => {
    withFakeCanvas();
    const gba = pattern(240, 160);
    const canvas = emulatorCanvas(gba, 720, 600, { x: 0, y: 60, w: 720, h: 480 });
    const f = createFrameSource({ getCanvas: () => canvas, getVideoDims: () => null }).grab();
    expect([f.w, f.h]).toEqual([240, 160]);
    expect(samePixels(f.img, gba)).toBe(true);
  });

  it('returns null for a cleared (fully transparent) canvas', () => {
    withFakeCanvas();
    const canvas = new FakeCanvas(320, 288);
    expect(createFrameSource({ getCanvas: () => canvas, getVideoDims: gbDims }).grab()).toBeNull();
  });

  it('re-measures when the picture moves inside an unchanged canvas', () => {
    withFakeCanvas();
    const native = pattern(160, 144);
    let canvas = emulatorCanvas(native, 888, 444, { x: 197, y: 0, w: 493, h: 444 });
    const src = createFrameSource({ getCanvas: () => canvas, getVideoDims: gbDims });
    expect(samePixels(src.grab().img, native)).toBe(true);
    // same canvas size, picture now left-aligned (stale cached rect)
    canvas = emulatorCanvas(native, 888, 444, { x: 0, y: 0, w: 493, h: 444 });
    const f = src.grab();
    expect(src.contentRect).toEqual({ x: 0, y: 0, w: 493, h: 444 });
    expect(samePixels(f.img, native)).toBe(true);
  });

  it('infers the native size when getVideoDims throws', () => {
    withFakeCanvas();
    const native = pattern(160, 144);
    const canvas = emulatorCanvas(native, 888, 444, { x: 197, y: 0, w: 493, h: 444 });
    const f = createFrameSource({ getCanvas: () => canvas, getVideoDims: () => { throw new Error('core gone'); } }).grab();
    expect([f.w, f.h]).toEqual([160, 144]);
    expect(samePixels(f.img, native)).toBe(true);
  });

  it('returns null when the picture has no known native size', () => {
    withFakeCanvas();
    // 3:1 content, no reported size: nothing to infer from
    const native = pattern(240, 80);
    const canvas = emulatorCanvas(native, 720, 240, { x: 0, y: 0, w: 720, h: 240 });
    expect(createFrameSource({ getCanvas: () => canvas, getVideoDims: () => null }).grab()).toBeNull();
    // ...but a reported size works at any aspect
    const f = createFrameSource({ getCanvas: () => canvas, getVideoDims: () => ({ w: 240, h: 80 }) }).grab();
    expect(samePixels(f.img, native)).toBe(true);
  });

  it('ignores nonsense video sizes', () => {
    withFakeCanvas();
    const native = pattern(160, 144);
    const canvas = emulatorCanvas(native, 320, 288, { x: 0, y: 0, w: 320, h: 288 });
    for (const bad of [{ w: 0, h: 144 }, { w: 'x', h: 2 }, { w: 5000, h: 144 }, {}]) {
      const f = createFrameSource({ getCanvas: () => canvas, getVideoDims: () => bad }).grab();
      expect([f.w, f.h], JSON.stringify(bad)).toEqual([160, 144]);
    }
  });

  it('re-measures a frame with transparent edges once, not on every grab', () => {
    withFakeCanvas();
    // the native frame itself has a transparent corner pixel
    const native = pattern(160, 144);
    native.data[3] = 0;
    const canvas = emulatorCanvas(native, 320, 288, { x: 0, y: 0, w: 320, h: 288 });
    let reads = 0;
    const real = FakeCanvas.prototype.getContext;
    FakeCanvas.prototype.getContext = function () {
      const ctx = real.call(this);
      const get = ctx.getImageData;
      ctx.getImageData = (...a) => { reads++; return get(...a); };
      return ctx;
    };
    try {
      const src = createFrameSource({ getCanvas: () => canvas, getVideoDims: gbDims });
      for (let i = 0; i < 5; i++) expect(src.grab()).not.toBeNull();
      // first grab: 2 probe strips + 1 native read; then 1 read per grab
      expect(reads).toBe(3 + 4);
    } finally {
      FakeCanvas.prototype.getContext = real;
    }
  });

  it('re-measures periodically', () => {
    withFakeCanvas();
    const native = pattern(160, 144);
    const canvas = emulatorCanvas(native, 320, 288, { x: 0, y: 0, w: 320, h: 288 });
    let reads = 0;
    const real = FakeCanvas.prototype.getContext;
    FakeCanvas.prototype.getContext = function () {
      const ctx = real.call(this);
      const get = ctx.getImageData;
      ctx.getImageData = (...a) => { reads++; return get(...a); };
      return ctx;
    };
    try {
      const src = createFrameSource({ getCanvas: () => canvas, getVideoDims: gbDims });
      for (let i = 0; i < 51; i++) src.grab();
      // 51 native reads + probes at the first grab and after 50 grabs
      expect(reads).toBe(51 + 2 * 2);
    } finally {
      FakeCanvas.prototype.getContext = real;
    }
  });

  it('follows canvas resizes (stage hidden: 0×0, then shown again)', () => {
    withFakeCanvas();
    const native = pattern(160, 144);
    let canvas = emulatorCanvas(native, 640, 576, { x: 0, y: 0, w: 640, h: 576 });
    const src = createFrameSource({ getCanvas: () => canvas, getVideoDims: gbDims });
    expect(src.grab()).not.toBeNull();
    canvas = new FakeCanvas(0, 0);
    expect(src.grab()).toBeNull();
    canvas = emulatorCanvas(native, 480, 432, { x: 0, y: 0, w: 480, h: 432 });
    expect(samePixels(src.grab().img, native)).toBe(true);
  });

  it('makes frames opaque', () => {
    withFakeCanvas();
    const native = pattern(160, 144);
    const canvas = emulatorCanvas(native, 320, 288, { x: 0, y: 0, w: 320, h: 288 });
    const f = createFrameSource({ getCanvas: () => canvas, getVideoDims: gbDims }).grab();
    for (let i = 3; i < f.img.data.length; i += 4) if (f.img.data[i] !== 255) throw new Error('alpha ' + f.img.data[i]);
  });
});

describe('makeImageData', () => {
  it('builds an ImageData-shaped object anywhere', () => {
    const d = new Uint8ClampedArray(2 * 3 * 4);
    const img = makeImageData(d, 2, 3);
    expect([img.width, img.height]).toEqual([2, 3]);
    expect(img.data).toBe(d);
  });
});

function gbDims() { return { w: 160, h: 144 }; }
