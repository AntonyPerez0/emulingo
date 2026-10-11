// Settings: localStorage 'emulingo:settings' holds only the values that differ
// from the defaults (plus settingsVersion), so changing a default later
// reaches everyone who never touched it. Every value is validated and coerced
// on load and on set: stored data can't inject markup or break the views.

import { load, save, remove } from './localStorage.js';
import { isLang } from './language.js';
import { clamp } from './utils.js';
import { reportStorageError, onLegacyMigration } from './db.js';

export const SETTINGS_VERSION = 2;
const KEY = 'settings';

export const DEFAULTS = Object.freeze({
  source: null, // game language; chosen during onboarding
  target: 'en',
  theme: 'system',
  autoTts: false,
  autoAdd: 'sentences',
  rate: 1,
  voiceByLang: Object.freeze({}),
  spellCheck: true,
  waitForTyping: true,
  readAllText: true,
  scanSpeed: 'normal',
  ocrPaused: false,
  ocrEngine: 'auto',
  shortcuts: true,
  announceLines: true,
  newPerDay: 20,
  keepHistory: 200,
  minWordLen: 3,
  core: 'auto',
  onboarded: false
});

// v1 saved its whole state on every change; values equal to these were never chosen.
const V1_DEFAULTS = {
  target: 'en', ttsLang: 'auto', rate: 1, showRtl: false, flashcardThreshold: 7, keepHistory: 200,
  ocrInterval: 1200, stableThreshold: 2, minWordLen: 2, spellCheck: true, ocrEngine: 'paddle',
  autoTts: false, autoAdd: true, scale: 2, platform: 'gb', core: 'auto', fastBoot: false, captureScale: 3
};

const toNumber = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (...values) => (v) => (values.includes(v) ? v : undefined);
const int = (min, max) => (v) => {
  const n = toNumber(v);
  return typeof n === 'number' && Number.isFinite(n) ? clamp(Math.round(n), min, max) : undefined;
};
const step = (min, max, inc) => (v) => {
  const n = toNumber(v);
  return typeof n === 'number' && Number.isFinite(n) ? clamp(Math.round(n / inc) * inc, min, max) : undefined;
};

function voiceMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  for (const [lang, uri] of Object.entries(v)) {
    if (isLang(lang) && typeof uri === 'string' && uri.length > 0 && uri.length <= 300) out[lang] = uri;
  }
  return Object.freeze(out);
}

const SCHEMA = {
  source: (v) => (v === null ? null : isLang(v) ? v : undefined),
  target: (v) => (isLang(v) ? v : undefined),
  theme: oneOf('system', 'dark', 'light'),
  autoTts: bool,
  autoAdd: oneOf('sentences', 'off'),
  rate: step(0.5, 2, 0.05),
  voiceByLang: voiceMap,
  spellCheck: bool,
  waitForTyping: bool,
  readAllText: bool,
  scanSpeed: oneOf('relaxed', 'normal', 'fast'),
  ocrPaused: bool,
  ocrEngine: oneOf('auto', 'neural', 'tesseract'),
  shortcuts: bool,
  announceLines: bool,
  newPerDay: int(0, 500),
  keepHistory: int(20, 1000),
  minWordLen: int(2, 10),
  core: (v) => (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : undefined),
  onboarded: bool
};

// Valid value for key, or undefined when the value (or key) is not acceptable.
export function coerceSetting(key, value) {
  const fn = Object.prototype.hasOwnProperty.call(SCHEMA, key) ? SCHEMA[key] : null;
  if (!fn) return undefined;
  const out = fn(value);
  return typeof out === 'number' ? Number(out.toFixed(4)) : out;
}

// Keep only known keys with valid values (unknown and dead keys are dropped).
export function sanitizeSettings(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const key of Object.keys(SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const v = coerceSetting(key, obj[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

// v1 -> v2: drop values equal to the old defaults, map renamed values.
// source is kept even at the old default 'de': it can't be told apart from a choice.
function fromV1(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'source') { out.source = v; continue; }
    if (k in V1_DEFAULTS && sameValue(v, V1_DEFAULTS[k])) continue;
    if (k === 'ocrEngine') out.ocrEngine = v === 'paddle' ? 'auto' : v;
    else if (k === 'autoAdd') out.autoAdd = v === true ? 'sentences' : v === false ? 'off' : v;
    else if (k === 'minWordLen') { if (Number(v) > 3) out.minWordLen = v; } // 1–3 did nothing in v1
    else if (k in DEFAULTS) out[k] = v;
  }
  return out;
}

// Stored settings object (any version) -> validated overrides.
export function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return sanitizeSettings(raw.settingsVersion === SETTINGS_VERSION ? raw : fromV1(raw));
}

// Phones and tablets scan more gently by default (battery, heat).
function touchDefaults() {
  try {
    return globalThis.matchMedia?.('(pointer: coarse)').matches ? { scanSpeed: 'relaxed' } : {};
  } catch { return {}; }
}

const effective = Object.freeze({ ...DEFAULTS, ...touchDefaults() });
const listeners = new Set();
let state = {};

function overridesOf(s) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!sameValue(s[key], effective[key])) out[key] = s[key];
  }
  return out;
}

function persist() {
  const res = save(KEY, { settingsVersion: SETTINGS_VERSION, ...overridesOf(state) });
  if (res !== true) reportStorageError(res, { source: 'settings' });
}

function notify(key, value) {
  for (const fn of listeners) {
    try { fn(key, value); } catch (e) { console.error(e); }
  }
}

function boot() {
  const raw = load(KEY, null);
  const overrides = migrateSettings(raw);
  state = { ...effective, ...overrides };
  remove('tts-default-migrated'); // v1 one-off marker
  if (raw != null) {
    const stored = raw && typeof raw === 'object' ? { ...raw } : {};
    delete stored.settingsVersion;
    if (raw?.settingsVersion !== SETTINGS_VERSION || !sameValue(stored, overridesOf(state))) persist();
  }
}

// Apply validated values; returns the keys that actually changed.
function apply(values, { write = true } = {}) {
  const changed = [];
  for (const [key, v] of Object.entries(values)) {
    if (sameValue(state[key], v)) continue;
    state[key] = v;
    changed.push(key);
  }
  if (changed.length && write) persist();
  for (const key of changed) notify(key, state[key]);
  return changed;
}

boot();

// Existing v1 users with cards or history skip onboarding; v1's default game
// language was German, so keep it as their choice.
onLegacyMigration(({ hadLearningData }) => {
  if (!hadLearningData || state.onboarded) return;
  apply({ source: state.source || 'de', onboarded: true });
});

// Another tab changed settings: adopt them without writing back.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'emulingo:' + KEY && e.key !== null) return;
    const next = { ...effective, ...migrateSettings(load(KEY, null)) };
    apply(next, { write: false });
  });
}

export const store = {
  get(key) {
    return state[key];
  },
  // Returns false (and changes nothing) for unknown keys or invalid values.
  set(key, value) {
    const v = coerceSetting(key, value);
    if (v === undefined) {
      console.warn('[emulingo] ignored invalid setting', key, value);
      return false;
    }
    apply({ [key]: v });
    return true;
  },
  all() {
    return { ...state };
  },
  // fn(key, value) after a setting changes (here or in another tab).
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  // Back to defaults. Keeps the language pair and onboarding unless told otherwise.
  reset({ keep = ['source', 'target', 'onboarded'] } = {}) {
    const next = { ...effective };
    for (const key of keep) if (key in state) next[key] = state[key];
    apply(next);
    persist();
  },
  defaults() {
    return { ...effective };
  },
  isDefault(key) {
    return sameValue(state[key], effective[key]);
  }
};
