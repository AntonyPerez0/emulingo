// Test-bed glue: exposes the emulator modules and a few probes on window
// for tests/e2e-emu/emu.e2e.mjs.

import * as emu from '../../src/core/emulator.js';
import * as rom from '../../src/core/rom.js';
import { makeSramCounterGbRom, makeGbaRom, makeZip } from './fixtures.mjs';
import { crc32 } from '../../src/core/zip.js';
import * as idb from '../../src/core/idb.js';

const events = [];
emu.onEvent((type, detail) => {
  events.push({ type, at: Math.round(performance.now()), phase: detail.phase, slot: detail.slot, code: detail.code, progress: detail.progress });
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

// Exact native frame from the core (PNG), decoded.
async function nativeFrame() {
  const gm = window.EJS_emulator.gameManager;
  const png = await Promise.race([gm.screenshot(), timeout(3000)]);
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

const lum = (d, i) => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;

// The SRAM test ROM draws (counter & 31) dark tiles in the top row and a
// dark block from tile row 13 down.
async function screenCounter() {
  const img = await nativeFrame();
  const { data, width } = img;
  let n = 0;
  for (let t = 0; t < 20; t++) {
    if (lum(data, (4 * width + t * 8 + 4) * 4) < 100) n++;
    else break;
  }
  const bottomDark = lum(data, (120 * width + 80) * 4) < 100;
  return { n, w: img.width, h: img.height, rendered: bottomDark };
}

// What OCR capture does: read the WebGL canvas through a 2D canvas.
function canvasReadback() {
  const src = emu.getCanvas();
  if (!src || !src.width) return { ok: false };
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4 * 97) {
    if (d[i + 3] > 0) { opaque++; if (lum(d, i) < 100) dark++; }
  }
  let attrs = null;
  for (const type of ['webgl2', 'webgl']) {
    const gl = src.getContext(type);
    if (gl) { attrs = { type, preserveDrawingBuffer: gl.getContextAttributes().preserveDrawingBuffer }; break; }
  }
  return { ok: opaque > 0 && dark > 0, w: src.width, h: src.height, opaque, dark, attrs };
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gbaZip() {
  const gba = makeGbaRom();
  const readme = new TextEncoder().encode('Homebrew test cartridge\n');
  return makeZip([
    { name: 'README.txt', data: readme },
    { name: 'Spritespeak Test (World).gba', data: gba, method: 8, compressed: await deflateRaw(gba) }
  ]);
}

function savesDbKeys() {
  return new Promise((resolve) => {
    const req = indexedDB.open('/data/saves');
    req.onupgradeneeded = () => { req.transaction.abort(); };
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('FILE_DATA')) { db.close(); resolve([]); return; }
      const r = db.transaction('FILE_DATA').objectStore('FILE_DATA').getAllKeys();
      r.onsuccess = () => { db.close(); resolve(r.result.map(String)); };
      r.onerror = () => { db.close(); resolve([]); };
    };
  });
}

function deleteSavesDb() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('/data/saves');
    req.onsuccess = () => resolve('deleted');
    req.onerror = () => resolve('error');
    req.onblocked = () => resolve('blocked');
  });
}

// Recreate what version 1 left behind: the library in localStorage, the
// ROM bytes in kv 'rom:<id>' and an in-game save in EmulatorJS's IDBFS
// database, named the way v1's blob-URL loading made RetroArch name it.
async function seedV1({ id, name, sramByte, core = 'Gambatte' }) {
  const bytes = makeSramCounterGbRom();
  localStorage.setItem('emulingo:roms', JSON.stringify([{ id, name, size: bytes.length, added: Date.now() }]));
  await idb.idbSet('rom:' + id, bytes.buffer);
  const stem = name.replace(/\.[^.]+$/, '');
  const sram = new Uint8Array(8192).fill(0xff);
  sram[0] = sramByte;
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('/data/saves', 21);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('FILE_DATA');
      store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('FILE_DATA', 'readwrite');
      const st = tx.objectStore('FILE_DATA');
      const ts = new Date(Date.now() - 60_000);
      st.put({ timestamp: ts, mode: 16877 }, '/data/saves/' + core);
      st.put({ timestamp: ts, mode: 33206, contents: sram }, `/data/saves/${core}/${stem}.srm`);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// EmulatorJS's own control bar (it fades out until the mouse moves, so
// opacity is ignored; display:none and [hidden] ancestors are not)
function visibleEjsButtons() {
  return [...document.querySelectorAll('#game .ejs_menu_bar button')]
    .filter((b) => b.checkVisibility({ visibilityProperty: true }) && !b.closest('.ejs_settings_parent, .ejs_setting_menu, [hidden]'))
    .map((b) => b.textContent.trim())
    .filter(Boolean);
}

window.t = {
  emu,
  rom,
  idb,
  events,
  screenCounter,
  canvasReadback,
  gbaZip,
  savesDbKeys,
  deleteSavesDb,
  visibleEjsButtons,
  seedV1,
  crc32,
  sramRomFile: () => new File([makeSramCounterGbRom()], 'SRAM Counter.gb'),
  // a GBA cartridge padded with random (incompressible) data
  bigGbaFile(bytes, name) {
    const out = new Uint8Array(bytes);
    out.set(makeGbaRom());
    for (let p = 0x200; p < out.length; p += 65536) crypto.getRandomValues(out.subarray(p, Math.min(out.length, p + 65536)));
    return new File([out], name);
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
window.__ready = true;
