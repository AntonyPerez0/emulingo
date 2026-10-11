#!/usr/bin/env node
// Capture exactness + timing on a simulated EmulatorJS canvas in headless
// Chromium: a WebGL canvas (preserveDrawingBuffer) drawing a native frame as
// a NEAREST texture into an aspect-fit viewport with transparent bars, like
// RetroArch. grab() must return the exact native pixels and stay < 2 ms.
//
//   node tests/e2e-capture/perf.mjs [--port=5441]

import { startServer, launchChromium, BLANK } from './server.mjs';

const port = +(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 5441);
const server = await startServer({ port, pages: { '/': BLANK } });
const browser = await launchChromium();
try {
  const page = await browser.newPage();
  await page.goto(server.origin + '/');
  const res = await page.evaluate(async () => {
    const { createFrameSource } = await import('/src/core/ocr/capture.js');
    const { renderScene } = await import('/bench/scenes.js');

    // 2D source: isolates the cost of our own code from the WebGL snapshot
    // (which headless SwiftShader does in software, O(canvas area))
    function make2d(cw, ch, native) {
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      const s = Math.min(cw / native.width, ch / native.height);
      const vw = Math.round(native.width * s), vh = Math.round(native.height * s);
      const vx = Math.floor((cw - vw) / 2), vy = Math.floor((ch - vh) / 2);
      return {
        canvas,
        draw(img) { ctx.clearRect(0, 0, cw, ch); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, vx, vy, vw, vh); },
        content: { x: vx, y: vy, w: vw, h: vh }
      };
    }

    function makeGl(cw, ch, native, { top = false } = {}) {
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.className = 'ejs_canvas';
      document.body.append(canvas);
      const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: true, antialias: false });
      const vs = 'attribute vec2 p; varying vec2 uv; void main(){ uv = vec2((p.x+1.)/2., (1.-p.y)/2.); gl_Position = vec4(p,0,1); }';
      const fs = 'precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }';
      const prog = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(prog, s);
      }
      gl.linkProgram(prog); gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const s = Math.min(cw / native.width, ch / native.height);
      const vw = Math.round(native.width * s), vh = Math.round(native.height * s);
      // GL y is bottom-up; 'clip' pushes the viewport 1 px above the canvas like
      // RetroArch's portrait top alignment does with a rounded height
      const vx = Math.floor((cw - vw) / 2), vy = top === 'clip' ? ch - vh + 1 : top ? ch - vh : Math.floor((ch - vh) / 2);
      return {
        canvas,
        draw(img) {
          gl.viewport(0, 0, cw, ch); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.viewport(vx, vy, vw, vh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        },
        content: { x: vx, y: top === 'clip' ? -1 : top ? 0 : Math.floor((ch - vh) / 2), w: vw, h: vh }
      };
    }

    const scenes = ['gb1-oak-hello-en', 'gb2-mart-de', 'gb1-battle-menu-en', 'gba-battle-menu-en'];
    const natives = scenes.map((id) => {
      const { canvas } = renderScene(id);
      return { id, canvas, data: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height) };
    });
    const variants = [
      { name: 'GB 1280x1152 (x8)', cw: 1280, ch: 1152, n: 0 },
      { name: 'GB 888x444 pillarbox', cw: 888, ch: 444, n: 0 },
      { name: 'GB 374x610 portrait top', cw: 374, ch: 610, n: 1, top: true },
      { name: 'GB 374x610 portrait, row -1', cw: 374, ch: 610, n: 0, top: 'clip' },
      { name: 'GB 1000x900 (x6.25)', cw: 1000, ch: 900, n: 2 },
      { name: 'GB 1122x1010 (DPR3 phone)', cw: 1122, ch: 1010, n: 1 },
      { name: 'GBA 1920x1080', cw: 1920, ch: 1080, n: 3 },
      { name: 'GBA 390x260', cw: 390, ch: 260, n: 3 },
      { name: 'GB 1280x1152 2D source', cw: 1280, ch: 1152, n: 0, twoD: true },
      { name: 'GB 888x444 2D source', cw: 888, ch: 444, n: 2, twoD: true }
    ];
    const out = [];
    for (const v of variants) {
      const nat = natives[v.n];
      const g = v.twoD ? make2d(v.cw, v.ch, nat.canvas) : makeGl(v.cw, v.ch, nat.canvas, { top: v.top });
      g.draw(nat.canvas);
      const src = createFrameSource({ getCanvas: () => g.canvas, getVideoDims: () => ({ w: nat.canvas.width, h: nat.canvas.height }) });
      const first = src.grab();
      let wrong = -1;
      if (first) {
        wrong = 0;
        const a = first.img.data, b = nat.data.data;
        for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) wrong++;
      }
      const times = [];
      for (let i = 0; i < 60; i++) {
        g.draw(nat.canvas); // new frame each time, like a running core
        await new Promise((r) => requestAnimationFrame(r));
        const t0 = performance.now();
        const f = src.grab();
        times.push(performance.now() - t0);
        if (!f) { times.push(NaN); break; }
      }
      times.sort((a, b) => a - b);
      out.push({
        variant: v.name, scene: nat.id, ok: !!first, wrongPixels: wrong,
        rect: src.contentRect, expectedRect: g.content,
        medianMs: +times[times.length >> 1].toFixed(3), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(3), maxMs: +times[times.length - 1].toFixed(3)
      });
      g.canvas.remove();
    }
    // a 0x0 canvas and a cleared (all transparent) canvas must give null
    const empty = document.createElement('canvas'); empty.width = 0; empty.height = 0;
    const cleared = document.createElement('canvas'); cleared.width = 320; cleared.height = 288;
    cleared.getContext('webgl', { preserveDrawingBuffer: true });
    const nulls = {
      zero: createFrameSource({ getCanvas: () => empty, getVideoDims: () => ({ w: 160, h: 144 }) }).grab(),
      noCanvas: createFrameSource({ getCanvas: () => null, getVideoDims: () => null }).grab(),
      cleared: createFrameSource({ getCanvas: () => cleared, getVideoDims: () => ({ w: 160, h: 144 }) }).grab(),
      throwing: createFrameSource({ getCanvas: () => { throw new Error('x'); }, getVideoDims: () => null }).grab()
    };
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return { out, nulls, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown' };
  });
  console.log('renderer:', res.renderer, '| chromium', browser.version());
  console.table(res.out.map((r) => ({ ...r, rect: r.rect && `${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h}`, expectedRect: `${r.expectedRect.x},${r.expectedRect.y} ${r.expectedRect.w}x${r.expectedRect.h}` })));
  console.log('null cases:', JSON.stringify(res.nulls));
  const bad = res.out.filter((r) => !r.ok || r.wrongPixels !== 0);
  if (bad.length || Object.values(res.nulls).some((v) => v !== null)) { console.error('FAILED'); process.exitCode = 1; }
} finally {
  await browser.close();
  await server.close();
}
