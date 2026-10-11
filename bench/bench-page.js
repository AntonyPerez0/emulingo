// Browser side of the OCR bench. Exposes window.bench for bench/run.mjs
// (Playwright) and a small interactive UI for manual inspection.
//
// Adapters live in bench/adapters/*.js (files starting with "_" are
// helpers). Each default-exports one adapter (or an array of adapters):
//
//   {
//     name: 'my-pipeline',                 // unique id used on the CLI
//     description: '...',
//     spell: false | true | async (text, ctx) => text,
//         // true: the bench also scores a '<name>+spell' flavour by running
//         // the frozen app correctOcrText over this adapter's output;
//         // a function: use it as the correction instead
//     async init(ctx) {},                  // optional; called before the first
//                                          // run and whenever ctx.lang changes
//     async read(canvas, grid, ctx) {      // required
//       return { regions: [{ text, conf }], debug: {...} };
//     }
//   }
//
// canvas = the presented snapshot (what emulator.snapshot() returns),
// grid   = exactly the object emulator.getGrid() returns for it,
// ctx    = { lang ('en'|'de'|...), ocrLang ('eng'|'deu'|...), core ('gb'|'gba'),
//            onStatus(msg) }

import { SCENES, renderScene, newCanvas } from './scenes.js';
import { VARIANTS, DEFAULT_VARIANTS, presentFrame, getVariant } from './present.js';
import { correctOcrText, warmSpeller, hasDictionary } from './legacy/correct.js';
import { ocrLangFor, withTimeout } from './adapters/_app.js';

const adapterModules = import.meta.glob(['./adapters/*.js', '!./adapters/_*.js']);

const adapters = new Map();
const adapterLoadErrors = {};

async function loadAdapters() {
  for (const [file, load] of Object.entries(adapterModules)) {
    try {
      const mod = await load();
      const list = Array.isArray(mod.default) ? mod.default : [mod.default];
      for (const a of list) {
        if (!a || typeof a.name !== 'string' || typeof a.read !== 'function') {
          throw new Error('default export must be an adapter { name, read() } or an array of them');
        }
        if (adapters.has(a.name)) throw new Error('duplicate adapter name ' + a.name);
        adapters.set(a.name, a);
      }
    } catch (e) {
      adapterLoadErrors[file] = String((e && (e.stack || e.message)) || e);
      console.error('[bench] adapter failed to load', file, e);
    }
  }
}

// --- long-task accounting ---------------------------------------------------

const longTasks = [];
let longTaskSupported = false;
try {
  if (typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes || []).includes('longtask')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration });
      if (longTasks.length > 5000) longTasks.splice(0, 2500);
    }).observe({ type: 'longtask', buffered: true });
    longTaskSupported = true;
  }
} catch { longTaskSupported = false; }

const nextTask = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// run fn as its own task(s) and report wall time + main-thread blocking
async function measure(fn) {
  await nextTask();
  const t0 = performance.now();
  let value, error = null;
  try { value = await fn(); } catch (e) { error = e; }
  const t1 = performance.now();
  await nextTask();
  await sleep(25); // let the observer deliver the last entries
  const tasks = longTasks.filter((t) => t.start < t1 && t.start + t.dur > t0);
  return {
    value,
    error,
    ms: t1 - t0,
    longTasks: tasks.length,
    maxLongTaskMs: tasks.reduce((a, t) => Math.max(a, t.dur), 0),
    totalBlockingMs: tasks.reduce((a, t) => a + Math.max(0, t.dur - 50), 0)
  };
}

const errText = (e) => (e ? String(e.stack || e.message || e).slice(0, 4000) : null);

// --- scenes ----------------------------------------------------------------

const truthCache = new Map();
function truthOf(id) {
  if (!truthCache.has(id)) truthCache.set(id, renderScene(id).truth);
  return truthCache.get(id);
}

function makeCtx(truth) {
  const statusLog = [];
  return {
    lang: truth.lang,
    ocrLang: ocrLangFor(truth.lang),
    core: truth.platform || null,
    statusLog,
    onStatus: (m) => {
      const s = typeof m === 'string' ? m : (m && m.status) || '';
      if (s && statusLog[statusLog.length - 1] !== s) statusLog.push(s);
      if (statusLog.length > 30) statusLog.shift();
    }
  };
}

function getAdapter(name) {
  const a = adapters.get(name);
  if (!a) throw new Error(`unknown adapter "${name}" (have: ${[...adapters.keys()].join(', ')})`);
  return a;
}

async function spellFix(adapter, regions, ctx) {
  const out = [];
  for (const r of regions) {
    let text = r.text;
    if (typeof adapter.spell === 'function') text = await adapter.spell(r.text, ctx);
    // exactly what playview.js does: correctOcrText bounded by 4 s
    else text = await withTimeout(correctOcrText(r.text, ctx.ocrLang, ctx.onStatus), 4000, r.text);
    out.push({ ...r, text });
  }
  return out;
}

// --- API used by run.mjs ----------------------------------------------------

async function init(name, lang, { spell = true } = {}) {
  const adapter = getAdapter(name);
  const ctx = makeCtx({ lang, platform: null }); // init is per language, not per platform
  const m = await measure(() => (adapter.init ? adapter.init(ctx) : null));
  const res = {
    adapter: name, lang, ocrLang: ctx.ocrLang,
    initMs: m.ms, maxLongTaskMs: m.maxLongTaskMs, totalBlockingMs: m.totalBlockingMs, longTasks: m.longTasks,
    note: m.value && m.value.note, status: ctx.statusLog, error: errText(m.error)
  };
  if (!m.error && spell && adapter.spell === true) {
    // the app warms the speller when a ROM starts; do the same so the 4 s
    // correction timeout measures correction, not the dictionary download
    const code = ctx.ocrLang.slice(0, 2);
    const w = await measure(() => warmSpeller(ctx.ocrLang, ctx.onStatus));
    res.spellWarmMs = w.ms;
    res.spellLongTaskMs = w.maxLongTaskMs;
    if (w.error) res.spellNote = 'speller failed: ' + errText(w.error);
    else if (!w.value) {
      res.spellNote = hasDictionary(ctx.ocrLang)
        ? `speller for "${code}" failed to load (getSpeller returned null)`
        : `no dictionary for code "${code}" (app derives it as ocrLang.slice(0,2) = "${ctx.ocrLang}".slice(0,2)) - correction is a no-op`;
    } else res.spellNote = `speller "${code}" ready`;
  }
  return res;
}

async function run(name, sceneId, variantId, { spell = true } = {}) {
  const adapter = getAdapter(name);
  const truth = truthOf(sceneId);
  const { canvas: native } = renderScene(sceneId);
  const { canvas, grid } = presentFrame(native, getVariant(variantId));
  const ctx = makeCtx(truth);
  const m = await measure(() => adapter.read(canvas, grid, ctx));
  const regions = (m.value && m.value.regions) || [];
  const res = {
    adapter: name, scene: sceneId, variant: variantId,
    regions: regions.map((r) => ({ text: String(r.text ?? ''), conf: r.conf != null ? Math.round(r.conf) : null })),
    latencyMs: m.ms, maxLongTaskMs: m.maxLongTaskMs, totalBlockingMs: m.totalBlockingMs, longTasks: m.longTasks,
    error: errText(m.error),
    debug: m.value && m.value.debug ? JSON.parse(JSON.stringify(m.value.debug)) : null
  };
  if (!m.error && spell && adapter.spell) {
    const s = await measure(() => spellFix(adapter, res.regions, ctx));
    res.spell = {
      regions: s.value || res.regions,
      ms: s.ms, maxLongTaskMs: s.maxLongTaskMs, totalBlockingMs: s.totalBlockingMs,
      error: errText(s.error)
    };
  }
  return res;
}

function frameDataUrl(sceneId, variantId = 'native', scale = 1) {
  const { canvas: native } = renderScene(sceneId);
  let src = native;
  if (variantId !== 'native') src = presentFrame(native, getVariant(variantId)).canvas;
  if (scale === 1) return src.toDataURL('image/png');
  const c = newCanvas(src.width * scale, src.height * scale);
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

// --- interactive UI -----------------------------------------------------------

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function mountUi() {
  const root = document.getElementById('app');
  if (!root) return;
  const sceneSel = el('select', { id: 'scene' });
  for (const s of SCENES) sceneSel.append(el('option', { value: s.id, text: `${s.id}${s.partial ? ' (partial)' : ''}` }));
  const variantSel = el('select', { id: 'variant' });
  for (const v of VARIANTS) variantSel.append(el('option', { value: v.id, text: `${v.id} - ${v.note}` }));
  const adapterSel = el('select', { id: 'adapter' });
  for (const a of adapters.keys()) adapterSel.append(el('option', { value: a, text: a }));
  const runBtn = el('button', { type: 'button', id: 'run' }, 'Run OCR');
  const nativeImg = el('img', { alt: 'Native frame', class: 'frame' });
  const presentedImg = el('img', { alt: 'Presented snapshot', class: 'frame presented' });
  const truthBox = el('pre', { id: 'truth', 'aria-label': 'Ground truth' });
  const outBox = el('pre', { id: 'out', 'aria-live': 'polite', 'aria-label': 'OCR output' });
  const controls = el('div', { class: 'controls' },
    el('label', { for: 'scene' }, 'Scene '), sceneSel,
    el('label', { for: 'variant' }, 'Presentation '), variantSel,
    el('label', { for: 'adapter' }, 'Adapter '), adapterSel, runBtn);
  root.append(controls,
    el('div', { class: 'frames' },
      el('figure', {}, nativeImg, el('figcaption', { text: 'native frame (3x)' })),
      el('figure', {}, presentedImg, el('figcaption', { text: 'presented snapshot' }))),
    el('h2', { text: 'Ground truth' }), truthBox,
    el('h2', { text: 'OCR output' }), outBox);
  const refresh = () => {
    nativeImg.src = frameDataUrl(sceneSel.value, 'native', 3);
    presentedImg.src = frameDataUrl(sceneSel.value, variantSel.value);
    truthBox.textContent = JSON.stringify(truthOf(sceneSel.value).regions, null, 2);
    outBox.textContent = '';
  };
  sceneSel.addEventListener('change', refresh);
  variantSel.addEventListener('change', refresh);
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    outBox.textContent = 'initialising ' + adapterSel.value + '…';
    try {
      const t = truthOf(sceneSel.value);
      const i = await init(adapterSel.value, t.lang);
      if (i.error) { outBox.textContent = 'init failed:\n' + i.error; return; }
      outBox.textContent = 'reading…';
      const r = await run(adapterSel.value, sceneSel.value, variantSel.value);
      outBox.textContent = JSON.stringify(r, null, 2);
    } catch (e) {
      outBox.textContent = errText(e);
    } finally {
      runBtn.disabled = false;
    }
  });
  refresh();
}

window.bench = {
  ready: false,
  longTaskSupported,
  scenes: () => SCENES.map((s) => truthOf(s.id)),
  variants: () => VARIANTS,
  defaultVariants: () => DEFAULT_VARIANTS,
  adapters: () => [...adapters.values()].map((a) => ({ name: a.name, description: a.description || '', spell: !!a.spell })),
  adapterLoadErrors: () => adapterLoadErrors,
  init,
  run,
  frameDataUrl
};

await loadAdapters();
window.bench.ready = true;
if (!new URLSearchParams(location.search).has('headless')) mountUi();
