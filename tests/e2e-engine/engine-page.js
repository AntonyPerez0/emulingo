// Browser side of the engine check: renders bench scenes at native
// resolution, cuts text-row strips, and reads them through the real engine
// (module worker + onnxruntime-web WASM) and the Tesseract fallback, while a
// long-task observer measures main-thread blocking.

import { createOcrEngine } from '../../src/core/ocr/engine.js';
import { renderScene } from '../../bench/scenes.js';

const longTasks = [];
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration }); })
    .observe({ type: 'longtask', buffered: true });
} catch { /* not supported */ }

function nativeImage(id) {
  const { canvas, truth } = renderScene(id);
  return { img: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), truth };
}

function upscale(img, k) {
  const W = img.width * k, H = img.height * k;
  const out = new ImageData(W, H);
  const s = new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
  const d = new Uint32Array(out.data.buffer);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = s[((y / k) | 0) * img.width + ((x / k) | 0)];
  return out;
}

function crop(img, x, y, w, h) {
  const out = new ImageData(w, h);
  for (let r = 0; r < h; r++) out.data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return out;
}

// Text rows inside a light box interior: rows with dark pixels, ±3 px.
function rowStrips(img, box, k) {
  const dark = (x, y) => { const i = (y * img.width + x) * 4; return img.data[i] + img.data[i + 1] + img.data[i + 2] < 384; };
  const rows = [];
  let start = -1;
  for (let y = box.y; y <= box.y + box.h; y++) {
    let on = false;
    for (let x = box.x; x < box.x + box.w && !on && y < box.y + box.h; x++) on = dark(x, y);
    if (on && start < 0) start = y;
    if (!on && start >= 0) { rows.push([start, y - 1]); start = -1; }
  }
  return rows.map(([a, b]) => {
    const y = Math.max(0, a - 3), h = Math.min(img.height, b + 4) - y;
    return { img: upscale(crop(img, box.x, y, box.w, h), k), k, offset: { x: box.x, y } };
  });
}

async function measured(fn) {
  // start in a fresh task: rendering the test frame just before (~60 ms of
  // canvas work) must not count as a long task of the read
  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();
  const value = await fn();
  const t1 = performance.now();
  await new Promise((r) => setTimeout(r, 30));
  const tasks = longTasks.filter((t) => t.start < t1 && t.start + t.dur > t0);
  return { value, ms: Math.round(t1 - t0), maxLongTaskMs: Math.round(tasks.reduce((a, t) => Math.max(a, t.dur), 0)) };
}

window.engineTest = async () => {
  const statuses = [];
  const engine = createOcrEngine({
    onStatus: (s) => statuses.push({ phase: s.phase, progress: s.progress, message: s.message, engine: s.engine }),
    modelBase: new URL('../../models/', location.href).href
  });
  const out = { statuses };
  const prep = await measured(() => engine.prepare('en'));
  out.prepare = { ms: prep.ms, maxLongTaskMs: prep.maxLongTaskMs };

  // GB dialog: interior x 8..151, y 104..135
  const gb = nativeImage('gb1-oak-hello-en');
  const lines = await measured(() => engine.read({ mode: 'lines', lang: 'en', strips: rowStrips(gb.img, { x: 8, y: 104, w: 144, h: 32 }, 4) }));
  out.lines = { engine: lines.value.engine, texts: lines.value.lines.map((l) => l.text), boxes: lines.value.lines.map((l) => l.box), ms: lines.ms, maxLongTaskMs: lines.maxLongTaskMs };

  const free = await measured(() => engine.read({ mode: 'free', lang: 'en', img: upscale(gb.img, 4), k: 4, offset: { x: 0, y: 0 } }));
  out.free = { engine: free.value.engine, texts: free.value.lines.map((l) => l.text), ms: free.ms, maxLongTaskMs: free.maxLongTaskMs };

  // GBA battle: light text on a dark box, container mode on the bottom boxes
  const gba = nativeImage('gba-battle-menu-en');
  const box = crop(gba.img, 0, 112, 240, 48);
  const cont = await measured(() => engine.read({ mode: 'container', lang: 'en', img: upscale(box, 3), k: 3, offset: { x: 0, y: 112 } }));
  out.container = { engine: cont.value.engine, texts: cont.value.lines.map((l) => l.text), ms: cont.ms, maxLongTaskMs: cont.maxLongTaskMs };

  // the Tesseract fallback on the same strips (lazy chunk, worker, core)
  engine.setPreference('tesseract');
  const tess = await measured(() => engine.read({ mode: 'lines', lang: 'en', strips: rowStrips(gb.img, { x: 8, y: 104, w: 144, h: 32 }, 4) }));
  out.tesseract = { engine: tess.value.engine, texts: tess.value.lines.map((l) => l.text), ms: tess.ms, maxLongTaskMs: tess.maxLongTaskMs };

  // switching languages while a Tesseract read runs: the read still
  // finishes (tesseract.js never settles jobs of a terminated worker)
  const switching = engine.read({ mode: 'lines', lang: 'en', strips: rowStrips(gb.img, { x: 8, y: 104, w: 144, h: 32 }, 4) });
  const settle = (p) => p.then((v) => ({ ok: true, texts: v.lines.map((l) => l.text) }), (e) => ({ ok: false, error: `${e.name}: ${e.message}` }));
  const [enRead] = await Promise.all([settle(switching), engine.prepare('de')]);
  const deRead = await settle(engine.read({ mode: 'lines', lang: 'de', strips: rowStrips(gb.img, { x: 8, y: 104, w: 144, h: 32 }, 4) }));
  out.languageSwitch = { en: enRead, de: deRead };

  out.state = engine.state();

  // closing the engine during a Tesseract read settles it at once
  const closing = settle(engine.read({ mode: 'lines', lang: 'de', strips: rowStrips(gb.img, { x: 8, y: 104, w: 144, h: 32 }, 4) }));
  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();
  engine.dispose();
  out.dispose = { ...(await closing), ms: Math.round(performance.now() - t0) };
  document.getElementById('out').textContent = JSON.stringify(out, null, 2);
  return out;
};
