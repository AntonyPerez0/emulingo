// Local neural OCR engine: PaddleOCR PP-OCRv5 latin recognition model
// (~8 MB ONNX) running on-device inside a Web Worker, so inference never
// blocks the emulator's main thread. Box detection + line splitting come
// from our own band detector; the worker only runs recognition + CTC decode.
//
// Fallback contract: every function resolves, never rejects - on any failure
// it returns null so the caller can fall back to the Tesseract pipeline.

import { repairSpacing } from './ocr.js';

const WORKER_URL = new URL('paddle-rec-worker.js?nb=' + Date.now(), document.baseURI).href;

let worker = null;
let initPromise = null;
let seq = 0;
const pending = new Map();

function ensureWorker(onStatus) {
  if (worker) return Promise.resolve();
  if (initPromise) return initPromise;
  if (onStatus) onStatus('loading local OCR model (~8 MB, once)');
  initPromise = new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(WORKER_URL); // classic worker: ORT loads via importScripts
    } catch (e) {
      reject(e);
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => fail('local OCR model init timed out'), 120000);
    const fail = (msg) => {
      clearTimeout(timer);
      pending.delete(id);
      w.terminate();
      worker = null;
      initPromise = null;
      reject(new Error(msg));
    };
    pending.set(id, { isInit: true, resolve: () => { worker = w; resolve(); }, reject: (e) => fail(e.message || 'init failed') });
    w.onmessage = (ev) => {
      if (ev.data && ev.data.debug) { if (onStatus) onStatus(ev.data.debug); return; }
      const { id: rid, ok, boxes, error } = ev.data || {};
      const p = pending.get(rid);
      if (onStatus) onStatus('ack id=' + rid + ' ok=' + ok + ' boxes=' + (boxes === undefined ? 'UNDEF' : boxes.length) + ' pending=' + (p ? 'yes' : 'NO') + (p ? ' was-init=' + (p.isInit === true) : ''));
      if (!p) return;
      pending.delete(rid);
      ok ? p.resolve(boxes) : p.reject(new Error(error || 'worker error'));
    };
    w.onerror = () => fail('worker failed to load');
    w.postMessage({ id, type: 'init' });
  });
  return initPromise;
}

function callWorker(payload, transfer, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(label + ' timed out'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    worker.postMessage({ id, type: 'predict', ...payload }, transfer || []);
  });
}

// Run neural recognition on the given box rects. Returns regions
// [{text, conf}] in reading order (same shape the Tesseract path produces),
// or null when the engine is unavailable/failed.
export async function ocrFrameNeural(canvas, rects, onStatus, dbg = null) {
  try {
    await withTimeout(ensureWorker(onStatus), 130000, 'local OCR model init');
    if (onStatus) onStatus('worker ready, reading ' + rects.length + ' boxes…');
    const bitmap = await createImageBitmap(canvas);
    const boxes = await callWorker({ bitmap, rects, detLimit: 960 }, [bitmap], 30000, 'neural OCR');
    if (dbg) dbg.boxes = boxes;
    return boxes
      .filter((b) => b.text)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))
      .slice(0, 6)
      .map((b) => ({ text: repairSpacing(b.text), conf: b.conf }));
  } catch (e) {
    if (dbg) dbg.error = (e.message || String(e)) + (e.stack ? ' || ' + e.stack.split('\n').slice(0, 4).join(' ~ ') : '');
    return null;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })
  ]).finally(() => clearTimeout(timer));
}

export function neuralEngineReady() {
  return !!worker;
}
