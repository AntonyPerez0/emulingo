import { store } from '../core/store.js';
import { load as lsLoad, save as lsSave } from '../core/localStorage.js';
import { idbGet, idbSet } from '../core/idb.js';
import * as emulator from '../core/emulator.js';
import * as ocr from '../core/ocr.js';
import { translate } from '../core/translate.js';
import * as tts from '../core/tts.js';
import * as srs from '../core/srs.js';
import * as dict from '../core/dictionary.js';
import { listRoms, saveRom, deleteRom, storeRom, loadRomData, formatBytes } from '../core/rom.js';
import { toast } from './toast.js';
import { renderStatus } from './components.js';
import { lineEquals, timeAgo, escapeHtml, clamp } from '../core/utils.js';

let ocrTimer = null;
let autoSaveTimer = null;
let translating = false;
let lastStableText = '';
let stableCount = 0;
let history = [];
let zone = 'auto';
let manualRect = null;
let currentEntry = null;
let wordPopup = null;
let lastFrameSig = '';
let fpsTimes = [];

export function mountPlayView() {
  const page = document.getElementById('tab-play');
  page.innerHTML = playViewHtml();
  bindPlayEvents(page);
  renderRomLibrary(page);
  history = lsLoad('history', []);
  wordPopup = null;
  renderHistory();
  renderCurrentLine(currentEntry);
  renderStatsMini();
}

function playViewHtml() {
  return `
  <div class="play-layout" id="play-layout">
    <div class="play-main">
      <div class="drop-zone" id="drop-zone">
        <div class="drop-inner">
          <div class="drop-icon">🎮</div>
          <h2>Drop your Game Boy ROM here</h2>
          <p>or <label class="linklike">browse files<input type="file" id="rom-input" accept=".gb,.gbc,.gba,.nes,.sfc,.smc,.zip,.nds" hidden></label></p>
          <p class="muted small">Nothing is uploaded anywhere - your ROM stays in your browser (IndexedDB). Use ROMs you legally own.</p>
        </div>
      </div>
      <div class="emulator-wrap hidden" id="emulator-wrap">
        <div id="game"></div>
        <div class="emulator-toolbar">
          <button class="btn small primary" id="btn-ocr-now">Translate now</button>
          <button class="btn small" id="btn-save-state" title="Save full game state">💾 Save</button>
          <button class="btn small" id="btn-load-state" title="Load full game state">📂 Load</button>
          <button class="btn small" id="btn-restart">Restart</button>
          <button class="btn small ghost" id="btn-zone">Zone: Auto</button>
          <span class="muted small" id="ocr-fps"></span>
          <button class="btn small danger" id="btn-quit-rom">Eject ROM</button>
        </div>
        <div class="zone-editor hidden" id="zone-editor">
          <p class="small muted">Drag on the game to draw the text region, or adjust manually:</p>
          <div class="rect-inputs">
            <label>X <input type="number" id="rect-x"></label>
            <label>Y <input type="number" id="rect-y"></label>
            <label>W <input type="number" id="rect-w"></label>
            <label>H <input type="number" id="rect-h"></label>
          </div>
          <div class="rect-actions">
            <button class="btn small primary" id="rect-ok">Save</button>
            <button class="btn small" id="rect-reset">Reset</button>
          </div>
        </div>
      </div>
    </div>
    <aside class="play-side">
      <div class="live-status" id="live-status"></div>
      <div class="panel current-line" id="current-line-panel"></div>
      <div class="panel" id="stats-mini-panel"></div>
      <div class="panel">
        <h3>History</h3>
        <div id="history-list" class="history-list"></div>
      </div>
    </aside>
  </div>`;
}

function bindPlayEvents(page) {
  const drop = page.querySelector('#drop-zone');
  const input = page.querySelector('#rom-input');

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleRomFile(f);
  });
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) handleRomFile(f);
    input.value = '';
  });

  page.querySelector('#btn-ocr-now').addEventListener('click', () => captureAndTranslate(true));
  page.querySelector('#btn-save-state').addEventListener('click', saveState);
  page.querySelector('#btn-load-state').addEventListener('click', loadState);
  page.querySelector('#btn-restart').addEventListener('click', () => emulator.restartGame());
  page.querySelector('#btn-quit-rom').addEventListener('click', async () => {
    stopOcrLoop();
    await autoSaveState();
    document.body.classList.remove('playing');
    emulator.quit();
    window.location.reload();
  });
  page.querySelector('#btn-zone').addEventListener('click', () => {
    const editor = page.querySelector('#zone-editor');
    editor.classList.toggle('hidden');
    const active = !editor.classList.contains('hidden');
    zone = active ? 'manual' : 'auto';
    page.querySelector('#btn-zone').textContent = 'Zone: ' + (zone === 'manual' ? 'Manual' : 'Auto');
    if (active) { initManualRect(); bindZoneDrag(); }
  });

  const rectOk = page.querySelector('#rect-ok');
  if (rectOk) rectOk.addEventListener('click', () => {
    const canvas = emulator.getGameCanvas();
    if (!canvas) return toast('Load a game first', 'err');
    const x = clamp(parseInt(page.querySelector('#rect-x').value || 0, 10), 0, canvas.width - 4);
    const y = clamp(parseInt(page.querySelector('#rect-y').value || 0, 10), 0, canvas.height - 4);
    const w = clamp(parseInt(page.querySelector('#rect-w').value || 0, 10), 4, canvas.width - x);
    const h = clamp(parseInt(page.querySelector('#rect-h').value || 0, 10), 4, canvas.height - y);
    manualRect = { x, y, w, h };
    toast('Text region saved', 'ok');
  });
  const rectReset = page.querySelector('#rect-reset');
  if (rectReset) rectReset.addEventListener('click', () => {
    manualRect = null;
    toast('Region reset to auto', 'info');
  });
}

async function handleRomFile(file) {
  try {
    const id = 'rom-' + Date.now();
    const buf = await file.arrayBuffer();
    emulator.setRomBytes(id, new Uint8Array(buf.slice(0)));
    await storeRom(id, file);
    saveRom({ id, name: file.name, size: file.size, added: Date.now() });
    toast('Loaded ' + file.name, 'ok');
    await startRom(id);
    renderRomLibrary(document.getElementById('tab-play'));
  } catch (e) {
    toast('Failed to load ROM: ' + (e.message || e), 'err');
  }
}

async function startRom(id) {
  const page = document.getElementById('tab-play');
  page.querySelector('#drop-zone').classList.add('hidden');
  page.querySelector('#emulator-wrap').classList.remove('hidden');
  document.body.classList.add('playing');
  renderStatus('Loading emulator…');
  try {
    await emulator.loadRom(id, { core: store.get('core'), fastBoot: store.get('fastBoot') });
    renderStatus('Game running - OCR active');
    startOcrLoop();
    startAutoSave(id);
    await restoreState(id, true);
  } catch (e) {
    toast(e.message, 'err');
    renderStatus('Emulator failed');
  }
}

// ---- save states ----
async function saveState(silent) {
  const id = emulator.currentRom();
  if (!id) return;
  emulator.flushSram();
  const st = await emulator.exportState();
  if (!st) {
    if (!silent) toast('Save states not available for this core - use the emulator menu', 'err');
    return false;
  }
  try {
    await idbSet('state:' + id, st);
    if (!silent) toast('Game state saved', 'ok');
    return true;
  } catch (e) {
    if (!silent) toast('Could not store state: ' + e, 'err');
    return false;
  }
}

async function loadState(silent) {
  const id = emulator.currentRom();
  if (!id) return;
  const st = await idbGet('state:' + id);
  if (!st) {
    if (!silent) toast('No saved state for this game yet', 'err');
    return false;
  }
  const ok = await emulator.importState(st);
  if (!silent) toast(ok ? 'Game state loaded' : 'Could not load state', ok ? 'ok' : 'err');
  return ok;
}

async function autoSaveState() {
  if (!emulator.currentRom()) return;
  await saveState(true);
}

function startAutoSave(id) {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = setInterval(() => {
    if (emulator.currentRom() === id && emulator.isPlaying()) saveState(true);
  }, 60000);
}

async function restoreState(id, silentIfNone) {
  const st = await idbGet('state:' + id);
  if (!st) {
    if (!silentIfNone) toast('No saved state for this game', 'info');
    return;
  }
  // give the emulator a moment after ready
  await new Promise((r) => setTimeout(r, 600));
  const ok = await emulator.importState(st);
  if (ok) toast('Save state restored - press Restart to start fresh', 'info', 3500);
}

// ---- OCR loop ----
export function startOcrLoop() {
  stopOcrLoop();
  ocrTimer = setInterval(tickOcr, store.get('ocrInterval') || 1200);
}

export function stopOcrLoop() {
  if (ocrTimer) { clearInterval(ocrTimer); ocrTimer = null; }
}

let ticking = false;
async function tickOcr() {
  if (ticking || translating || document.hidden) return;
  if (!emulator.isPlaying()) return;
  ticking = true;
  try { await captureAndTranslate(false); } finally { ticking = false; }
}

function setStatus(msg) {
  const el = document.getElementById('live-status');
  if (el) el.textContent = msg || '';
}

export async function captureAndTranslate(force) {
  const canvas = await emulator.snapshot();
  if (!canvas) {
    if (force) setStatus('No game canvas - is the game running?');
    return;
  }
  const s = store.get('stableThreshold') || 2;

  let rect;
  if (zone === 'manual' && manualRect) rect = manualRect;
  else rect = ocr.detectTextRect(canvas);

  // frame signature to skip identical frames
  const sig = canvas.width + 'x' + canvas.height + ':' + rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h + ':' + roughSignature(canvas, rect);
  if (!force && sig === lastFrameSig) return;
  lastFrameSig = sig;

  if (force) setStatus('Reading screen…');
  let result;
  try {
    result = await ocr.ocrRegion(canvas, rect, ocrLangFor(store.get('source')), (m) => {
      if (!m || !m.status) return;
      setStatus(m.progress != null ? `${m.status} ${Math.round(m.progress * 100)}%` : m.status);
    });
  } catch (e) {
    setStatus('OCR failed: ' + (e.message || e));
    return;
  }
  updateFps();

  const text = (result.text || '').trim();
  // strip dialog-box border artifacts (runs of line characters)
  const clean = text
    .replace(/[-_=~•·─═║╔╗╚╝╠╣╦╩╬▶»]{2,}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const letters = (clean.match(/\p{L}/gu) || []).length;
  const nonSpace = clean.replace(/\s/g, '').length;
  if (letters < 3 || letters < nonSpace * 0.35) {
    if (force) setStatus('No readable text - open a dialogue box, or set Zone: Manual.');
    return;
  }
  if (result.confidence < 40) {
    if (force) setStatus(`Uncertain read (${Math.round(result.confidence)}%) - try Zone: Manual.`);
    return;
  }
  const finalText = clean;
  if (lineEquals(finalText, lastStableText)) {
    stableCount++;
  } else {
    stableCount = 1;
    lastStableText = finalText;
  }
  if (stableCount < s && !force) return;

  await processNewLine(finalText, result.confidence);
}

function roughSignature(canvas, rect) {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(rect.x, rect.y, Math.min(rect.w, canvas.width - rect.x), Math.min(rect.h, canvas.height - rect.y)).data;
    let acc = 0;
    for (let i = 0; i < d.length; i += 64) acc = (acc * 31 + d[i] + d[i + 1] + d[i + 2]) | 0;
    return (acc >>> 0).toString(36);
  } catch { return ''; }
}

function ocrLangFor(code) {
  const map = { en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', ru: 'rus', pl: 'pol', ja: 'jpn', ko: 'kor', zh: 'chi_sim', sv: 'swe', da: 'dan', no: 'nor', fi: 'fin', cs: 'ces', el: 'ell', tr: 'tur', hu: 'hun', ro: 'ron', uk: 'ukr' };
  return map[code] || 'eng';
}

export async function processNewLine(text, confidence) {
  const { source, target, autoTts, autoAdd, keepHistory } = store.all();
  translating = true;
  setStatus('Translating…');
  renderCurrentLine({ status: 'translating', original: text });
  try {
    let translation = '';
    try { translation = await translate(text, source, target); }
    catch { translation = ''; }
    const entry = {
      original: text,
      translation,
      time: Date.now(),
      conf: Math.round(confidence || 0),
      src: source, tgt: target
    };
    history.unshift(entry);
    if (history.length > (keepHistory || 200)) history.pop();
    lsSave('history', history.slice(0, keepHistory || 200));

    // dictionary: line + word seeds
    try {
      dict.addLine(text, translation, source, target);
      if (translation) dict.seedWordsFromLine(text, source, target, Math.max(3, store.get('minWordLen') || 3));
    } catch {}

    setStatus('');
    renderCurrentLine(entry);
    renderHistory();
    if (autoTts && translation) tts.speak(translation, store.get('ttsLang') === 'auto' ? target : store.get('ttsLang'), store.get('rate') || 1);
    if (autoAdd && translation) {
      const card = srs.addCard(text, source, translation);
      if (card) {
        srs.logActivity(srs.todayKey(), 1);
        toast('Flashcard added to deck', 'ok', 1600);
      }
    }
  } finally {
    translating = false;
    setStatus('');
  }
}

function updateFps() {
  const now = performance.now();
  fpsTimes.push(now);
  fpsTimes = fpsTimes.filter((t) => now - t < 10000);
  const el = document.getElementById('ocr-fps');
  if (el && fpsTimes.length > 1) {
    const span = (fpsTimes[fpsTimes.length - 1] - fpsTimes[0]) / 1000;
    el.textContent = fpsTimes.length + ' OCR / ' + span.toFixed(0) + 's';
  }
}

// ---- rendering ----
export function renderCurrentLine(entry) {
  const panel = document.getElementById('current-line-panel');
  if (!panel) return;
  if (entry) currentEntry = entry;
  if (wordPopup) wordPopup = null;
  if (!currentEntry) {
    panel.innerHTML = `<h3>Live translation</h3><p class="muted">Play the game - dialogue text will appear here automatically. Tap any word to look it up.</p>`;
    return;
  }
  const e = currentEntry;
  if (e.status === 'translating') {
    panel.innerHTML = `<h3>Live translation</h3><div class="orig">${escapeHtml(e.original)}</div><div class="spinner"></div>`;
    return;
  }
  const tgtDir = detectDir(store.get('target'));
  const origHtml = e.original.split(/\s+/).map((w) => `<span class="w" data-w="${escapeHtml(w)}">${escapeHtml(w)}</span>`).join(' ');
  panel.innerHTML = `
    <h3>Live translation</h3>
    <div class="orig">${origHtml}</div>
    <div class="trans" dir="${tgtDir}">${escapeHtml(e.translation || '(translation failed)')}</div>
    <div class="line-actions">
      ${e.translation ? `<button class="btn small" data-act="tts">🔊 Speak</button>` : ''}
      <button class="btn small primary" data-act="card">+ Flashcard</button>
      <span class="muted tiny">OCR ${e.conf}%</span>
    </div>
    <div id="word-pop"></div>`;
  panel.querySelector('[data-act="tts"]')?.addEventListener('click', () => {
    tts.speak(e.translation, store.get('ttsLang') === 'auto' ? store.get('target') : store.get('ttsLang'), store.get('rate'));
  });
  panel.querySelector('[data-act="card"]')?.addEventListener('click', () => {
    if (!e.translation) return toast('No translation to save', 'err');
    const c = srs.addCard(e.original, store.get('source'), e.translation);
    srs.logActivity(srs.todayKey(), 1);
    toast(c ? 'Flashcard added' : 'Already in your deck', c ? 'ok' : 'info', 1600);
    renderStatsMini();
  });
  panel.querySelectorAll('.w').forEach((el) => {
    el.addEventListener('click', () => lookUpWord(el.dataset.w, panel.querySelector('#word-pop')));
  });
}

export async function lookUpWord(rawWord, popEl) {
  const target = popEl || document.querySelector('#word-pop');
  if (!target) return;
  const term = rawWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!term) return;
  const src = store.get('source');
  const tgt = store.get('target');

  const existing = dict.entries().find((x) => x.kind === 'word' && x.text.toLowerCase() === term.toLowerCase() && x.lang === src);
  if (existing && existing.translation) {
    renderWordPop(target, term, existing.translation);
    return;
  }
  target.innerHTML = `<div class="word-pop"><div class="wp-term">${escapeHtml(term)}</div><div class="spinner"></div></div>`;
  try {
    const tr = await dict.lookup(term, src, tgt);
    renderWordPop(target, term, tr ? tr.translation : '');
  } catch {
    target.innerHTML = `<div class="word-pop"><div class="wp-term">${escapeHtml(term)}</div><p class="muted small">Translation failed - check your connection.</p></div>`;
  }
}

function renderWordPop(target, term, translation) {
  target.innerHTML = `
    <div class="word-pop">
      <div class="wp-term">${escapeHtml(term)}</div>
      <div class="wp-trans" dir="${detectDir(store.get('target'))}">${escapeHtml(translation || '(no translation)')}</div>
      <div class="line-actions">
        <button class="btn small" data-act="tts">🔊</button>
        <button class="btn small primary" data-act="card">+ Flashcard</button>
      </div>
    </div>`;
  target.querySelector('[data-act="tts"]').addEventListener('click', () => {
    tts.speak(translation, store.get('ttsLang') === 'auto' ? store.get('target') : store.get('ttsLang'), store.get('rate'));
  });
  target.querySelector('[data-act="card"]').addEventListener('click', () => {
    if (!translation) return toast('No translation to save', 'err');
    const c = srs.addCard(term, store.get('source'), translation);
    srs.logActivity(srs.todayKey(), 1);
    toast(c ? 'Flashcard added' : 'Already in your deck', c ? 'ok' : 'info', 1500);
    renderStatsMini();
  });
}

function detectDir(code) {
  return ['ar', 'he', 'fa', 'ur'].includes(code) ? 'rtl' : 'ltr';
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (!history.length) {
    list.innerHTML = '<p class="muted small">No lines captured yet.</p>';
    return;
  }
  list.innerHTML = history.slice(0, 30).map((h, i) => `
    <div class="history-item" data-idx="${i}">
      <div class="hi-orig">${escapeHtml(h.original)}</div>
      <div class="hi-trans" dir="${detectDir(h.tgt)}">${escapeHtml(h.translation || '')}</div>
      <div class="hi-meta tiny muted">${timeAgo(h.time)} · OCR ${h.conf}%</div>
    </div>`).join('');
  list.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => {
      const h = history[parseInt(el.dataset.idx, 10)];
      if (h) renderCurrentLine(h);
    });
  });
}

function renderStatsMini() {
  const panel = document.getElementById('stats-mini-panel');
  if (!panel) return;
  const due = srs.dueCount();
  const total = srs.totalCards();
  const streak = srs.streak();
  const dictStats = dict.stats();
  panel.innerHTML = `
    <div class="stat-row"><span class="stat-num">${due}</span><span class="stat-label">due now</span></div>
    <div class="stat-row"><span class="stat-num">${total}</span><span class="stat-label">cards</span></div>
    <div class="stat-row"><span class="stat-num">${dictStats.total}</span><span class="stat-label">dictionary entries</span></div>
    <div class="stat-row"><span class="stat-num">${streak}🔥</span><span class="stat-label">day streak</span></div>`;
}

// ---- ROM library ----
function renderRomLibrary(page) {
  const drop = page.querySelector('#drop-zone');
  if (!drop) return;
  const roms = listRoms();
  const existing = page.querySelector('.rom-library');
  if (existing) existing.remove();
  if (!roms.length) return;
  const lib = document.createElement('div');
  lib.className = 'rom-library';
  lib.innerHTML = `<h3>Your ROMs</h3><div class="rom-list"></div>`;
  const listEl = lib.querySelector('.rom-list');
  for (const r of roms) {
    const row = document.createElement('div');
    row.className = 'rom-row';
    row.innerHTML = `
      <span class="rom-name">🎮 ${escapeHtml(r.name)}</span>
      <span class="muted tiny">${formatBytes(r.size)}</span>
      <span class="rom-actions">
        <button class="btn small" data-play="${r.id}">Play</button>
        <button class="btn small danger ghost" data-del="${r.id}">✕</button>
      </span>`;
    row.querySelector(`[data-play="${r.id}"]`).addEventListener('click', async () => {
      const data = await loadRomData(r.id);
      if (!data) return toast('ROM data missing - re-import the file', 'err');
      emulator.setRomBytes(r.id, new Uint8Array(data));
      await startRom(r.id);
    });
    row.querySelector(`[data-del="${r.id}"]`).addEventListener('click', async () => {
      await deleteRom(r.id);
      renderRomLibrary(page);
      toast('ROM removed', 'info');
    });
    listEl.appendChild(row);
  }
  drop.parentElement.insertBefore(lib, drop);
}

// ---- zone drag-to-select ----
function initManualRect() {
  const canvas = emulator.getGameCanvas();
  if (!canvas) return;
  if (manualRect) {
    const page = document.getElementById('tab-play');
    page.querySelector('#rect-x').value = manualRect.x;
    page.querySelector('#rect-y').value = manualRect.y;
    page.querySelector('#rect-w').value = manualRect.w;
    page.querySelector('#rect-h').value = manualRect.h;
  }
}

function bindZoneDrag() {
  const canvas = emulator.getGameCanvas();
  if (!canvas || canvas.dataset.zoneBound) return;
  canvas.dataset.zoneBound = '1';
  let dragging = false, sx = 0, sy = 0;
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    dragging = true;
    sx = (e.clientX - r.left) * (canvas.width / r.width);
    sy = (e.clientY - r.top) * (canvas.height / r.height);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = canvas.getBoundingClientRect();
    const cx = (e.clientX - r.left) * (canvas.width / r.width);
    const cy = (e.clientY - r.top) * (canvas.height / r.height);
    manualRect = {
      x: Math.round(Math.min(sx, cx)), y: Math.round(Math.min(sy, cy)),
      w: Math.round(Math.abs(cx - sx)), h: Math.round(Math.abs(cy - sy))
    };
    const page = document.getElementById('tab-play');
    page.querySelector('#rect-x').value = manualRect.x;
    page.querySelector('#rect-y').value = manualRect.y;
    page.querySelector('#rect-w').value = manualRect.w;
    page.querySelector('#rect-h').value = manualRect.h;
  });
  window.addEventListener('pointerup', () => { dragging = false; });
}

// ---- global lifecycle: autosave on unload, pause OCR when the app is hidden ----
window.addEventListener('beforeunload', () => { emulator.flushSram(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    emulator.flushSram();
    stopOcrLoop();
  } else if (emulator.currentRom()) {
    startOcrLoop();
  }
});

// The fixed game+translation layout only applies while the Play tab is active with a game running.
window.addEventListener('tabchange', (e) => {
  if (e.detail.tab === 'play' && emulator.currentRom()) document.body.classList.add('playing');
  else document.body.classList.remove('playing');
});

// apply scan-interval changes immediately
store.subscribe((key) => {
  if (key === 'ocrInterval' && ocrTimer && emulator.currentRom()) startOcrLoop();
});
