// Live-translation wiring for one game session: the OCR engine, frame
// source, text-box tracker and scanner are created once, and every capture
// the scanner emits is put to work exactly once (PLAY-17/18/22, DATA-02/09):
//   - history: add on 'capture', update in place on 'update' (no duplicates)
//   - each newly completed dialog sentence is translated on its own
//     (cached), recorded in the dictionary, auto-added as a flashcard
//     (autoAdd 'sentences') and announced (announceLines)
//   - menus seed the dictionary with their words
//   - auto-speak reads the game text in the game's language, only what is
//     new, never the same line twice
import { store } from '../../../core/store.js';
import { translate, detectLanguage } from '../../../core/translate.js';
import { recordCapture } from '../../../core/dictionary.js';
import * as history from '../../../core/history.js';
import * as srs from '../../../core/srs.js';
import * as tts from '../../../core/tts.js';
import * as emu from '../../../core/emulator.js';
import { langName } from '../../../core/language.js';
import { createFrameSource } from '../../../core/ocr/capture.js';
import { createContainerTracker } from '../../../core/ocr/containers.js';
import { createOcrEngine } from '../../../core/ocr/engine.js';
import { correctText, hasDictionary, warmSpeller } from '../../../core/ocr/correct.js';
import { createScanner } from '../../../core/scanner.js';
import { normalizeForCompare } from '../../../core/ocr/dialog.js';
import { announce } from '../../a11y.js';
import { createSentenceTracker, isCardWorthy, speechDelta, sameCaptureText } from './model.js';

const SPOKEN_MEMORY = 60;
const SAME_LINE_MS = 10 * 60 * 1000;

const enginePreference = (v) => (v === 'tesseract' ? 'tesseract' : 'auto');

/**
 * createOcrSession({ onStatus, onCapture, onUpdate, onCardsAdded }) →
 *   { scanner, start(), pause(reason), resume(reason), scanNow(), setZone(z),
 *     retry(capture, key), dispose() }
 * Callbacks receive scanner snapshots; onCardsAdded(totalThisSession).
 */
export function createOcrSession({ onStatus = () => {}, onCapture = () => {}, onUpdate = () => {}, onCardsAdded = () => {} } = {}) {
  let scanner = null;
  const early = [];
  const engine = createOcrEngine({
    onStatus: (s) => { if (scanner) scanner.noteEngineStatus(s); else early.push(s); }
  });
  try { engine.setPreference(enginePreference(store.get('ocrEngine'))); } catch { /* older engine */ }

  const frameSource = createFrameSource({ getCanvas: emu.getCanvas, getVideoDims: emu.getVideoDims });
  const tracker = createContainerTracker({});

  // Only for languages with a dictionary, and only while "Fix common misreads" is on.
  const correct = (text, lang) => (store.get('spellCheck') !== false && hasDictionary(lang)
    ? correctText(text, lang)
    : Promise.resolve(text));

  scanner = createScanner({
    frameSource,
    tracker,
    engine,
    correct,
    translate: (text, src, tgt) => translate(text, src, tgt),
    detectLanguage,
    getSettings: () => store.all(),
    onSettingsChange: (fn) => store.subscribe(fn)
  });
  for (const s of early) scanner.noteEngineStatus(s);

  const sentences = createSentenceTracker();
  const spoken = [];           // normalized texts spoken recently
  const spokenByCapture = new Map(); // capture id -> dialog text already spoken
  const menusRecorded = new Set();
  const historyAlias = new Map(); // capture id -> id of the history entry showing the same line
  let cardsAdded = 0;
  let lastLiveId = null;
  let lastLive = null;
  let disposed = false;

  // ---- settings that reach the engine and speller ----

  function warm(lang) {
    if (!lang || store.get('spellCheck') === false || !hasDictionary(lang)) return;
    warmSpeller(lang).catch(() => {});
  }

  const offStore = store.subscribe((key, value) => {
    if (key === 'ocrEngine') { try { engine.setPreference(enginePreference(value)); } catch { /* ignore */ } }
    // The game kept running while auto-translate was off: pages were missed,
    // so the next text starts a new line instead of continuing the old one.
    if (key === 'ocrPaused' && value === false) scanner.reset();
    if (key === 'source' || key === 'spellCheck') warm(store.get('source'));
  });

  // ---- side effects per capture ----

  function rememberSpoken(text) {
    spoken.push(normalizeForCompare(text));
    while (spoken.length > SPOKEN_MEMORY) spoken.shift();
  }

  function autoSpeak(c) {
    if (!store.get('autoTts') || !c.dialog || !c.dialog.text) return;
    const before = spokenByCapture.get(c.id) || '';
    const delta = speechDelta(before, c.dialog.text);
    spokenByCapture.set(c.id, c.dialog.text);
    if (spokenByCapture.size > 30) spokenByCapture.delete(spokenByCapture.keys().next().value);
    if (!delta) return;
    const key = normalizeForCompare(delta);
    if (!key || spoken.includes(key)) return;
    rememberSpoken(delta);
    tts.speak(delta, c.src, { queue: true });
  }

  async function handleSentence(sentence, c) {
    let translation = '';
    try {
      translation = await translate(sentence, c.src, c.tgt);
    } catch {
      translation = '';
    }
    if (disposed) return;
    recordCapture([{ text: sentence, kind: 'dialog', translation }], c.src, c.tgt);
    if (store.get('announceLines')) {
      announce(translation ? `${sentence} ${langName(c.tgt)}: ${translation}` : sentence);
    }
    // a name or a cry that comes back unchanged ("PIKACHU!") teaches nothing
    const teaches = translation && normalizeForCompare(translation) !== normalizeForCompare(sentence);
    if (store.get('autoAdd') === 'sentences' && teaches && isCardWorthy(sentence)) {
      const res = srs.addCard({ text: sentence, translation, src: c.src, tgt: c.tgt, origin: 'auto' });
      if (res.status === 'added') {
        cardsAdded++;
        onCardsAdded(cardsAdded);
        window.dispatchEvent(new Event('emulingo:cards-changed'));
      }
    }
  }

  function takeSentences(c, { final = false } = {}) {
    if (!c || !c.dialog || !c.dialog.text) return;
    for (const s of sentences.take(c.id, c.dialog.text, c.src, { final })) handleSentence(s, c);
  }

  function recordMenus(c) {
    for (const o of c.others || []) {
      if (o.kind !== 'menu' || o.status !== 'done') continue;
      const key = `${c.src}|${normalizeForCompare(o.text)}`;
      if (menusRecorded.has(key)) continue;
      menusRecorded.add(key);
      if (menusRecorded.size > 300) menusRecorded.delete(menusRecorded.values().next().value);
      recordCapture([{ text: o.text, kind: 'menu' }], c.src, c.tgt);
    }
  }

  // One history entry per line: a capture the scanner emits again for the
  // line already at the top (after a reset) updates that entry instead.
  function saveHistory(c, isNew) {
    try {
      if (isNew && !historyAlias.has(c.id)) {
        const top = history.list()[0];
        if (top && top.id !== c.id && sameCaptureText(top, c) && Math.abs(c.time - top.time) < SAME_LINE_MS) historyAlias.set(c.id, top.id);
        if (historyAlias.size > 50) historyAlias.delete(historyAlias.keys().next().value);
      }
      const id = historyAlias.get(c.id) || c.id;
      const rec = id === c.id ? c : { ...c, id };
      if (!history.update(rec)) history.add(rec);
    } catch (err) {
      console.warn('[play] history not saved', err);
    }
  }

  scanner.on('status', (s) => onStatus(s));
  scanner.on('capture', (c) => {
    // the previous line is over: a sentence it ended on without punctuation counts now
    if (lastLive && lastLive.id !== c.id) takeSentences(lastLive, { final: true });
    lastLiveId = c.id;
    lastLive = c;
    saveHistory(c, true);
    autoSpeak(c);
    takeSentences(c);
    recordMenus(c);
    onCapture(c);
  });
  scanner.on('update', (c) => {
    saveHistory(c, false);
    if (c.id === lastLiveId) {
      lastLive = c;
      autoSpeak(c);
      takeSentences(c);
    }
    recordMenus(c);
    onUpdate(c);
  });

  return {
    scanner,
    engine,
    start() {
      warm(store.get('source'));
      scanner.start();
    },
    pause: (reason) => scanner.pause(reason),
    resume: (reason) => scanner.resume(reason),
    scanNow: () => scanner.scanNow(),
    setZone: (z) => scanner.setZone(z),
    dismissHint: () => scanner.dismissHint(),
    status: () => scanner.getState().status,
    // Retry one region of the capture on screen; an older capture from
    // history is translated directly and saved back.
    async retry(capture, key, mode = 'live') {
      if (mode === 'live') return scanner.retryRegion(key, capture.id);
      const part = key === 'dialog' ? capture.dialog : (capture.others || []).find((o) => o.key === key);
      if (!part) return false;
      try {
        const out = await translate(part.text, capture.src, capture.tgt);
        const next = {
          ...capture,
          dialog: key === 'dialog' ? { ...capture.dialog, translation: out, status: 'done' } : capture.dialog,
          others: (capture.others || []).map((o) => (o.key === key ? { ...o, translation: out, status: 'done' } : o))
        };
        history.update(next);
        return next;
      } catch {
        return false;
      }
    },
    cardsAdded: () => cardsAdded,
    dispose() {
      disposed = true;
      offStore();
      try { scanner.stop(); } catch { /* already stopped */ }
      try { engine.dispose(); } catch { /* already gone */ }
    }
  };
}
