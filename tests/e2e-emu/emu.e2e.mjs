#!/usr/bin/env node
// Real-emulator checks for src/core/emulator.js + rom.js: EmulatorJS 4.2.3
// with the gambatte and mGBA cores, served from bench/.cache/emulatorjs
// (node bench/e2e/setup.mjs lays it out) in headless Chromium.
//
//   node tests/e2e-emu/emu.e2e.mjs [--port 5471] [--headed]
//
// Uses its own test page (tests/e2e-emu/index.html), not the app UI.
// Prints one line per check and a JSON summary; exits 1 on any failure.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createCdnRouter } from '../../bench/lib/routes.mjs';
import { setup as setupEmulatorJs, EJS_DIR } from '../../bench/e2e/setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Playwright otherwise routes 127.0.0.1 through a configured HTTP proxy
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
const argv = process.argv.slice(2);
// other harnesses share the 5400-5499 range: take the first free port
const PORTS = argv.includes('--port') ? [Number(argv[argv.indexOf('--port') + 1])] : [5471, 5472, 5473, 5474, 5475, 5476, 5477, 5478];
const HEADED = argv.includes('--headed');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm'
};

// Plain static server rooted at the repo: the modules under test are plain
// ES modules with relative imports, no bundler needed.
async function startServerOnFreePort() {
  for (const port of PORTS) {
    try { return { server: await startServer(port), port }; } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('No free port in ' + PORTS.join(', '));
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const results = [];
function check(name, ok, info = {}) {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(info)}`);
}

const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'];

async function newContext(browser, router) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await router.install(context);
  return context;
}

async function openPage(context, origin, logs) {
  const page = await context.newPage();
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') logs.push('[console.error] ' + m.text()); });
  await page.goto(origin + '/tests/e2e-emu/index.html');
  await page.waitForFunction(() => window.__ready === true);
  return page;
}

async function reload(page) {
  await page.reload();
  await page.waitForFunction(() => window.__ready === true);
}

// Boot a stored ROM on a fresh page; resolves its screen counter and SRAM[0].
function bootStored(page, id) {
  return page.evaluate(async (romId) => {
    const r = await t.rom.getRom(romId);
    const bytes = await t.rom.getRomBytes(romId);
    const t0 = performance.now();
    await t.emu.loadGame(r, bytes);
    const loadMs = Math.round(performance.now() - t0);
    await t.sleep(400);
    return { loadMs, screen: await t.screenCounter(), sram0: window.EJS_emulator.gameManager.getSaveFile()[0] };
  }, id);
}

async function main() {
  setupEmulatorJs();
  const { server, port } = await startServerOnFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: !HEADED, args: ARGS });
  const router = createCdnRouter({ repoRoot: ROOT, viteOrigin: origin, emulatorjsDataDir: EJS_DIR });
  const logs = [];
  const timings = {};
  try {
    const context = await newContext(browser, router);
    const page = await openPage(context, origin, logs);

    // ---------------------------------------------------------- 1. first boot
    const r1 = await page.evaluate(async () => {
      const { emu, rom } = t;
      const imp = await rom.importRomFile(t.sramRomFile());
      const progress = [];
      const t0 = performance.now();
      await emu.loadGame(imp.rom, imp.bytes, { onProgress: (p) => progress.push(p.phase + (p.progress != null ? ' ' + Math.round(p.progress * 100) + '%' : '')) });
      const resolvedAt = performance.now();
      const e = window.EJS_emulator;
      const startedAtResolve = e.started && !e.failedToStart;
      const startEvent = t.events.find((x) => x.type === 'start');
      await t.sleep(400);
      return {
        rom: imp.rom,
        persisted: imp.persisted,
        loadMs: Math.round(resolvedAt - t0),
        startedAtResolve,
        startEventBeforeResolve: !!startEvent && startEvent.at <= resolvedAt + 1,
        core: e.getCore(),
        fileName: e.fileName,
        savePath: e.gameManager.getSaveFilePath(),
        dims: emu.getVideoDims(),
        exitHandlers: (e.functions.exit || []).length,
        tabindex: document.querySelector('#game').getAttribute('tabindex'),
        screen: await t.screenCounter(),
        sram0: e.gameManager.getSaveFile()[0],
        progress: [...new Set(progress)].slice(0, 12),
        visibleEjsButtons: t.visibleEjsButtons(),
        readback: t.canvasReadback(),
        globals: { volume: window.EJS_volume, color: window.EJS_color, bg: window.EJS_backgroundColor, data: window.EJS_pathtodata, gameUrlIsFile: window.EJS_gameUrl instanceof File }
      };
    });
    const romId = r1.rom.id;
    timings.firstLoadMs = r1.loadMs;
    check('loadGame resolves on game start (not EJS_ready)', r1.startedAtResolve && r1.startEventBeforeResolve, { loadMs: r1.loadMs, progress: r1.progress });
    check('gambatte core runs the .gb ROM', r1.core === 'gambatte' && r1.dims && r1.dims.w === 160 && r1.dims.h === 144, { core: r1.core, dims: r1.dims });
    check('File gameUrl keeps the extension and a unique save name', r1.fileName === r1.rom.fileName && /\.gb$/.test(r1.fileName) &&
      r1.savePath.endsWith('/' + r1.rom.gameName + '.srm'), { fileName: r1.fileName, savePath: r1.savePath });
    check('EmulatorJS exit handler removed after start', r1.exitHandlers === 0, { exitHandlers: r1.exitHandlers });
    check('game element is keyboard reachable (tabindex 0)', r1.tabindex === '0', { tabindex: r1.tabindex });
    check('EJS toolbar trimmed (no exit/save/load/restart/pause)', !r1.visibleEjsButtons.some((b) => /exit|save|load|restart|pause|cache|netplay/i.test(b)), { visible: r1.visibleEjsButtons });
    check('config: pinned data path, accent, volume, File', r1.globals.data === 'https://cdn.emulatorjs.org/4.2.3/data/' && r1.globals.color === '#22c55e' && r1.globals.gameUrlIsFile, r1.globals);
    check('scoped preserveDrawingBuffer: canvas readback has the frame', r1.readback.ok && r1.readback.attrs && r1.readback.attrs.preserveDrawingBuffer === true, r1.readback);
    check('test ROM renders its counter', r1.screen.rendered && r1.screen.w === 160 && r1.screen.n === (r1.sram0 & 31), { screen: r1.screen, sram0: r1.sram0 });

    // ---------------------------------------------------------- 2. one instance per page
    const r1b = await page.evaluate(async (id) => {
      const r = await t.rom.getRom(id);
      let code = null;
      try { await t.emu.loadGame(r, await t.rom.getRomBytes(id)); } catch (e) { code = e.code; }
      return { code, loaders: document.querySelectorAll('script[src*="loader.js"]').length, canvases: document.querySelectorAll('canvas.ejs_canvas').length };
    }, romId);
    check('second loadGame is refused (no second instance)', r1b.code === 'reload-required' && r1b.loaders === 1 && r1b.canvases === 1, r1b);

    // ---------------------------------------------------------- 3. pause / resume
    const pr = await page.evaluate(async () => {
      const gm = window.EJS_emulator.gameManager;
      const f0 = gm.getFrameNum(); await t.sleep(400); const f1 = gm.getFrameNum();
      t.emu.pause('user'); await t.sleep(100); const p0 = gm.getFrameNum(); await t.sleep(500); const p1 = gm.getFrameNum();
      const paused = t.emu.isPaused();
      t.emu.pause('view'); t.emu.resume('view');
      const stillPaused = t.emu.isPaused();
      t.emu.resume('user'); await t.sleep(400); const r1 = gm.getFrameNum();
      return { runningFrames: f1 - f0, pausedFrames: p1 - p0, paused, stillPausedAfterViewResume: stillPaused, resumedFrames: r1 - p1, playing: t.emu.isPlaying() };
    });
    check('pause stops frames; leaving/returning to the view keeps a user pause; resume runs again',
      pr.runningFrames > 5 && pr.pausedFrames === 0 && pr.paused && pr.stillPausedAfterViewResume && pr.resumedFrames > 5 && pr.playing, pr);

    // ---------------------------------------------------------- 4. SRAM flush + plain reload
    await page.waitForTimeout(11_000);
    const mirror1 = await page.evaluate(async (id) => {
      const m = await t.idb.idbGet('sram:' + id);
      return m && Object.entries(m.files).map(([p, f]) => [p, f.data[0]]);
    }, romId);
    check('battery save mirrored to sram:<id> within 10 s', !!mirror1 && mirror1[0][1] === r1.sram0, { mirror: mirror1 });
    await reload(page);
    const r2 = await bootStored(page, romId);
    check('battery save survives a plain reload', r2.sram0 === ((r1.sram0 + 1) & 0xff) && r2.screen.n === (r2.sram0 & 31), { before: r1.sram0, after: r2.sram0, screen: r2.screen.n });

    // ---------------------------------------------------------- 5. quick save / restart / quick load
    const qs = await page.evaluate(async () => {
      const saved = await t.emu.quickSave();
      const atSave = (await t.screenCounter()).n;
      t.emu.restart();
      await t.sleep(600);
      const afterRestart = (await t.screenCounter()).n;
      const loaded = await t.emu.quickLoad();
      await t.sleep(600);
      const afterLoad = (await t.screenCounter()).n;
      const emptyAuto = await t.emu.autoSave(); // < 30 s of play: refused
      return { savedAt: saved.savedAt, atSave, afterRestart, loaded, afterLoad, emptyAuto };
    });
    check('restart reboots the game (counter +1)', qs.afterRestart === qs.atSave + 1, qs);
    check('quick save + quick load restore the saved moment', qs.loaded && qs.afterLoad === qs.atSave, qs);
    check('autosave refused before 30 s of play', qs.emptyAuto === false, { emptyAuto: qs.emptyAuto });

    // RetroArch reads a loaded state on its next frame: a load made while
    // paused must survive a long pause (GameManager.loadState deletes the
    // file after 5 s)
    const pq = await page.evaluate(async () => {
      const atSave = (await t.screenCounter()).n;
      t.emu.restart();
      await t.sleep(600);
      const afterRestart = (await t.screenCounter()).n;
      t.emu.pause('user');
      const loaded = await t.emu.quickLoad();
      await t.sleep(6000);
      t.emu.resume('user');
      await t.sleep(800);
      return { atSave, afterRestart, loaded, afterLoad: (await t.screenCounter()).n };
    });
    check('quick load made while paused applies after a long pause', pq.loaded && pq.afterRestart === pq.atSave + 1 && pq.afterLoad === pq.atSave, pq);

    // ---------------------------------------------------------- 6. autosave + eject
    await page.waitForTimeout(31_000);
    const auto = await page.evaluate(async () => {
      const ok = await t.emu.autoSave();
      return { ok, screen: (await t.screenCounter()).n, sram0: window.EJS_emulator.gameManager.getSaveFile()[0] };
    });
    check('autosave after 30 s of play', auto.ok, auto);
    const tEject = Date.now();
    await Promise.all([
      page.waitForEvent('load'),
      page.evaluate((id) => { t.emu.ejectAndReload(id); }, romId)
    ]);
    timings.ejectMs = Date.now() - tEject;
    await page.waitForFunction(() => window.__ready === true);

    // ---------------------------------------------------------- 7. autostart + resume
    const r3 = await page.evaluate(async () => {
      const id = t.emu.consumeAutostart();
      const has = await t.emu.hasAutoSave(id);
      const r = await t.rom.getRom(id);
      await t.emu.loadGame(r, await t.rom.getRomBytes(id));
      await t.sleep(400);
      const boot = await t.screenCounter();
      const sram0 = window.EJS_emulator.gameManager.getSaveFile()[0];
      const resumed = await t.emu.resumeAutoSave();
      await t.sleep(600);
      const after = (await t.screenCounter()).n;
      return { id, has, boot: boot.n, sram0, resumed, after, saves: (await t.rom.getRom(id)).saves };
    });
    check('eject reloads into the same game (sessionStorage autostart)', r3.id === romId, { id: r3.id, ejectMs: timings.ejectMs });
    check('battery save survives eject: three boots read n, n+1, n+2', r1.sram0 + 1 === r2.sram0 && r3.sram0 === ((auto.sram0 + 1) & 0xff) && r3.sram0 === ((r1.sram0 + 2) & 0xff),
      { boots: [r1.sram0, r2.sram0, r3.sram0] });
    check('"Resume where you left off?" restores the autosave', r3.has && r3.resumed && r3.after === auto.screen, { autosaved: auto.screen, booted: r3.boot, resumed: r3.after, saves: r3.saves });

    // ---------------------------------------------------------- 8. EmulatorJS lost its saves: mirror restores
    await page.waitForTimeout(11_000);
    const mirror2 = await page.evaluate(async (id) => {
      const m = await t.idb.idbGet('sram:' + id);
      return Object.values(m.files)[0].data[0];
    }, romId);
    await reload(page);
    const wipe = await page.evaluate(() => t.deleteSavesDb());
    const r4 = await bootStored(page, romId);
    const keysAfter = await page.evaluate(async () => { await t.emu.flushSaves(); return t.savesDbKeys(); });
    check('mirror restores battery saves EmulatorJS lost', wipe === 'deleted' && r4.sram0 === ((mirror2 + 1) & 0xff), { wipe, mirror: mirror2, booted: r4.sram0 });
    check('restored save is written back to EmulatorJS storage', keysAfter.some((k) => k.endsWith(r1.rom.gameName + '.srm')), { keys: keysAfter });

    // ---------------------------------------------------------- 9. zipped GBA picks mGBA
    await reload(page);
    const z = await page.evaluate(async () => {
      const zip = await t.gbaZip();
      const imp = await t.rom.importRomFile(new File([zip], 'Emulingo Test.zip'));
      const t0 = performance.now();
      const loading = t.emu.loadGame(imp.rom, imp.bytes);
      // the player left the Play view while the game was loading
      const pausedEarly = t.emu.pause('view');
      await loading;
      const loadMs = Math.round(performance.now() - t0);
      const gm = window.EJS_emulator.gameManager;
      await t.sleep(100);
      const f0 = gm.getFrameNum(); await t.sleep(500); const f1 = gm.getFrameNum();
      const startedPaused = { pausedEarly, isPaused: t.emu.isPaused(), frames: f1 - f0 };
      t.emu.resume('view');
      await t.sleep(100);
      const r0 = gm.getFrameNum(); await t.sleep(500); const r1 = gm.getFrameNum();
      return {
        rom: { core: imp.rom.core, ext: imp.rom.ext, source: imp.rom.source, fileName: imp.rom.fileName },
        ejsCore: window.EJS_emulator.getCore(), fileName: window.EJS_emulator.fileName, dims: t.emu.getVideoDims(), loadMs,
        startedPaused, resumedFrames: r1 - r0
      };
    });
    check('a .zip holding a .gba is unpacked and runs in mGBA', z.rom.core === 'gba' && z.rom.source === 'zip' && z.ejsCore === 'mgba' && z.dims && z.dims.w === 240 && z.dims.h === 160, z);
    check('a pause made while loading holds at start; resume runs the game', z.startedPaused.pausedEarly && z.startedPaused.isPaused &&
      z.startedPaused.frames === 0 && z.resumedFrames > 5, { startedPaused: z.startedPaused, resumedFrames: z.resumedFrames });

    // ---------------------------------------------------------- 9b. delete the GB game while the GBA one runs
    const del = await page.evaluate(async (id) => {
      const before = (await t.savesDbKeys()).filter((k) => k.endsWith('.srm'));
      const ok = await t.rom.deleteRom(id);
      // the running game syncs its save folder: the deleted save must not come back
      await t.emu.flushSaves();
      await t.sleep(300);
      const after = (await t.savesDbKeys()).filter((k) => k.endsWith('.srm'));
      const kvLeft = (await t.idb.idbKeys('')).filter((k) => String(k).includes(id));
      return { ok, before, after, kvLeft, library: (await t.rom.listRoms()).map((r) => r.name) };
    }, romId);
    const gbSave = (k) => k.endsWith('/' + r1.rom.gameName + '.srm');
    check('deleteRom removes the ROM, both slots, the mirror and EmulatorJS’s copy of its save', del.ok && del.before.some(gbSave) &&
      !del.after.some(gbSave) && del.kvLeft.length === 0 && !del.library.includes('SRAM Counter.gb'), del);
    await context.close();

    // ---------------------------------------------------------- 10. storage full
    const qctx = await newContext(browser, router);
    const qpage = await openPage(qctx, origin, logs);
    const cdp = await qctx.newCDPSession(qpage);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 400_000 });
    const q = await qpage.evaluate(async () => {
      const race = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e: e.code || e.name || String(e) })), new Promise((r) => setTimeout(() => r({ hang: true }), ms))]);
      const out = {};
      let t0 = performance.now();
      const a = await race(t.rom.importRomFile(t.bigGbaFile(2 * 1024 * 1024, 'Big One.gba')), 10_000);
      out.import1 = { ms: Math.round(performance.now() - t0), hang: !!a.hang, persisted: a.v && a.v.persisted, warnings: a.v && a.v.warnings, error: a.e };
      t0 = performance.now();
      const b = await race(t.rom.importRomFile(t.bigGbaFile(3 * 1024 * 1024, 'Big Two.gba')), 10_000);
      out.import2 = { ms: Math.round(performance.now() - t0), hang: !!b.hang, persisted: b.v && b.v.persisted, warnings: b.v && b.v.warnings, error: b.e };
      const playable = b.v || a.v;
      t0 = performance.now();
      const s = await race(t.emu.loadGame(playable.rom, playable.bytes), 60_000);
      out.play = { ms: Math.round(performance.now() - t0), started: t.emu.isStarted(), error: s.e, hang: !!s.hang };
      t0 = performance.now();
      const qsv = await race(t.emu.quickSave(), 10_000);
      out.quickSave = { ms: Math.round(performance.now() - t0), hang: !!qsv.hang, ok: !!qsv.v, error: qsv.e };
      out.library = (await t.rom.listRoms()).map((r) => r.name);
      return out;
    });
    const tq = Date.now();
    await Promise.all([qpage.waitForEvent('load'), qpage.evaluate(() => { t.emu.ejectAndReload(null); })]);
    q.ejectMs = Date.now() - tq;
    check('storage full: imports settle quickly instead of hanging', !q.import1.hang && !q.import2.hang && q.import1.ms < 10_000 && q.import2.ms < 10_000, { import1: q.import1, import2: q.import2 });
    check('storage full: a ROM that can’t be stored still plays this session', [q.import1, q.import2].some((x) => x.persisted === false && (x.warnings || []).includes('not-saved')) && q.play.started, { play: q.play, library: q.library });
    check('storage full: quick save settles and eject still reloads', !q.quickSave.hang && q.ejectMs < 8000, { quickSave: q.quickSave, ejectMs: q.ejectMs });
    await qctx.close();

    // ---------------------------------------------------------- 11. v1 library + v1 battery save
    const vctx = await newContext(browser, router);
    const vpage = await openPage(vctx, origin, logs);
    await vpage.evaluate(() => t.seedV1({ id: 'rom-1700000000000', name: 'Old Save.gb', sramByte: 0x41 }));
    await reload(vpage);
    const v1 = await vpage.evaluate(async () => {
      const list = await t.rom.listRoms();
      const r = list[0];
      await t.emu.loadGame(r, await t.rom.getRomBytes(r.id));
      await t.sleep(400);
      return {
        record: { id: r.id, v1: r.v1, gameName: r.gameName, fileName: r.fileName, saveStem: r.saveStem, core: r.core },
        lsLeft: localStorage.getItem('emulingo:roms'),
        savePath: window.EJS_emulator.gameManager.getSaveFilePath(),
        sram0: window.EJS_emulator.gameManager.getSaveFile()[0],
        screen: (await t.screenCounter()).n
      };
    });
    check('v1 library migrates and its existing in-game save still loads', v1.record.v1 && v1.lsLeft === null &&
      v1.savePath.endsWith('/Old Save.srm') && v1.sram0 === 0x42 && v1.screen === (0x42 & 31), v1);
    await vctx.close();

    // ---------------------------------------------------------- 12. save restored onto a renamed ROM
    // A backup from another device: same ROM (same id), imported here under
    // another file name, so the mirror's save path names the old file.
    const bctx = await newContext(browser, router);
    const bpage = await openPage(bctx, origin, logs);
    const reh = await bpage.evaluate(async () => {
      const renamed = new File([await t.sramRomFile().arrayBuffer()], 'Counter (my copy).gb');
      const imp = await t.rom.importRomFile(renamed);
      const sram = new Uint8Array(8192).fill(0xff);
      sram[0] = 0x30;
      const oldBase = '/data/saves/Gambatte/SRAM Counter-0a1b2c';
      await t.idb.idbSet('sram:' + imp.rom.id, { v: 1, t: Date.now(), files: { [oldBase + '.srm']: { data: sram, mtime: Date.now() - 60_000 } } });
      await t.emu.loadGame(imp.rom, imp.bytes);
      await t.sleep(600);
      const gm = window.EJS_emulator.gameManager;
      const out = { gameName: imp.rom.gameName, savePath: gm.getSaveFilePath(), sram0: gm.getSaveFile()[0], screen: (await t.screenCounter()).n };
      await t.emu.flushSaves();
      out.keys = (await t.savesDbKeys()).filter((k) => k.endsWith('.srm'));
      return out;
    });
    check('a mirrored save restored under another ROM file name still loads (no stray copy)', reh.sram0 === 0x31 && reh.screen === (0x31 & 31) &&
      reh.savePath.endsWith('/' + reh.gameName + '.srm') && reh.keys.length === 1 && reh.keys[0] === reh.savePath, reh);
    await bctx.close();
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
  const failed = results.filter((r) => !r.ok);
  const missing = router.stats.missing;
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, timings, cdnMissing: missing, pageErrors: logs.filter((l) => l.startsWith('[pageerror]')).slice(0, 10) }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('E2E harness error:', e);
  process.exitCode = 1;
});
