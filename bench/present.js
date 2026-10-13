// Presentation simulation: what the app's emulator.snapshot() sees.
//
// EmulatorJS draws the native frame into a WebGL canvas sized to its
// container, aspect-fit and centred with black letterbox/pillarbox bars,
// scaled with either nearest or bilinear filtering. presentFrame() rebuilds
// that canvas from a native frame and returns the same `grid` object
// src/core/emulator.js getGrid() would compute for it.

import { newCanvas } from './scenes.js';

// Canvas sizes are those of the #game element's backing store. GB frames
// (10:9) fill the first three exactly or with rounding slack; GBA frames
// (3:2) get letterbox bars in all of them.
export const VARIANTS = [
  { id: 'x4-nearest', w: 640, h: 576, smoothing: false, note: '640x576, integer 4x (GB), nearest' },
  { id: 'x6.25-nearest', w: 1000, h: 900, smoothing: false, note: '1000x900, non-integer 6.25x (GB), nearest' },
  { id: 'x8-bilinear', w: 1280, h: 1152, smoothing: true, note: '1280x1152, 8x (GB), bilinear' },
  { id: 'fhd-letterbox-bilinear', w: 1920, h: 1080, smoothing: true, note: '1920x1080 full-screen, pillarboxed, bilinear' },
  { id: 'phone-bilinear', w: 390, h: 351, smoothing: true, note: '390x351 phone portrait, 2.44x (GB), bilinear' }
];

export const DEFAULT_VARIANTS = ['x4-nearest', 'x6.25-nearest', 'fhd-letterbox-bilinear', 'phone-bilinear'];

export function getVariant(id) {
  const v = VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error('unknown variant ' + id);
  return v;
}

// EXACT copy of the arithmetic in src/core/emulator.js getGrid() (with the
// native dims passed in instead of read from window.__emulingoCore)
export function gridFor(srcW, srcH, nativeW, nativeH) {
  const scale = Math.min(srcW / nativeW, srcH / nativeH);
  const contentW = Math.min(srcW, Math.round(nativeW * scale));
  const contentH = Math.min(srcH, Math.round(nativeH * scale));
  return {
    nativeW, nativeH,
    scale,
    contentW, contentH,
    x0: Math.round((srcW - contentW) / 2),
    y0: Math.round((srcH - contentH) / 2)
  };
}

export function presentFrame(native, variant) {
  const v = typeof variant === 'string' ? getVariant(variant) : variant;
  const grid = gridFor(v.w, v.h, native.width, native.height);
  const canvas = newCanvas(v.w, v.h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, v.w, v.h);
  ctx.imageSmoothingEnabled = !!v.smoothing;
  if (v.smoothing) ctx.imageSmoothingQuality = 'low'; // bilinear, like GL_LINEAR
  ctx.drawImage(native, 0, 0, native.width, native.height, grid.x0, grid.y0, grid.contentW, grid.contentH);
  return { canvas, grid };
}
