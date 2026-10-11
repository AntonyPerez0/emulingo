import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createOcrEngine, routeFor, createLatch, createLatestQueue, stripLine, linesFromItems, validateJob,
  formatWait, BACKOFF_MS, MODELS, RUNTIME_SIZE
} from '../../src/core/ocr/engine.js';
import { hasWasmSimd, toPgm, createTesseract } from '../../src/core/ocr/tesseract.js';
import { extractTar, tarEntry, parseRecConfig } from '../../src/core/ocr/models.js';

// ocr.worker.js runs against a stand-in onnxruntime (sessions are scripted per test)
vi.mock('onnxruntime-web/wasm', () => {
  class Tensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  }
  return { env: { wasm: {} }, Tensor, InferenceSession: { create: vi.fn() } };
});

const img = (w = 8, h = 4) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };

// Scriptable stand-in for ocr.worker.js. `handler(msg, worker)` answers
// each request (return a reply object, or call worker.reply later).
function fakeWorkerFactory(handler) {
  const workers = [];
  const factory = () => {
    const w = {
      sent: [],
      terminated: false,
      onmessage: null,
      onerror: null,
      postMessage(msg, transfer) {
        this.sent.push({ msg, transfer });
        Promise.resolve().then(async () => {
          const reply = await handler(msg, w);
          if (reply) w.reply({ id: msg.id, ...reply });
        });
      },
      reply(data) { if (!this.terminated && this.onmessage) this.onmessage({ data }); },
      crash(message) { this.onerror && this.onerror({ message, preventDefault() {} }); },
      terminate() { this.terminated = true; }
    };
    workers.push(w);
    return w;
  };
  factory.workers = workers;
  return factory;
}

// Default worker behaviour: models load, reads succeed.
function okHandler(msg) {
  if (msg.type === 'load') return { type: 'done', result: { key: msg.key, modelName: msg.key } };
  if (msg.type === 'read' && msg.op === 'rec') return { type: 'done', result: { items: msg.images.map((_, i) => ({ text: ` line ${i} `, score: 0.9 })) } };
  if (msg.type === 'read' && msg.op === 'detrec') {
    return { type: 'done', result: { items: [{ box: { x: 40, y: 8, w: 400, h: 40 }, text: 'Hello there!', score: 0.95 }, { box: { x: 0, y: 0, w: 8, h: 8 }, text: '.', score: 0.99 }] } };
  }
  if (msg.type === 'read' && msg.op === 'det') {
    return { type: 'done', result: { items: [{ box: { x: 4, y: 4, w: 80, h: 40 }, crop: img(80, 40) }] } };
  }
  return { type: 'fail', error: { message: 'unexpected ' + msg.type } };
}

function fakeTesseract() {
  return {
    calls: [],
    lang: null,
    prepare: vi.fn(async function (lang) { this.lang = lang; }),
    recognizeLines: vi.fn(async (images, lang) => images.map(() => ({ text: `tess ${lang}`, score: 0.8 }))),
    recognizeBlock: vi.fn(async (image, lang) => [{ text: `block ${lang}`, score: 0.7, box: { x: 4, y: 4, w: 40, h: 40 } }]),
    language() { return this.lang; },
    dispose: vi.fn(async function () { this.lang = null; })
  };
}

function setup({ handler = okHandler, clock } = {}) {
  const factory = fakeWorkerFactory(handler);
  const tess = fakeTesseract();
  const statuses = [];
  let t = 1000;
  const now = clock || (() => t);
  const engine = createOcrEngine({
    onStatus: (s) => statuses.push(s),
    modelBase: 'https://example.test/app/models/',
    workerFactory: factory,
    tesseract: tess,
    now,
    timeouts: { loadIdle: 200, read: 200 }
  });
  return { engine, factory, tess, statuses, advance: (ms) => { t += ms; } };
}

const linesJob = (lang = 'de', n = 2) => ({ mode: 'lines', lang, strips: Array.from({ length: n }, (_, i) => ({ img: img(40, 14), k: 4, offset: { x: 4, y: 100 + 16 * i } })) });
const boxJob = (lang = 'de', mode = 'container') => ({ mode, lang, img: img(640, 192), k: 4, offset: { x: 0, y: 96 } });

describe('routing', () => {
  it('routes by script', () => {
    expect(routeFor('de')).toMatchObject({ kind: 'latin', rec: 'latin', tess: 'deu' });
    expect(routeFor('vi')).toMatchObject({ kind: 'latin', tess: 'vie' });
    expect(routeFor('ja')).toMatchObject({ kind: 'cjk', rec: 'cjk', tess: 'jpn' });
    expect(routeFor('zh')).toMatchObject({ kind: 'cjk', tess: 'chi_sim' });
    expect(routeFor('ko')).toMatchObject({ kind: 'tesseract', rec: null, tess: 'kor' });
    expect(routeFor('ru')).toMatchObject({ kind: 'tesseract', tess: 'rus' });
    expect(routeFor('xx')).toMatchObject({ kind: 'none' });
    expect(routeFor('qq', { ocr: 'none', script: 'latin' }).kind).toBe('none');
  });

  it('reports support per language', () => {
    const { engine } = setup();
    expect(engine.supports('fr')).toBe('neural');
    expect(engine.supports('ja')).toBe('neural');
    expect(engine.supports('ar')).toBe('tesseract');
    expect(engine.supports('xx')).toBe('none');
  });
});

describe('failure latch', () => {
  it('backs off 1 → 5 → 15 minutes and resets on success', () => {
    let t = 0;
    const latch = createLatch({ now: () => t });
    expect(latch.blocked()).toBe(false);
    latch.fail(new Error('a'));
    expect(latch.retryIn()).toBe(BACKOFF_MS[0]);
    t += BACKOFF_MS[0];
    expect(latch.blocked()).toBe(false);
    latch.fail(new Error('b'));
    expect(latch.retryIn()).toBe(5 * 60000);
    latch.fail(new Error('c'));
    latch.fail(new Error('d'));
    expect(latch.retryIn()).toBe(15 * 60000);
    expect(latch.lastError.message).toBe('d');
    latch.succeed();
    expect(latch.blocked()).toBe(false);
    expect(latch.failures).toBe(0);
  });

  it('counts failures from one attempt once', () => {
    const latch = createLatch({ now: () => 0 });
    const epoch = latch.epoch;
    expect(latch.fail(new Error('det'), epoch)).toBe(true);
    expect(latch.fail(new Error('rec'), epoch)).toBe(false);
    expect(latch.failures).toBe(1);
  });

  it('formats waits', () => {
    expect(formatWait(60000)).toBe('1 minute');
    expect(formatWait(299000)).toBe('5 minutes');
    expect(formatWait(0)).toBe('1 minute');
  });
});

describe('latest-wins queue', () => {
  it('runs one job at a time and replaces a queued job', async () => {
    const started = [];
    let release;
    const queue = createLatestQueue((job) => {
      started.push(job);
      return job === 'a' ? new Promise((r) => { release = r; }) : Promise.resolve(job.toUpperCase());
    });
    const a = queue.push('a');
    const b = queue.push('b');
    const c = queue.push('c');
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toEqual(['a']);
    release('A');
    await expect(a).resolves.toBe('A');
    await expect(c).resolves.toBe('C');
    expect(started).toEqual(['a', 'c']);
  });
});

describe('result shaping', () => {
  it('maps strips to native boxes and blanks unreadable ones', () => {
    const strip = { width: 400, height: 56, k: 4, offset: { x: 4, y: 100 } };
    expect(stripLine({ text: '  Hello   there ', score: 0.95 }, strip)).toEqual({ text: 'Hello there', score: 0.95, box: { x: 4, y: 100, w: 100, h: 14 } });
    expect(stripLine({ text: 'xx', score: 0.3 }, strip)).toMatchObject({ text: '', score: 0, raw: 'xx', rawScore: 0.3 });
    expect(stripLine(undefined, strip)).toMatchObject({ text: '', score: 0 });
  });

  it('filters and maps det items', () => {
    const items = [
      { box: { x: 40, y: 8, w: 400, h: 40 }, text: 'Hello', score: 0.9 },
      { box: { x: 40, y: 60, w: 40, h: 40 }, text: '...', score: 0.95 },
      { box: { x: 40, y: 100, w: 400, h: 40 }, text: 'faint', score: 0.55 },
      { box: { x: 40, y: 140, w: 40, h: 8 }, text: 'speck', score: 0.99 }
    ];
    const cont = linesFromItems(items, { k: 4, offset: { x: 0, y: 96 }, mode: 'container' });
    expect(cont.map((l) => l.text)).toEqual(['Hello', '...', 'faint']);
    expect(cont[0].box).toEqual({ x: 10, y: 98, w: 100, h: 10 });
    const free = linesFromItems(items, { k: 4, offset: { x: 0, y: 0 }, mode: 'free' });
    expect(free.map((l) => l.text)).toEqual(['Hello']);
  });

  it('validates jobs', () => {
    expect(validateJob(null)).toBeInstanceOf(TypeError);
    expect(validateJob({ mode: 'x' })).toBeInstanceOf(TypeError);
    // only an unknown mode is a TypeError (the scanner reads it as "no such mode")
    expect(validateJob({ mode: 'lines' })).not.toBeInstanceOf(TypeError);
    expect(validateJob({ mode: 'lines', strips: [{ img: { width: 1, height: 1, data: new Uint8ClampedArray(0) } }] })).toBeInstanceOf(Error);
    expect(validateJob({ mode: 'lines', strips: [{ img: { width: 1, height: 1, data: new Uint8ClampedArray(0) } }] })).not.toBeInstanceOf(TypeError);
    expect(validateJob({ mode: 'free', img: img() })).toBeNull();
    expect(validateJob({ mode: 'container', image: img() })).toBeNull();
    expect(validateJob(linesJob())).toBeNull();
  });
});

describe('createOcrEngine', () => {
  it('loads det + Latin rec from absolute URLs with progress and ready status', async () => {
    const handler = async (msg, w) => {
      if (msg.type === 'load') {
        w.reply({ type: 'progress', id: msg.id, key: msg.key, loaded: 1000, total: MODELS[msg.key].size });
        w.reply({ type: 'progress', id: msg.id, key: msg.key, stage: 'init' });
      }
      return okHandler(msg);
    };
    const { engine, factory, statuses } = setup({ handler });
    await engine.prepare('de');
    const loads = factory.workers[0].sent.map((s) => s.msg).filter((m) => m.type === 'load');
    expect(loads.map((m) => [m.key, m.kind, m.url])).toEqual([
      ['det', 'det', 'https://example.test/app/models/det.tar'],
      ['latin', 'rec', 'https://example.test/app/models/rec.tar']
    ]);
    expect(loads[0].size).toBe(MODELS.det.size);
    // the first download total covers both models and the 14 MB runtime
    const first = statuses.find((s) => s.phase === 'download');
    expect(first.bytes.total).toBe(MODELS.det.size + MODELS.latin.size + RUNTIME_SIZE);
    expect(statuses.some((s) => s.phase === 'download' && s.bytes && /MB/.test(s.message))).toBe(true);
    expect(statuses.some((s) => s.phase === 'init')).toBe(true);
    expect(statuses[statuses.length - 1]).toMatchObject({ phase: 'ready', progress: 1 });
    // a second prepare reuses the loaded models
    await engine.prepare('fr');
    expect(factory.workers[0].sent.filter((s) => s.msg.type === 'load')).toHaveLength(2);
  });

  it('reads line strips: rec only, buffers transferred, one Line per strip', async () => {
    const { engine, factory } = setup();
    const job = linesJob('en', 3);
    const buffers = job.strips.map((s) => s.img.data.buffer);
    const res = await engine.read(job);
    expect(res.engine).toBe('neural');
    expect(res.lines).toHaveLength(3);
    expect(res.lines[1]).toEqual({ text: 'line 1', score: 0.9, box: { x: 4, y: 116, w: 10, h: 3.5 } });
    const sent = factory.workers[0].sent.find((s) => s.msg.type === 'read');
    expect(sent.msg).toMatchObject({ op: 'rec', recKey: 'latin', params: { recAspect: 'auto' } });
    expect(sent.msg.images.map((i) => i.k)).toEqual([4, 4, 4]);
    expect(sent.transfer).toEqual(buffers);
    // lines mode never needs the detector
    expect(factory.workers[0].sent.filter((s) => s.msg.type === 'load').map((s) => s.msg.key)).toEqual(['latin']);
  });

  it('reads containers with det + rec and maps boxes to native pixels', async () => {
    const { engine, factory } = setup();
    const res = await engine.read(boxJob('en', 'free'));
    expect(res.lines).toEqual([{ text: 'Hello there!', score: 0.95, box: { x: 10, y: 98, w: 100, h: 10 } }]);
    const sent = factory.workers[0].sent.find((s) => s.msg.type === 'read');
    expect(sent.msg.op).toBe('detrec');
    expect(sent.msg.params).toMatchObject({ thresh: 0.3, boxThresh: 0.5, unclipRatio: 2, recAspect: 'auto', k: 4 });
    expect(sent.msg.params.mergeOpts).toMatchObject({ minOverlap: 0.5, maxGap: 1.5 });
  });

  it('resolves an empty strip list without loading anything', async () => {
    const { engine, factory } = setup();
    await expect(engine.read({ mode: 'lines', strips: [], lang: 'de' })).resolves.toMatchObject({ lines: [] });
    expect(factory.workers).toHaveLength(0);
  });

  it('falls back to Tesseract while a failed load is latched, then retries', async () => {
    let fail = true;
    const handler = (msg) => (msg.type === 'load' && fail ? { type: 'fail', error: { message: 'Couldn’t download the text recognition data (HTTP 404).' } } : okHandler(msg));
    const { engine, factory, tess, statuses, advance } = setup({ handler });
    await engine.prepare('de');
    expect(tess.prepare).toHaveBeenCalledWith('deu');
    const err = statuses.find((s) => s.phase === 'error');
    expect(err.message).toMatch(/HTTP 404.*Classic reader.*1 minute/);
    expect(statuses.filter((s) => s.phase === 'error')).toHaveLength(1); // det + rec failing = one failure

    const res = await engine.read(linesJob('de', 2));
    expect(res.engine).toBe('tesseract');
    expect(res.lines.map((l) => l.text)).toEqual(['tess deu', 'tess deu']);
    const block = await engine.read(boxJob('de'));
    expect(block.lines[0]).toMatchObject({ text: 'block deu', box: { x: 1, y: 97, w: 10, h: 10 } });
    expect(tess.recognizeBlock).toHaveBeenCalledWith(expect.anything(), 'deu', { sparse: false });

    // still latched: no new load attempt
    const loadsBefore = factory.workers[0].sent.filter((s) => s.msg.type === 'load').length;
    await engine.read(linesJob('de', 1));
    expect(factory.workers[0].sent.filter((s) => s.msg.type === 'load').length).toBe(loadsBefore);

    fail = false;
    advance(BACKOFF_MS[0] + 1);
    expect((await engine.read(linesJob('de', 1))).engine).toBe('neural');
  });

  it('second failure backs off for 5 minutes', async () => {
    const handler = (msg) => (msg.type === 'load' ? { type: 'fail', error: { message: 'boom' } } : okHandler(msg));
    const { engine, statuses, advance } = setup({ handler });
    await engine.prepare('en');
    advance(BACKOFF_MS[0] + 1);
    await engine.prepare('en');
    const errors = statuses.filter((s) => s.phase === 'error');
    expect(errors).toHaveLength(2);
    expect(errors[1].message).toMatch(/5 minutes/);
  });

  it('a failed read hands its pixels back and is re-read by Tesseract', async () => {
    const handler = (msg) => {
      if (msg.type === 'read') return { type: 'fail', error: { message: 'ORT run failed' }, images: msg.images };
      return okHandler(msg);
    };
    const { engine, tess, statuses } = setup({ handler });
    const res = await engine.read(linesJob('en', 2));
    expect(res.engine).toBe('tesseract');
    expect(tess.recognizeLines).toHaveBeenCalledTimes(1);
    expect(statuses.some((s) => s.phase === 'error' && /ORT run failed/.test(s.message))).toBe(true);
  });

  it('a crashed worker rejects the read, latches, and is replaced after the backoff', async () => {
    let crash = true;
    const handler = (msg, w) => {
      if (msg.type === 'read' && crash) { w.crash('out of memory'); return null; }
      return okHandler(msg);
    };
    const { engine, factory, advance } = setup({ handler });
    await expect(engine.read(linesJob('en'))).rejects.toThrow('Text recognition stopped unexpectedly (out of memory).');
    expect(factory.workers[0].terminated).toBe(true);
    expect((await engine.read(linesJob('en'))).engine).toBe('tesseract');
    crash = false;
    advance(BACKOFF_MS[0] + 1);
    expect((await engine.read(linesJob('en'))).engine).toBe('neural');
    expect(factory.workers).toHaveLength(2);
  });

  it('progress on one load keeps the other loads alive', async () => {
    const handler = async (msg, w) => {
      if (msg.type !== 'load') return okHandler(msg);
      if (msg.key === 'det') {
        // the runtime download reports on the first load only
        for (let i = 1; i <= 4; i++) {
          await new Promise((r) => setTimeout(r, 80));
          w.reply({ type: 'progress', id: msg.id, key: 'runtime', loaded: i * 1e6, total: RUNTIME_SIZE });
        }
      } else {
        await new Promise((r) => setTimeout(r, 320)); // longer than the 200 ms idle timeout
      }
      return okHandler(msg);
    };
    const { engine, statuses } = setup({ handler });
    await engine.prepare('de');
    expect(statuses.some((s) => s.phase === 'error')).toBe(false);
    expect(statuses[statuses.length - 1].phase).toBe('ready');
  });

  it('a hung worker times out', async () => {
    const handler = (msg) => (msg.type === 'read' ? null : okHandler(msg));
    const { engine, factory } = setup({ handler });
    await expect(engine.read(linesJob('en'))).rejects.toThrow(/stopped responding/);
    expect(factory.workers[0].terminated).toBe(true);
  });

  it('routes Japanese to the remote recogniser and falls back to Tesseract when it fails', async () => {
    const handler = (msg) => (msg.type === 'load' && msg.key === 'cjk' ? { type: 'fail', error: { message: 'HTTP 403' } } : okHandler(msg));
    const { engine, factory, tess, statuses } = setup({ handler });
    await engine.prepare('ja');
    const keys = factory.workers[0].sent.filter((s) => s.msg.type === 'load').map((s) => s.msg);
    expect(keys.map((m) => m.key).sort()).toEqual(['cjk', 'det']);
    expect(keys.find((m) => m.key === 'cjk').url).toBe(MODELS.cjk.url);
    expect(statuses.find((s) => s.phase === 'error').message).toBe('The Japanese and Chinese reader isn’t available. HTTP 403. Using the Classic reader for now — trying again in 1 minute.');
    expect(tess.prepare).toHaveBeenCalledWith('jpn');
    expect(engine.supports('ja')).toBe('tesseract');
    // local detection still finds the lines; Tesseract reads each one
    const res = await engine.read(boxJob('ja'));
    expect(res.engine).toBe('tesseract');
    expect(factory.workers[0].sent.some((s) => s.msg.type === 'read' && s.msg.op === 'det')).toBe(true);
    expect(tess.recognizeLines).toHaveBeenCalledWith([expect.objectContaining({ width: 80 })], 'jpn');
    expect(res.lines[0]).toMatchObject({ text: 'tess jpn', box: { x: 1, y: 97, w: 20, h: 10 } });
  });

  it('reads other scripts with local detection plus Tesseract lines', async () => {
    const { engine, tess, factory } = setup();
    await engine.prepare('ko');
    expect(tess.prepare).toHaveBeenCalledWith('kor');
    expect(factory.workers[0].sent.filter((s) => s.msg.type === 'load').map((s) => s.msg.key)).toEqual(['det']);
    const lines = await engine.read(linesJob('ko', 1));
    expect(lines).toMatchObject({ engine: 'tesseract', lines: [{ text: 'tess kor' }] });
  });

  it('honours a Tesseract-only preference', async () => {
    const { engine, factory } = setup();
    engine.setPreference('tesseract');
    expect((await engine.read(linesJob('de'))).engine).toBe('tesseract');
    expect(factory.workers).toHaveLength(0);
  });

  it('rejects unsupported languages and bad jobs', async () => {
    const { engine } = setup();
    await expect(engine.prepare('xx')).rejects.toThrow(/isn’t supported/);
    await expect(engine.read({ ...linesJob(), lang: 'xx' })).rejects.toThrow(/isn’t supported/);
    await expect(engine.read({ mode: 'free', lang: 'de' })).rejects.toThrow(/no image/);
    await expect(engine.read({ mode: 'boxes', lang: 'de' })).rejects.toBeInstanceOf(TypeError);
  });

  it('coalesces queued reads: latest wins', async () => {
    let release;
    const handler = async (msg) => {
      if (msg.type === 'read') await new Promise((r) => { release = r; });
      return okHandler(msg);
    };
    const { engine } = setup({ handler });
    const first = engine.read(linesJob('en', 1));
    await flush();
    const second = engine.read(linesJob('en', 2));
    const third = engine.read(linesJob('en', 3));
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect((await first).lines).toHaveLength(1);
    await flush();
    release();
    expect((await third).lines).toHaveLength(3);
  });

  it('dispose rejects pending work and terminates workers', async () => {
    const handler = (msg) => (msg.type === 'read' ? null : okHandler(msg));
    const { engine, factory, tess } = setup({ handler });
    const running = engine.read(linesJob('en'));
    await flush();
    const queued = engine.read(linesJob('en'));
    engine.dispose();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory.workers[0].terminated).toBe(true);
    expect(tess.dispose).toHaveBeenCalled();
    await expect(engine.read(linesJob('en'))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('survives a throwing onStatus', async () => {
    const engine = createOcrEngine({
      onStatus: () => { throw new Error('ui bug'); },
      modelBase: 'https://example.test/models/',
      workerFactory: fakeWorkerFactory(okHandler),
      tesseract: fakeTesseract()
    });
    await expect(engine.prepare('de')).resolves.toBeUndefined();
  });
});

describe('createOcrEngine: failures and shutdown', () => {
  const failingReads = (msg) => (msg.type === 'read' ? { type: 'fail', error: { message: 'ORT run failed' }, images: msg.images } : okHandler(msg));

  it('backs off further while reads keep failing', async () => {
    const { engine, statuses, advance } = setup({ handler: failingReads });
    const errors = () => statuses.filter((s) => s.phase === 'error').map((s) => s.message);
    expect((await engine.read(linesJob('en', 1))).engine).toBe('tesseract');
    expect(errors()[0]).toMatch(/1 minute/);
    advance(BACKOFF_MS[0] + 1);
    await engine.read(linesJob('en', 1));
    expect(errors()[1]).toMatch(/5 minutes/);
    advance(BACKOFF_MS[1] + 1);
    await engine.read(linesJob('en', 1));
    expect(errors()[2]).toMatch(/15 minutes/);
    expect(engine.state().latched).toMatchObject({ local: true, worker: false });
  });

  it('resets the backoff after a successful neural read', async () => {
    let fail = true;
    const handler = (msg) => (fail ? failingReads(msg) : okHandler(msg));
    const { engine, statuses, advance } = setup({ handler });
    await engine.read(linesJob('en', 1));
    fail = false;
    advance(BACKOFF_MS[0] + 1);
    expect((await engine.read(linesJob('en', 1))).engine).toBe('neural');
    fail = true;
    await engine.read(linesJob('en', 1));
    expect(statuses.filter((s) => s.phase === 'error').pop().message).toMatch(/1 minute/);
  });

  it('a crashed worker holds back Japanese reads too (the worker is shared)', async () => {
    let crash = true;
    const handler = (msg, w) => {
      if (msg.type === 'read' && crash) { w.crash('out of memory'); return null; }
      return okHandler(msg);
    };
    const { engine, factory, advance } = setup({ handler });
    await expect(engine.read(linesJob('ja', 1))).rejects.toThrow(/stopped unexpectedly/);
    expect(engine.supports('ja')).toBe('tesseract');
    expect((await engine.read(linesJob('ja', 1))).engine).toBe('tesseract');
    expect(factory.workers).toHaveLength(1); // no respawn while latched
    crash = false;
    advance(BACKOFF_MS[0] + 1);
    expect(engine.supports('ja')).toBe('neural');
    expect((await engine.read(linesJob('ja', 1))).engine).toBe('neural');
  });

  it('reads Japanese and Chinese unsqueezed', async () => {
    const { engine, factory } = setup();
    await engine.read(linesJob('ja', 1));
    await engine.read(boxJob('zh'));
    const reads = factory.workers[0].sent.filter((s) => s.msg.type === 'read').map((s) => s.msg);
    expect(reads.map((m) => [m.recKey, m.params.recAspect])).toEqual([['cjk', 1], ['cjk', 1]]);
  });

  it('runtime progress still counts after the load that started it failed', async () => {
    const handler = async (msg, w) => {
      if (msg.type !== 'load') return okHandler(msg);
      if (msg.key === 'det') {
        // the runtime keeps downloading under det's id after det failed
        setTimeout(async () => {
          for (let i = 1; i <= 4; i++) {
            await new Promise((r) => setTimeout(r, 80));
            w.reply({ type: 'progress', id: msg.id, key: 'runtime', loaded: i * 1e6, total: RUNTIME_SIZE });
          }
        });
        return { type: 'fail', error: { message: 'HTTP 404' } };
      }
      await new Promise((r) => setTimeout(r, 400)); // longer than the 200 ms idle timeout
      return okHandler(msg);
    };
    const { engine, statuses } = setup({ handler });
    await engine.prepare('de');
    expect(statuses.some((s) => /stopped responding/.test(s.message))).toBe(false);
    expect(statuses.some((s) => s.phase === 'download' && s.bytes.loaded >= 4e6)).toBe(true);
  });

  it('dispose settles a running fallback read at once and starts nothing new', async () => {
    const handler = (msg) => (msg.type === 'load' ? { type: 'fail', error: { message: 'HTTP 404' } } : okHandler(msg));
    const { engine, tess } = setup({ handler });
    tess.recognizeLines.mockImplementation(() => new Promise(() => {})); // a hung fallback
    const running = engine.read(linesJob('de', 1));
    await flush();
    expect(tess.recognizeLines).toHaveBeenCalledTimes(1);
    engine.dispose();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(tess.dispose).toHaveBeenCalled();
  });

  it('dispose during loading never starts the fallback', async () => {
    const handler = (msg) => (msg.type === 'load' ? null : okHandler(msg)); // loads hang
    const { engine, tess } = setup({ handler });
    const preparing = engine.prepare('de');
    const reading = engine.read(boxJob('de'));
    await flush();
    engine.dispose();
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(tess.prepare).not.toHaveBeenCalled();
    expect(tess.recognizeBlock).not.toHaveBeenCalled();
    expect(tess.recognizeLines).not.toHaveBeenCalled();
  });

  it('keeps the fallback for the next neural read to release, not prepare()', async () => {
    let fail = true;
    const handler = (msg) => (msg.type === 'load' && fail ? { type: 'fail', error: { message: 'HTTP 503' } } : okHandler(msg));
    const { engine, tess, advance } = setup({ handler });
    await engine.prepare('de');
    expect(tess.language()).toBe('deu');
    fail = false;
    advance(BACKOFF_MS[0] + 1);
    await engine.prepare('de');
    expect(tess.dispose).not.toHaveBeenCalled(); // a read may be using it
    expect((await engine.read(linesJob('de', 1))).engine).toBe('neural');
    expect(tess.dispose).toHaveBeenCalledTimes(1);
  });

  it('a worker that cannot be created falls back to Tesseract', async () => {
    const tess = fakeTesseract();
    const statuses = [];
    const engine = createOcrEngine({
      onStatus: (s) => statuses.push(s),
      modelBase: 'https://example.test/models/',
      workerFactory: () => { throw new Error('blocked by policy'); },
      tesseract: tess
    });
    expect((await engine.read(linesJob('en', 1))).engine).toBe('tesseract');
    expect(statuses.find((s) => s.phase === 'error').message).toMatch(/isn’t available in this browser \(blocked by policy\)/);
  });

  it('reports what the next read will use', () => {
    const { engine } = setup();
    engine.setPreference('tesseract');
    expect(engine.supports('de')).toBe('tesseract');
    expect(engine.supports('xx')).toBe('none');
    engine.setPreference('auto');
    expect(engine.supports('de')).toBe('neural');
    expect(engine.state()).toMatchObject({ preference: 'auto', latched: { worker: false, local: false, cjk: false }, tesseract: null });
  });
});

describe('tesseract helpers', () => {
  it('detects WASM SIMD', () => {
    expect(typeof hasWasmSimd()).toBe('boolean');
  });

  it('encodes a padded grayscale PGM and inverts light-on-dark text', () => {
    const dark = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) };
    const pgm = toPgm(dark, { margin: 1 });
    const header = 'P5\n4 3\n255\n';
    expect(new TextDecoder().decode(pgm.subarray(0, header.length))).toBe(header);
    const px = pgm.subarray(header.length);
    expect(px.length).toBe(12);
    expect([...px.subarray(5, 7)]).toEqual([0, 255]); // mean border 127 → not inverted
    const teal = { width: 3, height: 3, data: new Uint8ClampedArray(36) };
    for (let i = 0; i < 9; i++) teal.data.set([20, 60, 70, 255], i * 4);
    teal.data.set([250, 250, 250, 255], 4 * 4);
    const inv = toPgm(teal, { margin: 0 }).subarray('P5\n3 3\n255\n'.length);
    expect(inv[4]).toBeLessThan(10); // white text became dark
    expect(inv[0]).toBeGreaterThan(200);
  });

  it('keeps one Tesseract worker per language', async () => {
    const created = [];
    const Tesseract = {
      createWorker: vi.fn(async (lang) => {
        const w = { lang, terminate: vi.fn(async () => {}), setParameters: vi.fn(async () => {}), recognize: vi.fn(async () => ({ data: { text: ' Hallo  Welt \n', confidence: 87, blocks: [] } })) };
        created.push(w);
        return w;
      })
    };
    const statuses = [];
    const t = createTesseract({ onStatus: (s) => statuses.push(s), loadModule: async () => Tesseract });
    await t.prepare('deu');
    await t.prepare('deu');
    expect(Tesseract.createWorker).toHaveBeenCalledTimes(1);
    const [opts] = Tesseract.createWorker.mock.calls[0].slice(2);
    expect(opts).toMatchObject({ langPath: 'https://tessdata.projectnaptha.com/4.0.0_best', workerBlobURL: false });
    expect(created[0].setParameters).toHaveBeenCalledWith(expect.objectContaining({ tessedit_char_blacklist: expect.any(String) }));
    const lines = await t.recognizeLines([img(10, 10)], 'deu');
    expect(lines).toEqual([{ text: 'Hallo Welt', score: 0.87 }]);
    expect(created[0].setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: '7' });
    await t.prepare('rus');
    await flush();
    expect(created[0].terminate).toHaveBeenCalled();
    expect(t.language()).toBe('rus');
    expect(statuses.some((s) => s.phase === 'ready' && s.engine === 'tesseract')).toBe(true);
    await t.dispose();
    expect(created[1].terminate).toHaveBeenCalled();
    expect(t.language()).toBeNull();
  });

  it('reports a startup failure with its reason', async () => {
    const t = createTesseract({ loadModule: async () => ({ createWorker: async () => { throw new Error('network down'); } }) });
    await expect(t.prepare('eng')).rejects.toThrow(/Classic text reader couldn’t start \(network down\)/);
  });

  // tesseract.js stand-in whose recognitions are settled by the test
  function controllableTesseract({ start = async () => {} } = {}) {
    const created = [];
    const Tesseract = {
      createWorker: vi.fn(async (lang) => {
        await start(lang);
        const w = {
          lang,
          jobs: [],
          terminate: vi.fn(async () => {}),
          setParameters: vi.fn(async () => {}),
          recognize: vi.fn(() => new Promise((resolve, reject) => w.jobs.push({ resolve, reject }))),
          answer(text) { w.jobs.shift().resolve({ data: { text, confidence: 90, blocks: [] } }); }
        };
        created.push(w);
        return w;
      })
    };
    return { created, loadModule: async () => Tesseract };
  }

  it('switching languages lets the running read finish, then frees the old worker', async () => {
    const { created, loadModule } = controllableTesseract();
    const t = createTesseract({ loadModule });
    const reading = t.recognizeLines([img(), img()], 'kor');
    await flush();
    await t.prepare('rus');
    expect(t.language()).toBe('rus');
    created[0].answer('안녕');
    await flush();
    created[0].answer('하세요');
    expect(await reading).toEqual([{ text: '안녕', score: 0.9 }, { text: '하세요', score: 0.9 }]);
    await flush();
    expect(created[0].terminate).toHaveBeenCalled();
    expect(created[1].terminate).not.toHaveBeenCalled();
  });

  it('switching languages while the old worker is starting drops its reads', async () => {
    let unblock;
    const gate = new Promise((r) => { unblock = r; });
    const { created, loadModule } = controllableTesseract({ start: (lang) => (lang === 'kor' ? gate : undefined) });
    const t = createTesseract({ loadModule });
    const reading = t.recognizeLines([img()], 'kor');
    await flush();
    await t.prepare('rus');
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    unblock();
    await flush();
    expect(created.find((w) => w.lang === 'kor').terminate).toHaveBeenCalled();
  });

  it('dispose rejects a running read and terminates the worker', async () => {
    const { created, loadModule } = controllableTesseract();
    const t = createTesseract({ loadModule });
    const reading = t.recognizeBlock(img(), 'deu');
    await flush();
    await t.dispose();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(created[0].terminate).toHaveBeenCalled();
  });

  it('a hung recognition times out and the next read gets a fresh worker', async () => {
    const { created, loadModule } = controllableTesseract();
    // (the timeout also covers the second, answered read: keep it well above
    // a flush() on a loaded machine)
    const t = createTesseract({ loadModule, timeouts: { start: 1000, read: 250 } });
    await expect(t.recognizeLines([img()], 'deu')).rejects.toThrow(/stopped responding/);
    expect(created[0].terminate).toHaveBeenCalled();
    expect(t.language()).toBeNull();
    const next = t.recognizeLines([img()], 'deu');
    await flush();
    created[1].answer('Hallo');
    expect(await next).toEqual([{ text: 'Hallo', score: 0.9 }]);
  });

  it('gives up on a start that takes too long', async () => {
    const { loadModule } = controllableTesseract({ start: () => new Promise(() => {}) });
    const t = createTesseract({ loadModule, timeouts: { start: 30, read: 1000 } });
    await expect(t.prepare('jpn')).rejects.toThrow(/couldn’t start \(it took too long/);
    expect(t.language()).toBeNull();
  });
});

describe('ocr.worker', () => {
  const MODEL_DIR = path.resolve(__dirname, '../../public/models');
  const tarBytes = (file) => new Uint8Array(fs.readFileSync(path.join(MODEL_DIR, file)));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Loads a fresh copy of the worker module with `self`, fetch and (optionally)
  // WASM SIMD stubbed. request() resolves with the final reply for an id.
  async function startWorker({ fetchImpl = defaultFetch, simd = true } = {}) {
    vi.resetModules();
    const posted = [];
    vi.stubGlobal('self', { location: { href: 'http://localhost/app/' }, postMessage: (m, t) => posted.push({ m, t }) });
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    if (!simd) vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    await import('../../src/core/ocr/ocr.worker.js');
    const ort = await import('onnxruntime-web/wasm');
    const replies = (id) => posted.filter((p) => p.m.id === id);
    async function request(msg) {
      globalThis.self.onmessage({ data: msg });
      for (let i = 0; i < 200; i++) {
        const last = replies(msg.id).find((p) => p.m.type !== 'progress');
        if (last) return last;
        await tick();
      }
      throw new Error(`no reply to ${msg.type} ${msg.id}`);
    }
    return { ort, posted, replies, request };
  }

  function defaultFetch(url) {
    if (String(url).endsWith('.wasm')) return Promise.resolve(new Response(new Uint8Array(1000)));
    const bytes = tarBytes(String(url).endsWith('det.tar') ? 'det.tar' : 'rec.tar');
    return Promise.resolve(new Response(bytes, { headers: { 'content-length': String(bytes.length) } }));
  }

  const session = (run = async () => ({})) => ({ inputNames: ['x'], outputNames: ['y'], run: vi.fn(run) });

  it('loads a model with byte progress, fetching the runtime itself', async () => {
    const { ort, replies, request } = await startWorker();
    ort.InferenceSession.create.mockImplementation(async () => {
      expect(ort.env.wasm.wasmBinary).toHaveLength(1000); // ORT compiles the prefetched runtime
      return session();
    });
    const { m } = await request({ type: 'load', id: 1, key: 'det', kind: 'det', url: 'http://localhost/app/models/det.tar', size: MODELS.det.size });
    expect(m).toMatchObject({ type: 'done', result: { key: 'det', modelName: 'PP-OCRv5_mobile_det' } });
    const progress = replies(1).map((p) => p.m).filter((x) => x.type === 'progress');
    expect(progress.some((x) => x.key === 'det' && x.loaded === MODELS.det.size)).toBe(true);
    expect(progress.some((x) => x.key === 'runtime' && x.loaded === 1000)).toBe(true);
    expect(progress.some((x) => x.stage === 'init')).toBe(true);
    const [wasmUrl] = fetch.mock.calls.map(([u]) => String(u)).filter((u) => u.endsWith('.wasm'));
    expect(wasmUrl.startsWith('http://localhost/')).toBe(true); // same origin, never a CDN
    expect(ort.env.wasm).toMatchObject({ numThreads: 1, proxy: false, wasmBinary: undefined });
    // single-threaded WASM, optimised graph, no console noise from the optimiser
    expect(ort.InferenceSession.create).toHaveBeenCalledWith(expect.any(Uint8Array), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    // a second load reuses the session
    expect((await request({ type: 'load', id: 2, key: 'det', kind: 'det', url: 'x' })).m.result).toMatchObject({ cached: true });
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
  });

  it('recognises strips with CTC decoding and hands failed reads back', async () => {
    const dict = parseRecConfig(new TextDecoder().decode(tarEntry(extractTar(tarBytes('rec.tar')), 'inference.yml'))).charDict;
    const classes = dict.length + 1;
    const { ort, request } = await startWorker();
    ort.InferenceSession.create.mockResolvedValue(session(async (feeds) => {
      const [n] = feeds.x.dims;
      const steps = 40;
      const data = new Float32Array(n * steps * classes);
      for (let b = 0; b < n; b++) {
        for (let t = 0; t < steps; t++) data[(b * steps + t) * classes] = 1; // blank
        data[(b * steps) * classes] = 0;
        data[(b * steps) * classes + dict.indexOf('H') + 1] = 0.9;
        data[(b * steps + 2) * classes] = 0;
        data[(b * steps + 2) * classes + dict.indexOf('i') + 1] = 0.8;
      }
      return { y: { dims: [n, steps, classes], data, dispose() {} } };
    }));
    await request({ type: 'load', id: 1, key: 'latin', kind: 'rec', url: 'http://localhost/app/models/rec.tar' });
    const strip = { ...img(160, 56), k: 4 };
    const ok = await request({ type: 'read', id: 2, op: 'rec', recKey: 'latin', images: [strip, { ...img(400, 56), k: 4 }], params: { recAspect: 'auto' } });
    expect(ok.m.type).toBe('done');
    expect(ok.m.result.items.map((r) => r.text)).toEqual(['Hi', 'Hi']);
    expect(ok.m.result.items[0].score).toBeCloseTo(0.85, 5);

    const pixels = img(40, 14);
    const failed = await request({ type: 'read', id: 3, op: 'rec', recKey: 'cjk', images: [pixels], params: {} });
    expect(failed.m).toMatchObject({ type: 'fail', error: { message: expect.stringMatching(/isn’t loaded/) } });
    expect(failed.m.images[0].data).toBe(pixels.data);
    expect(failed.t).toEqual([pixels.data.buffer]); // handed back for the fallback

    const bad = await request({ type: 'read', id: 4, op: 'boxes', images: [img()] });
    expect(bad.m.error.message).toMatch(/Unknown read/);
    expect((await request({ type: 'nope', id: 5 })).m.error.message).toMatch(/Unknown request/);
  });

  it('fails fast without WASM SIMD, before downloading anything', async () => {
    const { request } = await startWorker({ simd: false });
    const { m } = await request({ type: 'load', id: 1, key: 'det', kind: 'det', url: 'http://localhost/app/models/det.tar' });
    expect(m.error.message).toMatch(/can’t run the built-in text reader/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explains failed downloads', async () => {
    const broken = () => new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(512)); },
      pull(c) { c.error(new TypeError('network error')); }
    });
    const { request } = await startWorker({
      fetchImpl: async (url) => (String(url).endsWith('.wasm') ? new Response(new Uint8Array(10)) : String(url).includes('missing')
        ? new Response('', { status: 404 })
        : new Response(broken()))
    });
    const lost = await request({ type: 'load', id: 1, key: 'det', kind: 'det', url: 'http://localhost/app/models/det.tar' });
    expect(lost.m.error.message).toBe('Couldn’t download the text recognition data (network error).');
    const missing = await request({ type: 'load', id: 2, key: 'latin', kind: 'rec', url: 'http://localhost/app/models/missing.tar' });
    expect(missing.m.error.message).toBe('Couldn’t download the text recognition data (HTTP 404).');
  });
});
