// Tesseract fallback recogniser (tesseract.js 5, lazy-loaded so it is not in
// the main bundle). Used for scripts the bundled neural model can't read
// (Korean, Cyrillic, Greek, Hebrew, Arabic, Devanagari, Thai; Japanese and
// Chinese when the remote neural model is unavailable) and for Latin
// languages while the neural engine is unavailable. Users know it as the
// “Classic” reader (Settings › Reading the screen).
//
// The worker script and the WASM core are emitted same-origin by Vite; the
// language data comes from the tessdata CDN (tessdata.projectnaptha.com,
// "4.0.0_best" float models, ~2–15 MB per language) and tesseract.js caches
// it in IndexedDB after the first download.

import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import coreSimdUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import coreUrl from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import { hasWasmSimd } from './models.js';

export { hasWasmSimd };

export const TESSDATA_URL = 'https://tessdata.projectnaptha.com/4.0.0_best';

// Border art, arrows and cursors that pixel fonts never use as text.
export const CHAR_BLACKLIST = '|_~=<>{}[]\\^`¦§©®°';

const PSM = { block: '6', line: '7', sparse: '11' };

// start: worker, core and language data (up to ~15 MB on a slow
// connection); read: one recognition (well under a second normally).
export const TIMEOUTS = Object.freeze({ start: 300000, read: 60000 });

function abortError(message) {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

function withTimeout(promise, ms, onTimeout) {
  if (!(ms > 0)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// tesseract.js needs absolute URLs (its worker resolves them elsewhere)
function abs(u) {
  try { return new URL(u, globalThis.location?.href).href; } catch { return u; }
}

// Grayscale PGM ("P5") with a white margin. Leptonica reads PNM natively,
// so no canvas or PNG encoder is needed. Light-on-dark text (GBA battle
// boxes) is inverted: Tesseract reads dark text on light paper best.
export function toPgm(img, { margin = 8 } = {}) {
  const { width: w, height: h, data } = img;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  // background = the border pixels' mean
  let sum = 0;
  let n = 0;
  for (let x = 0; x < w; x++) { sum += gray[x] + gray[(h - 1) * w + x]; n += 2; }
  for (let y = 0; y < h; y++) { sum += gray[y * w] + gray[y * w + w - 1]; n += 2; }
  const invert = n && sum / n < 110;
  const W = w + margin * 2;
  const H = h + margin * 2;
  const header = new TextEncoder().encode(`P5\n${W} ${H}\n255\n`);
  const out = new Uint8Array(header.length + W * H);
  out.set(header);
  out.fill(255, header.length);
  for (let y = 0; y < h; y++) {
    const row = header.length + (y + margin) * W + margin;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      out[row + x] = invert ? 255 - v : v;
    }
  }
  return out;
}

function linesOf(data) {
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) out.push(line);
    }
  }
  return out;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function createTesseract({ onStatus = () => {}, langPath = TESSDATA_URL, loadModule, timeouts = TIMEOUTS } = {}) {
  let current = null; // the entry (see open()) for the current language
  let progressLang = null;

  const load = loadModule || (() => import('tesseract.js/dist/tesseract.esm.min.js').then((m) => m.default || m));

  function logger(m) {
    if (!m || typeof m.progress !== 'number') return;
    if (/loading language|loading tesseract core|initializ/i.test(m.status || '')) {
      const downloading = /loading language/i.test(m.status);
      onStatus({
        phase: downloading ? 'download' : 'init',
        progress: m.progress,
        engine: 'tesseract',
        message: downloading ? 'Downloading text data for this language…' : 'Starting the Classic text reader…'
      });
    }
  }

  async function start(lang) {
    const Tesseract = await load();
    progressLang = lang;
    const worker = await Tesseract.createWorker(lang, 1 /* LSTM only */, {
      workerPath: abs(workerUrl),
      corePath: abs(hasWasmSimd() ? coreSimdUrl : coreUrl),
      langPath,
      workerBlobURL: false,
      gzip: true,
      logger,
      errorHandler: () => {}
    });
    await worker.setParameters({ tessedit_char_blacklist: CHAR_BLACKLIST });
    if (progressLang === lang) onStatus({ phase: 'ready', progress: 1, engine: 'tesseract', message: 'The Classic text reader is ready.' });
    return worker;
  }

  // One Tesseract worker per language. tesseract.js never settles the jobs
  // of a terminated or crashed worker, so every job also races `closed`
  // (rejected when the worker is retired with an error) and a timeout: a
  // hung job must not block the engine's queue for good.
  function open(lang) {
    const entry = { lang, jobs: new Set(), started: false, retired: false, ended: null, close: null };
    entry.closed = new Promise((_, reject) => { entry.close = reject; });
    entry.closed.catch(() => {});
    const starting = start(lang);
    entry.promise = withTimeout(starting, timeouts.start, () => new Error('it took too long; check your connection'))
      .then((w) => { entry.started = true; return w; }, (e) => {
        if (current === entry) current = null;
        starting.then((w) => w.terminate(), () => {}); // started after the timeout
        throw new Error(`The Classic text reader couldn’t start (${(e && e.message) || e}).`);
      });
    entry.promise.catch(() => {});
    return entry;
  }

  // Terminates an entry's worker (30–100 MB) once its running jobs are
  // done, or at once when `err` is given (the jobs reject with it). Jobs
  // still waiting for a worker that hasn't started are never waited for.
  function retire(entry, err) {
    if (entry.retired) return entry.ended;
    entry.retired = true;
    if (current === entry) current = null;
    const abort = err || (entry.started ? null : abortError('The Classic text reader switched languages.'));
    if (abort) entry.close(abort);
    const idle = abort ? Promise.resolve() : Promise.allSettled([...entry.jobs]);
    entry.ended = idle.then(() => entry.promise).then((w) => w.terminate()).catch(() => {});
    return entry.ended;
  }

  function ensure(lang) {
    if (current && current.lang === lang) return current;
    if (current) retire(current, null);
    current = open(lang);
    return current;
  }

  // fn(worker) as one job of the entry (retiring waits for it).
  function runJob(entry, fn) {
    const job = (async () => {
      const worker = await Promise.race([entry.promise, entry.closed]);
      return Promise.race([fn(worker), entry.closed]);
    })();
    entry.jobs.add(job);
    const forget = () => entry.jobs.delete(job);
    job.then(forget, forget);
    return job;
  }

  // One recognition; a hang retires the worker so the next read starts afresh.
  function recognize(entry, worker, img, psm) {
    const work = (async () => {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(toPgm(img), {}, { text: true, blocks: true, hocr: false, tsv: false });
      return data;
    })();
    return withTimeout(work, timeouts.read, () => {
      const err = new Error('The Classic text reader stopped responding.');
      retire(entry, err);
      return err;
    });
  }

  return {
    prepare: (lang) => ensure(lang).promise.then(() => {}),

    // One line per image (PSM 7, single text line), same order.
    recognizeLines(images, lang) {
      const entry = ensure(lang);
      return runJob(entry, async (worker) => {
        const out = [];
        for (const img of images) {
          const data = await recognize(entry, worker, img, PSM.line);
          out.push({ text: clean(data.text), score: Math.max(0, Math.min(1, (data.confidence || 0) / 100)) });
        }
        return out;
      });
    },

    // Tesseract's own layout on a whole crop: PSM 6 for a framed box,
    // PSM 11 (sparse text) for a free frame. Boxes are in image pixels.
    async recognizeBlock(img, lang, { sparse = false } = {}) {
      const entry = ensure(lang);
      const data = await runJob(entry, (worker) => recognize(entry, worker, img, sparse ? PSM.sparse : PSM.block));
      const margin = 8; // toPgm's padding
      return linesOf(data)
        .map((l) => ({
          text: clean(l.text),
          score: Math.max(0, Math.min(1, (l.confidence || 0) / 100)),
          box: { x: l.bbox.x0 - margin, y: l.bbox.y0 - margin, w: l.bbox.x1 - l.bbox.x0, h: l.bbox.y1 - l.bbox.y0 }
        }))
        .filter((l) => l.text);
    },

    language: () => (current ? current.lang : null),

    // Terminates the worker; a running job rejects with an AbortError.
    async dispose() {
      const old = current;
      current = null;
      progressLang = null;
      if (old) await retire(old, abortError('The Classic text reader was closed.'));
    }
  };
}
