import { load, save } from './localStorage.js';

const DEFAULTS = {
  source: 'de',
  target: 'en',
  ttsLang: 'auto',
  rate: 1.0,
  showRtl: false,
  flashcardThreshold: 7,
  keepHistory: 200,
  ocrInterval: 1200,
  stableThreshold: 2,
  minWordLen: 2,
  autoTts: true,
  autoAdd: true,
  scale: 2,
  platform: 'gb',
  core: 'auto',
  fastBoot: false,
  captureScale: 3
};

// Touch devices get a gentler default OCR cadence (battery / CPU friendly).
const touchTweak = (() => {
  try { return window.matchMedia('(pointer: coarse)').matches ? { ocrInterval: 2000 } : {}; }
  catch { return {}; }
})();

const state = Object.assign({}, DEFAULTS, touchTweak, load('settings', {}));

const listeners = new Set();

export const store = {
  get(key) { return state[key]; },
  set(key, value) {
    state[key] = value;
    save('settings', state);
    listeners.forEach((fn) => fn(key, value));
  },
  all() { return { ...state }; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
};
