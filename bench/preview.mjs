#!/usr/bin/env node
// Contact sheet of every bench scene (native frames, 2x nearest) with the
// ground truth printed underneath - for eyeballing scenes without a browser.
//
//   npm run bench:scenes [-- --out bench/results/scenes.png] [--scene filter] [--scale 2]
//
// Uses @napi-rs/canvas (devDependency) as the canvas implementation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const out = path.resolve(opt('out', path.join(here, 'results', 'scenes.png')));
const filter = opt('scene', '');
const scale = Number(opt('scale', '2'));

const { createCanvas } = await import('@napi-rs/canvas');
const { setCanvasFactory, SCENES, renderScene } = await import('./scenes.js');
setCanvasFactory((w, h) => createCanvas(w, h));

const scenes = SCENES.filter((s) => !filter || filter.split(',').some((f) => s.id.includes(f)));
const cellW = 240 * scale + 16, cellH = 160 * scale + 64;
const cols = Math.min(4, scenes.length);
const rows = Math.ceil(scenes.length / cols);
const sheet = createCanvas(cols * cellW, rows * cellH);
const sx = sheet.getContext('2d');
sx.fillStyle = '#202024';
sx.fillRect(0, 0, sheet.width, sheet.height);
sx.imageSmoothingEnabled = false;
scenes.forEach((s, i) => {
  const { canvas, truth } = renderScene(s);
  const x = (i % cols) * cellW + 8, y = Math.floor(i / cols) * cellH + 8;
  sx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, canvas.width * scale, canvas.height * scale);
  sx.fillStyle = '#f0f0f0';
  sx.font = '12px sans-serif';
  sx.fillText(`${truth.id}${truth.partial ? ' (partial)' : ''}`, x, y + 160 * scale + 14);
  sx.fillStyle = '#a8d8a8';
  const gt = truth.regions.map((r) => `[${r.kind}] ${r.text}`).join('  ') || '(no text)';
  sx.fillText(gt.slice(0, 80), x, y + 160 * scale + 30);
  if (gt.length > 80) sx.fillText(gt.slice(80, 160), x, y + 160 * scale + 44);
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, sheet.toBuffer('image/png'));
console.log(`${scenes.length} scenes -> ${path.relative(process.cwd(), out)}`);
