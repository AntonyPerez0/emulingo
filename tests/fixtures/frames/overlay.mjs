#!/usr/bin/env node
// Contact sheet of the frame fixtures with what containers.js finds drawn on
// top: container interiors (dialog green, battle teal, menu orange, box
// yellow, free grey), text cells (cyan) and static cursors (magenta).
//
//   node tests/fixtures/frames/overlay.mjs [out.png]   (default: $TMPDIR)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { findContainers, createContainerTracker } from '../../../src/core/ocr/containers.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(os.tmpdir(), 'spritespeak-containers.png');
const ids = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const COLOURS = { dialog: [0, 200, 0], battle: [0, 170, 170], menu: [255, 140, 0], box: [230, 200, 0], free: [128, 128, 128], zone: [0, 0, 255] };
const S = 2, PAD = 6, COLS = 6, CW = 240 * S + PAD, CH = 160 * S + PAD;
const rows = Math.ceil(ids.length / COLS);
const W = COLS * CW, H = rows * CH;
const out = new Uint8Array(W * H * 4).fill(40);
for (let i = 3; i < out.length; i += 4) out[i] = 255;

const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) out.set(c, (y * W + x) * 4); };
const rect = (ox, oy, r, c, inset = 0) => {
  const x0 = ox + r.x * S - 1 - inset, y0 = oy + r.y * S - 1 - inset, x1 = ox + (r.x + r.w) * S + inset, y1 = oy + (r.y + r.h) * S + inset;
  for (let x = x0; x <= x1; x++) { put(x, y0, c); put(x, y1, c); }
  for (let y = y0; y <= y1; y++) { put(x0, y, c); put(x1, y, c); }
};

ids.forEach((id, n) => {
  const img = decodePng(fs.readFileSync(path.join(DIR, id + '.png')));
  const ox = (n % COLS) * CW, oy = Math.floor(n / COLS) * CH;
  for (let y = 0; y < img.height * S; y++) {
    for (let x = 0; x < img.width * S; x++) out.set(img.data.subarray((((y / S) | 0) * img.width + ((x / S) | 0)) * 4, (((y / S) | 0) * img.width + ((x / S) | 0)) * 4 + 3), ((oy + y) * W + ox + x) * 4);
  }
  const boxes = findContainers(img);
  const tracked = createContainerTracker().update({ img, w: img.width, h: img.height, t: 0 });
  for (const c of tracked) {
    rect(ox, oy, c, COLOURS[c.kind] || [255, 0, 0], 1);
    for (const cell of c.cells ? c.cells() : []) rect(ox, oy, cell, [0, 220, 255]);
  }
  for (const b of boxes) for (const cur of b.cursors || []) rect(ox, oy, cur, [255, 0, 255]);
});
fs.writeFileSync(OUT, encodePng(W, H, out));
console.log('wrote', OUT);
