#!/usr/bin/env node
// Renders every bench scene (bench/scenes.js) at NATIVE resolution in
// headless Chromium and writes, per scene:
//   <id>.png   the native frame (RGBA, lossless)
//   <id>.json  the scene's ground truth plus `text`: where the text pixels
//              are, as boxes per role
// Roles come from which scene helper drew the glyphs (found from the call
// stack of each glyph fillRect): 'dialog' (dialog / battle message boxes),
// 'menu', 'sign', 'hud' (unboxed Gen 1 battle labels) and 'boxed' (text in a
// small framed box: money boxes, GBA battle HUDs).
//
//   node tests/fixtures/frames/generate.mjs [--port=5431]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchChromium, BLANK } from '../../e2e-capture/server.mjs';
import { encodePng } from './png.mjs';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const port = +(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 5431);

const ROLE_BY_FN = { gbDialog: 'dialog', gbaDialog: 'dialog', gbMenu: 'menu', gbBattle: 'hud', gbaHud: 'boxed' };
const ROLE_BY_KIND = { hud: 'boxed', sign: 'sign', menu: 'menu', dialog: 'dialog' };

const server = await startServer({ port, pages: { '/': BLANK } });
const browser = await launchChromium();
try {
  const page = await browser.newPage();
  await page.goto(server.origin + '/');
  const scenes = await page.evaluate(async () => {
    const mod = await import('/bench/scenes.js');
    Error.stackTraceLimit = 64;
    let rects = null;
    // which scene helper drew this fillRect, when it is glyph ink
    const record = (style, x, y, w, h) => {
      if (!rects) return;
      const stack = new Error().stack.split('\n');
      if (!stack.some((l) => /\binkPixels\b/.test(l))) return;
      // first NAMED scenes.js frame above the text helpers (forEach
      // callbacks are anonymous); scene build() methods count as 'build'
      let fn = 'build';
      for (const l of stack) {
        const m = l.match(/at (?:Object\.)?([\w$.]+) \(.*\/bench\/scenes\.js:\d+:\d+\)/);
        if (!m) continue;
        const name = m[1].replace(/^.*\./, '');
        if (name === 'tileText' || name === 'propText') continue;
        fn = name;
        break;
      }
      rects.push([x, y, w, h, fn, String(style).toLowerCase()]);
    };
    mod.setCanvasFactory((w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const get = c.getContext.bind(c);
      c.getContext = (type, opts) => {
        const ctx = get(type, opts);
        if (type !== '2d') return ctx;
        return new Proxy(ctx, {
          get(t, k) {
            if (k === 'fillRect') return (...a) => { record(t.fillStyle, ...a); t.fillRect(...a); };
            const v = t[k];
            return typeof v === 'function' ? v.bind(t) : v;
          },
          set(t, k, v) { t[k] = v; return true; }
        });
      };
      return c;
    });
    const out = [];
    for (const s of mod.SCENES) {
      rects = [];
      const { canvas, truth } = mod.renderScene(s);
      const ink = rects;
      rects = null;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let bin = '';
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
      out.push({ truth, ink, rgba: btoa(bin) });
    }
    return out;
  });

  const index = [];
  for (const { truth, ink, rgba } of scenes) {
    const W = truth.nativeW, H = truth.nativeH;
    const named = new Set(ink.map((r) => r[4]).filter((f) => f && f !== 'build'));
    const covered = new Set();
    for (const f of named) {
      if (f === 'gbDialog' || f === 'gbaDialog' || f === 'gbaBattleMessage') { covered.add('dialog'); covered.add('sign'); }
      if (f === 'gbMenu' || f === 'gbaBattleMessage') covered.add('menu');
      if (f === 'gbBattle' || f === 'gbaHud') covered.add('hud');
    }
    const rest = [...new Set(truth.regions.map((r) => r.kind))].filter((k) => !covered.has(k));
    // battle message text is white with a mauve shadow; menu text is dark ink
    const roleOf = ([, , , , fn, style]) => {
      if (fn === 'gbaBattleMessage') return style === '#f8f8f8' || style === '#685868' ? 'dialog' : 'menu';
      if (ROLE_BY_FN[fn]) return ROLE_BY_FN[fn];
      if (rest.length !== 1) throw new Error(`${truth.id}: cannot attribute text drawn by ${fn} (unmatched kinds ${rest})`);
      return ROLE_BY_KIND[rest[0]];
    };
    const masks = {};
    for (const r of ink) {
      const role = roleOf(r);
      const m = masks[role] || (masks[role] = new Uint8Array(W * H));
      for (let y = r[1]; y < r[1] + r[3]; y++) for (let x = r[0]; x < r[0] + r[2]; x++) if (x >= 0 && y >= 0 && x < W && y < H) m[y * W + x] = 1;
    }
    const text = [];
    for (const [role, m] of Object.entries(masks)) for (const b of blocks(m, W, H)) text.push({ role, ...b });
    text.sort((a, b) => a.y - b.y || a.x - b.x);
    const fixture = { ...truth, text };
    fs.writeFileSync(path.join(OUT, truth.id + '.json'), JSON.stringify(fixture, null, 1) + '\n');
    fs.writeFileSync(path.join(OUT, truth.id + '.png'), encodePng(W, H, new Uint8Array(Buffer.from(rgba, 'base64'))));
    index.push(truth.id);
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  console.log(`wrote ${index.length} scenes to ${path.relative(process.cwd(), OUT) || '.'}`);
} finally {
  await browser.close();
  await server.close();
}

// Text blocks: connected ink pixels, bridging gaps of up to 3 px across and
// 2 px down (letters of a line, the rows of one glyph). One block per line
// segment is plenty for "is this text inside a container" checks.
function blocks(mask, W, H) {
  const parent = new Int32Array(W * H).fill(-1);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let i = 0; i < W * H; i++) if (mask[i]) parent[i] = i;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!mask[i]) continue;
    for (let dy = 0; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (!dy && dx <= 0) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy >= H || xx >= W) continue;
      const j = yy * W + xx;
      if (mask[j]) union(i, j);
    }
  }
  const boxes = new Map();
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const r = find(i), x = i % W, y = (i / W) | 0;
    const b = boxes.get(r);
    if (!b) boxes.set(r, { x0: x, y0: y, x1: x, y1: y, px: 1 });
    else { b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y); b.px++; }
  }
  return [...boxes.values()].map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, px: b.px }));
}
