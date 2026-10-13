#!/usr/bin/env node
// Real EmulatorJS 4.2.3 (gambatte, served locally) + the homebrew test ROM in
// headless Chromium: grab() must return the exact native frame at several
// stage shapes, viewports and DPRs, also after the stage is hidden and shown.
//
//   node bench/e2e/setup.mjs                  # once: lays out EmulatorJS
//   node tests/e2e-capture/emulator.mjs [--port=5452] [--out=DIR]
//
// The expected frame is the ROM's own tile rendering (renderExpected from
// bench/e2e/make-gb-rom.mjs; water and the blinking arrow are don't-care).
// "Exact" means: every pixel classifies to its expected palette index AND
// each palette index maps to exactly one RGB colour (no smoothing blend).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, launchChromium, REPO_ROOT } from './server.mjs';
import { renderExpected, writeAll } from '../../bench/e2e/make-gb-rom.mjs';
import { encodePng } from '../fixtures/frames/png.mjs';

const EJS_DIR = path.join(REPO_ROOT, 'bench', '.cache', 'emulatorjs');
const ROM_DIR = path.join(REPO_ROOT, 'bench', '.cache', 'e2e');
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || path.join(os.tmpdir(), 'spritespeak-e2e-capture');
const port = +(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 5452);

if (!fs.existsSync(path.join(EJS_DIR, 'loader.js'))) {
  console.error('EmulatorJS is not laid out: run node bench/e2e/setup.mjs first');
  process.exit(2);
}
if (!fs.existsSync(path.join(ROM_DIR, 'spritespeak-ocr-test.gb'))) writeAll(ROM_DIR);
fs.mkdirSync(OUT, { recursive: true });

// stage: the #game box (CSS px). 'fit' = aspect-ratio box like the v2 stage
const CASES = [
  { name: 'desktop 10:9 stage, DPR 1', viewport: [1280, 800], dpr: 1, stage: 'width:600px;aspect-ratio:10/9' },
  { name: 'desktop 10:9 stage, DPR 2', viewport: [1280, 800], dpr: 2, stage: 'width:600px;aspect-ratio:10/9' },
  { name: 'desktop 2:1 box (pillarbox), DPR 1', viewport: [1280, 800], dpr: 1, stage: 'width:888px;height:444px' },
  { name: 'phone 390x844 portrait box, DPR 3', viewport: [390, 844], dpr: 3, stage: 'width:374px;height:610px' },
  { name: 'phone 390x844 10:9 stage, DPR 3', viewport: [390, 844], dpr: 3, stage: 'width:374px;aspect-ratio:10/9' },
  { name: 'phone 390x844 10:9 stage, DPR 2', viewport: [390, 844], dpr: 2, stage: 'width:374px;aspect-ratio:10/9' }
];

const html = (stage) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>capture e2e</title>
<style>body{margin:0;background:#111}#wrap{padding:8px}#game{${stage};position:relative}</style>
<div id="wrap"><div id="game"></div></div>
<script>
  // like src/core/emulator.js: preserveDrawingBuffer only for EmulatorJS's canvas
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (typeof type === 'string' && type.startsWith('webgl') && this.classList.contains('ejs_canvas')) attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
    return orig.call(this, type, attrs);
  };
  window.EJS_player = '#game';
  window.EJS_core = 'gb';
  window.EJS_pathtodata = '/ejs/';
  window.EJS_gameUrl = '/rom/spritespeak-ocr-test.gb';
  window.EJS_gameName = 'spritespeak-ocr-test';
  window.EJS_startOnLoaded = true;
  window.EJS_volume = 0;
  window.EJS_Buttons = { exitEmulation: false, cacheManager: false, netplay: false };
  window.EJS_onGameStart = () => { window.__started = true; };
</script>
<script src="/ejs/loader.js"></script>`;

const pages = Object.fromEntries(CASES.map((c, i) => ['/case' + i, html(c.stage)]));
const server = await startServer({ port, mounts: { '/ejs/': EJS_DIR, '/rom/': ROM_DIR }, pages });
const browser = await launchChromium();
const expected = renderExpected(0, { arrow: null });
const results = [];
let live = null;
try {
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const context = await browser.newContext({ viewport: { width: c.viewport[0], height: c.viewport[1] }, deviceScaleFactor: c.dpr });
    // nothing may leave the machine (EmulatorJS probes its CDN for updates)
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(server.origin + '/case' + i);
    await page.waitForFunction(() => window.__started === true, null, { timeout: 90000 });
    // page 0 types in ~1 s; give it time to finish
    await page.waitForTimeout(2500);
    const grabIn = () => page.evaluate(async () => {
      const { createFrameSource } = await import('/src/core/ocr/capture.js');
      const gm = window.EJS_emulator.gameManager;
      const src = window.__src || (window.__src = createFrameSource({
        getCanvas: () => window.EJS_emulator.canvas,
        getVideoDims: () => ({ w: gm.functions.getVideoDimensions('width'), h: gm.functions.getVideoDimensions('height') })
      }));
      const times = [];
      let f = null;
      for (let k = 0; k < 20; k++) {
        await new Promise((r) => requestAnimationFrame(r));
        const t0 = performance.now();
        f = src.grab();
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const cv = window.EJS_emulator.canvas;
      if (!f) return { frame: null, canvas: [cv.width, cv.height] };
      let s = '';
      const u8 = new Uint8Array(f.img.data.buffer);
      for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
      return { frame: { w: f.w, h: f.h, rgba: btoa(s) }, rect: src.contentRect, canvas: [cv.width, cv.height], medianMs: times[10], maxMs: times[19] };
    });
    const r1 = await grabIn();
    // hide the stage (backing store collapses), grab (must be null), show again
    await page.evaluate(() => { document.getElementById('game').style.display = 'none'; });
    await page.waitForTimeout(800);
    const hidden = await page.evaluate(() => { const f = window.__src.grab(); const cv = window.EJS_emulator.canvas; return { isNull: f === null, canvas: [cv.width, cv.height] }; });
    await page.evaluate(() => { document.getElementById('game').style.display = ''; window.EJS_emulator.handleResize?.(); });
    await page.waitForTimeout(1200);
    const r2 = await grabIn();
    const tag = `case${i}`;
    if (r1.frame) fs.writeFileSync(path.join(OUT, `${tag}-native.png`), encodePng(r1.frame.w, r1.frame.h, new Uint8Array(Buffer.from(r1.frame.rgba, 'base64'))));
    await page.screenshot({ path: path.join(OUT, `${tag}-page.png`) });
    if (i === 0) live = await liveTracker(page);
    results.push({ case: c.name, canvas: r1.canvas.join('x'), rect: r1.rect && `${r1.rect.x},${r1.rect.y} ${r1.rect.w}x${r1.rect.h}`, ...score(r1.frame, 'before'), hiddenGrabNull: hidden.isNull, hiddenCanvas: hidden.canvas.join('x'), afterCanvas: r2.canvas.join('x'), ...score(r2.frame, 'after'), medianMs: r1.medianMs && +r1.medianMs.toFixed(2), maxMs: r1.maxMs && +r1.maxMs.toFixed(2), errors: errors.length });
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.table(results);
const bad = results.filter((r) => r.beforeWrong !== 0 || r.afterWrong !== 0 || !r.beforePure || !r.afterPure || !r.hiddenGrabNull);
if (bad.length) { console.error('FAILED:', bad.map((r) => r.case).join('; ')); process.exitCode = 1; } else console.log('all cases exact');
console.log('live tracker (200 ms polls, real typewriter / blinking ▼ / animated water):');
console.table(live.summary);
if (live.problems.length) { console.error('LIVE FAILED:', live.problems.join('; ')); process.exitCode = 1; } else console.log('live tracker ok');

// Polls grab() + tracker.update() every 200 ms on the running ROM: page 0
// (typed, ▼ blinking), then A → page 1 types and settles. The dialog hash
// must change only while text is typed, and the final crop must equal the
// ROM's page 1 with the arrow cell blank.
async function liveTracker(page) {
  const poll = (n) => page.evaluate(async (n) => {
    const { createContainerTracker } = await import('/src/core/ocr/containers.js');
    const tr = window.__tr || (window.__tr = createContainerTracker());
    const out = [];
    for (let k = 0; k < n; k++) {
      await new Promise((r) => setTimeout(r, 200));
      const f = window.__src.grab();
      if (!f) { out.push(null); continue; }
      const cs = tr.update(f);
      const d = cs.find((c) => c.kind === 'dialog');
      out.push({ t: f.t, kinds: cs.map((c) => c.kind).join(','), key: d && d.key, hash: d && d.hash, settledMs: d && d.settledMs });
      if (k === n - 1 && d) {
        const { img, offset } = d.crop();
        let s = '';
        const u8 = new Uint8Array(img.data.buffer);
        for (let j = 0; j < u8.length; j += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(j, j + 0x8000));
        out.crop = { w: img.width, h: img.height, offset, rgba: btoa(s), box: { x: d.x, y: d.y, w: d.w, h: d.h } };
      }
    }
    return { polls: out, crop: out.crop };
  }, n);
  const problems = [];
  const a = await poll(25);
  await page.evaluate(() => { try { window.EJS_emulator.elements.parent.focus(); } catch {} });
  await page.keyboard.down('z');
  await page.waitForTimeout(150);
  await page.keyboard.up('z');
  const b = await poll(25);
  const phase = (name, polls) => {
    const ok = polls.filter(Boolean);
    const keys = new Set(ok.map((p) => p.key));
    const changes = ok.slice(1).filter((p, i) => p.hash !== ok[i].hash).length;
    const last = ok.at(-1);
    return { phase: name, polls: polls.length, nullGrabs: polls.length - ok.length, kinds: [...new Set(ok.map((p) => p.kinds))].join(' | '), keys: keys.size, hashChanges: changes, finalSettledMs: last && Math.round(last.settledMs) };
  };
  const summary = [phase('page 0 (typed, ▼ blinking)', a.polls), phase('A → page 1 typing + settle', b.polls)];
  if (summary[0].keys !== 1 || summary[1].keys !== 1) problems.push('dialog key not stable');
  if (summary[0].hashChanges > 1) problems.push(`page 0 hash changed ${summary[0].hashChanges}× (blinking arrow not masked)`);
  if (summary[1].hashChanges < 1) problems.push('page 1 typing did not change the hash');
  if (!(summary[0].finalSettledMs >= 3000)) problems.push('page 0 never settled');
  if (!(summary[1].finalSettledMs >= 2000)) problems.push('page 1 never settled');
  // crop of page 1 vs the ROM's own tiles (arrow cell must be blank)
  const exp = renderExpected(1, { arrow: false });
  const c = b.crop;
  if (!c) problems.push('no dialog crop');
  else {
    const px = Buffer.from(c.rgba, 'base64');
    const pal = new Map();
    let wrong = 0;
    for (let y = c.box.y; y < c.box.y + c.box.h; y++) {
      for (let x = c.box.x; x < c.box.x + c.box.w; x++) {
        const k = exp[y * 160 + x];
        const o = ((y - c.offset.y) * c.w + (x - c.offset.x)) * 4;
        const col = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];
        if (!pal.has(k)) pal.set(k, col);
        else if (pal.get(k) !== col) wrong++;
      }
    }
    summary.push({ phase: 'page 1 crop vs ROM tiles', polls: '', nullGrabs: '', kinds: `${c.w}x${c.h} @${c.offset.x},${c.offset.y}`, keys: '', hashChanges: '', finalSettledMs: `${wrong} wrong px` });
    if (wrong) problems.push(`page 1 crop has ${wrong} wrong pixels`);
  }
  return { summary, problems };
}

// palette learned from the expected indices; exact = every pixel matches its
// index's colour and every index has a single colour
function score(frame, tag) {
  if (!frame) return { [tag + 'Wrong']: 'no frame', [tag + 'Pure']: false };
  if (frame.w !== 160 || frame.h !== 144) return { [tag + 'Wrong']: `dims ${frame.w}x${frame.h}`, [tag + 'Pure']: false };
  const px = Buffer.from(frame.rgba, 'base64');
  const colours = [new Map(), new Map(), new Map(), new Map()];
  for (let i = 0; i < expected.length; i++) {
    const k = expected[i];
    if (k === 255) continue;
    const c = (px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2];
    colours[k].set(c, (colours[k].get(c) || 0) + 1);
  }
  const pal = colours.map((m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0]);
  let wrong = 0;
  for (let i = 0; i < expected.length; i++) {
    const k = expected[i];
    if (k === 255) continue;
    const c = (px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2];
    if (c !== pal[k] || pal.indexOf(c) !== k) wrong++;
  }
  return { [tag + 'Wrong']: wrong, [tag + 'Pure']: colours.every((m) => m.size <= 1) };
}
