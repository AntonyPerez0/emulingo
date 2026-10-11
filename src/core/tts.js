// Text-to-speech with the Web Speech API. Every text is spoken in its own
// language (game text in the game language, translations in the target
// language) with the best available voice, or the one chosen in Settings
// (store voiceByLang).

import { store } from './store.js';
import { ttsAliases, isLang } from './language.js';
import { clamp } from './utils.js';

// Short, natural sample per language for the "Test voice" buttons.
const SAMPLES = {
  ar: 'مرحبًا! سعيد بلقائك.',
  cs: 'Ahoj! Rád tě poznávám.',
  da: 'Hej! Rart at møde dig.',
  de: 'Hallo! Schön, dich kennenzulernen.',
  el: 'Γεια σου! Χάρηκα πολύ.',
  en: 'Hello! Nice to meet you.',
  es: '¡Hola! Encantado de conocerte.',
  fi: 'Hei! Hauska tavata.',
  fr: 'Bonjour ! Ravi de vous rencontrer.',
  he: 'שלום! נעים להכיר.',
  hi: 'नमस्ते! आपसे मिलकर खुशी हुई।',
  hu: 'Szia! Örülök, hogy megismertelek.',
  id: 'Halo! Senang bertemu denganmu.',
  it: 'Ciao! Piacere di conoscerti.',
  ja: 'こんにちは！はじめまして。',
  ko: '안녕하세요! 만나서 반갑습니다.',
  nl: 'Hallo! Leuk je te ontmoeten.',
  no: 'Hei! Hyggelig å møte deg.',
  pl: 'Cześć! Miło cię poznać.',
  pt: 'Olá! Prazer em conhecê-lo.',
  ro: 'Salut! Mă bucur să te cunosc.',
  ru: 'Привет! Приятно познакомиться.',
  sv: 'Hej! Trevligt att träffas.',
  th: 'สวัสดี! ยินดีที่ได้รู้จัก',
  tr: 'Merhaba! Tanıştığıma memnun oldum.',
  uk: 'Привіт! Приємно познайомитися.',
  vi: 'Xin chào! Rất vui được gặp bạn.',
  zh: '你好！很高兴认识你。'
};

// Region a voice should have when the browser languages don't say otherwise.
const PREFERRED_REGION = {
  ar: 'ar-SA', de: 'de-DE', en: 'en-US', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', ja: 'ja-JP',
  ko: 'ko-KR', nl: 'nl-NL', pt: 'pt-BR', ru: 'ru-RU', sv: 'sv-SE', zh: 'zh-CN', no: 'nb-NO'
};

// macOS novelty voices: fun, but useless for learning pronunciation.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;
const ROBOTIC = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const QUALITY = /(Natural|Neural|Enhanced|Premium|Google|Siri|Online)/i;

const SPEAK_DELAY_MS = 60; // Chrome drops an utterance spoken right after cancel()

let voices = [];
let initDone = false;
let unlocked = false;
let pendingTimer = null;
const voiceListeners = new Set();
const speakingListeners = new Set();

export function supported() {
  return typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance === 'function';
}

const synth = () => globalThis.speechSynthesis;
const tagOf = (v) => String(v?.lang || '').replace(/_/g, '-').toLowerCase();

function refreshVoices() {
  if (!supported()) return;
  let list = [];
  try { list = synth().getVoices() || []; } catch { list = []; }
  const changed = list.length !== voices.length || list.some((v, i) => v !== voices[i]);
  voices = list;
  if (changed) {
    for (const fn of voiceListeners) {
      try { fn(voices); } catch (e) { console.error(e); }
    }
  }
}

// Mobile browsers only speak after a user gesture: speak a silent,
// non-empty utterance on the first click / key (pointerdown is not a
// gesture for touch in Safari and Chrome, pointerup and click are).
function installUnlock() {
  if (typeof window === 'undefined' || unlocked) return;
  const events = ['click', 'pointerup', 'keydown', 'touchend'];
  const kick = () => {
    if (unlocked) return;
    unlocked = true;
    events.forEach((t) => window.removeEventListener(t, kick, true));
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth().speak(u);
    } catch { /* not allowed yet; real speech will try again */ }
  };
  events.forEach((t) => window.addEventListener(t, kick, true));
}

export function init() {
  if (!supported()) return false;
  if (initDone) return true;
  initDone = true;
  refreshVoices();
  const s = synth();
  if (typeof s.addEventListener === 'function') s.addEventListener('voiceschanged', refreshVoices);
  else s.onvoiceschanged = refreshVoices;
  // Safari doesn't always fire voiceschanged: poll briefly while the list is empty
  for (const ms of [250, 1000, 3000]) setTimeout(() => { if (!voices.length) refreshVoices(); }, ms);
  installUnlock();
  return true;
}

// fn(voices) whenever the voice list changes. Returns unsubscribe.
export function onVoicesChanged(fn) {
  voiceListeners.add(fn);
  return () => voiceListeners.delete(fn);
}

// fn(isSpeaking) when speech starts or stops (for a "Stop speaking" control).
export function onSpeakingChange(fn) {
  speakingListeners.add(fn);
  return () => speakingListeners.delete(fn);
}

function allVoices() {
  if (!voices.length) refreshVoices();
  return voices;
}

// Voices for one of our language codes (aliases included: no -> nb/nn, he -> iw…).
export function listVoices(lang) {
  if (!supported()) return [];
  const all = allVoices();
  if (!lang) return [...all];
  const prefixes = isLang(lang) ? ttsAliases(lang) : [String(lang).toLowerCase().split(/[-_]/)[0]];
  return all.filter((v) => prefixes.includes(tagOf(v).split('-')[0]));
}

function preferredRegion(lang) {
  for (const tag of globalThis.navigator?.languages || []) {
    const t = String(tag).toLowerCase();
    if (t.includes('-') && ttsAliases(lang).includes(t.split('-')[0])) return t;
  }
  return (PREFERRED_REGION[lang] || '').toLowerCase();
}

function score(v, region) {
  let s = 0;
  if (region && tagOf(v) === region) s += 4;
  if (QUALITY.test(v.name)) s += 3;
  if (v.default) s += 1;
  if (v.localService) s += 1;
  if (NOVELTY.test(v.name)) s -= 20;
  if (ROBOTIC.test(v.name)) s -= 2;
  return s;
}

// The voice to use for a language: the user's choice if still installed,
// otherwise the best match by region, quality and availability.
export function pickVoice(lang) {
  const candidates = listVoices(lang);
  if (!candidates.length) return null;
  const chosen = store.get('voiceByLang')?.[lang];
  if (chosen) {
    const v = candidates.find((x) => x.voiceURI === chosen);
    if (v) return v;
  }
  const region = preferredRegion(lang);
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const v of candidates) {
    const s = score(v, region);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return best;
}

// Speaking state: utterances of the current generation still playing, or a
// replacement waiting out the post-cancel delay. Cancelled utterances report
// their end late; the generation check keeps them from clearing the state.
let gen = 0;
let live = 0;
let waiting = false;
let lastState = false;
let watchdog = null;
let idleChecks = 0;
// Chrome garbage-collects an utterance nothing references and then never
// fires its end event, so playing utterances are kept here until they end.
const active = new Set();

function updateSpeaking() {
  const now = live > 0 || waiting;
  if (now) startWatchdog();
  if (now === lastState) return;
  lastState = now;
  for (const fn of speakingListeners) {
    try { fn(now); } catch (e) { console.error(e); }
  }
}

// Some engines drop the end event altogether (voice errors, Safari). When the
// synthesizer has been idle for two checks in a row, speech is over.
function startWatchdog() {
  if (watchdog) return;
  idleChecks = 0;
  watchdog = setInterval(() => {
    const s = synth();
    const busy = waiting || (s && (s.speaking || s.pending));
    idleChecks = busy ? 0 : idleChecks + 1;
    if (live <= 0 && !waiting) idleChecks = 2;
    if (idleChecks < 2) return;
    clearInterval(watchdog);
    watchdog = null;
    live = 0;
    active.clear();
    updateSpeaking();
  }, 750);
}

function utter(text, lang, rate) {
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(lang);
  if (voice) u.voice = voice;
  u.lang = voice?.lang || PREFERRED_REGION[lang] || lang;
  u.rate = rate;
  u.pitch = 1;
  const myGen = gen;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    active.delete(u);
    if (myGen === gen) live = Math.max(0, live - 1);
    updateSpeaking();
  };
  u.onend = end;
  u.onerror = end;
  active.add(u);
  live++;
  updateSpeaking();
  return u;
}

// Speak text in its own language. Returns false when speech isn't possible.
// { queue: true } speaks after whatever is already playing instead of replacing it.
export function speak(text, lang, { rate, queue = false } = {}) {
  const t = String(text ?? '').trim();
  if (!supported() || !t || !lang) return false;
  init();
  const r = clamp(Number(rate ?? store.get('rate')) || 1, 0.5, 2);
  try {
    const s = synth();
    if (queue && (live > 0 || waiting)) {
      if (waiting) {
        // behind the replacement that is waiting out the cancel delay; stop() drops it
        const myGen = gen;
        setTimeout(() => { if (myGen === gen) speak(t, lang, { rate: r, queue: true }); }, SPEAK_DELAY_MS);
      } else {
        s.speak(utter(t, lang, r));
      }
      return true;
    }
    clearTimeout(pendingTimer);
    pendingTimer = null;
    gen++;
    live = 0;
    active.clear();
    if (s.speaking || s.pending) {
      s.cancel();
      waiting = true;
      updateSpeaking();
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        waiting = false;
        try { synth().speak(utter(t, lang, r)); } catch { updateSpeaking(); }
      }, SPEAK_DELAY_MS);
    } else {
      s.speak(utter(t, lang, r));
    }
    return true;
  } catch {
    waiting = false;
    updateSpeaking();
    return false;
  }
}

export function stop() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
  gen++;
  live = 0;
  waiting = false;
  active.clear();
  clearInterval(watchdog);
  watchdog = null;
  if (supported()) {
    try { synth().cancel(); } catch { /* nothing to cancel */ }
  }
  updateSpeaking();
}

export function speaking() {
  return live > 0 || waiting;
}

export function sample(lang) {
  return SAMPLES[lang] || SAMPLES.en;
}

export const SAMPLE_LANGS = Object.keys(SAMPLES);
