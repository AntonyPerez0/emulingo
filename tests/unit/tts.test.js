// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LANGUAGES } from '../../src/core/language.js';

let tts;
let store;
let synth;

const voice = (name, lang, extra = {}) => ({ name, lang, voiceURI: 'uri:' + name, default: false, localService: true, ...extra });

const VOICES = [
  voice('Albert', 'en-US', { default: true }),
  voice('Samantha', 'en-US'),
  voice('Daniel', 'en-GB'),
  voice('Google UK English Female', 'en-GB', { localService: false }),
  voice('Anna', 'de-DE'),
  voice('Helena', 'de-AT'),
  voice('Nora', 'nb-NO'),
  voice('Nynorsk', 'nn_NO'),
  voice('Carmit', 'he-IL'),
  voice('Old Hebrew', 'iw-IL'),
  voice('Kyoko', 'ja-JP')
];

function fakeSynth() {
  const listeners = {};
  return {
    voices: [...VOICES],
    spoken: [],
    speaking: false,
    pending: false,
    cancelled: 0,
    getVoices() { return this.voices; },
    speak(u) { this.spoken.push(u); this.speaking = true; },
    cancel() { this.cancelled++; this.speaking = false; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    emit(type) { (listeners[type] || []).forEach((fn) => fn()); }
  };
}

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.volume = 1;
  }
}

async function load({ languages = ['en-US'] } = {}) {
  vi.resetModules();
  synth = fakeSynth();
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
  ({ store } = await import('../../src/core/store.js'));
  tts = await import('../../src/core/tts.js');
  tts.init();
}

beforeEach(async () => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await load();
});

afterEach(() => {
  tts?.stop(); // no delayed utterance may leak into the next test
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('unlock', () => {
  // first test in the file, so only this module instance listens for the gesture
  it('speaks one silent, non-empty utterance on the first click', () => {
    document.body.click();
    document.body.click();
    const silent = synth.spoken.filter((u) => u.volume === 0);
    expect(silent).toHaveLength(1);
    expect(silent[0].text).toBe(' ');
  });
});

describe('support', () => {
  it('is unsupported without the Web Speech API', async () => {
    vi.resetModules();
    vi.stubGlobal('speechSynthesis', undefined);
    const mod = await import('../../src/core/tts.js');
    expect(mod.supported()).toBe(false);
    expect(mod.init()).toBe(false);
    expect(mod.speak('Hallo', 'de')).toBe(false);
    expect(mod.listVoices('de')).toEqual([]);
    expect(mod.speaking()).toBe(false);
  });
});

describe('voices', () => {
  it('lists voices by language, including aliases and underscore tags', () => {
    expect(tts.listVoices('no').map((v) => v.name)).toEqual(['Nora', 'Nynorsk']);
    expect(tts.listVoices('he').map((v) => v.name)).toEqual(['Carmit', 'Old Hebrew']);
    expect(tts.listVoices('de')).toHaveLength(2);
    expect(tts.listVoices('ko')).toEqual([]);
    expect(tts.listVoices()).toHaveLength(VOICES.length);
  });

  it('prefers the browser’s region and quality voices, never novelty voices', async () => {
    await load({ languages: ['en-GB', 'de'] });
    expect(tts.pickVoice('en').name).toBe('Google UK English Female');
    await load({ languages: ['fr-FR'] });
    expect(tts.pickVoice('en').name).toBe('Samantha'); // en-US by default, Albert skipped
    expect(tts.pickVoice('de').name).toBe('Anna');
    expect(tts.pickVoice('no').name).toBe('Nora');
    expect(tts.pickVoice('ko')).toBe(null);
  });

  it('uses the voice chosen in Settings while it is installed', () => {
    store.set('voiceByLang', { de: 'uri:Helena' });
    expect(tts.pickVoice('de').name).toBe('Helena');
    store.set('voiceByLang', { de: 'uri:Gone' });
    expect(tts.pickVoice('de').name).toBe('Anna');
  });

  it('notifies when the voice list changes', () => {
    const fn = vi.fn();
    tts.onVoicesChanged(fn);
    synth.voices = [...VOICES, voice('Yuna', 'ko-KR')];
    synth.emit('voiceschanged');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(tts.listVoices('ko')).toHaveLength(1);
  });
});

describe('speak', () => {
  it('speaks each text in its own language at the chosen rate', () => {
    vi.useFakeTimers();
    store.set('rate', 1.2);
    expect(tts.speak('Ein wildes TAUBSI erscheint!', 'de')).toBe(true);
    const u = synth.spoken.at(-1);
    expect(u.text).toBe('Ein wildes TAUBSI erscheint!');
    expect(u.voice.name).toBe('Anna');
    expect(u.lang).toBe('de-DE');
    expect(u.rate).toBe(1.2);
    tts.speak('A wild PIDGEY appears!', 'en', { rate: 9 });
    vi.advanceTimersByTime(60);
    expect(synth.spoken.at(-1).voice.lang).toBe('en-US');
    expect(synth.spoken.at(-1).rate).toBe(2);
  });

  it('falls back to a language tag when no voice exists', () => {
    tts.speak('안녕하세요', 'ko');
    expect(synth.spoken.at(-1).voice).toBeUndefined();
    expect(synth.spoken.at(-1).lang).toBe('ko-KR');
  });

  it('refuses empty text', () => {
    expect(tts.speak('   ', 'de')).toBe(false);
    expect(tts.speak('Hallo', '')).toBe(false);
  });

  it('waits briefly after cancelling what was playing (Chrome drops it otherwise)', () => {
    vi.useFakeTimers();
    tts.speak('Eins', 'de');
    expect(synth.spoken).toHaveLength(1);
    tts.speak('Zwei', 'de');
    expect(synth.cancelled).toBe(1);
    expect(synth.spoken).toHaveLength(1);
    expect(tts.speaking()).toBe(true);
    vi.advanceTimersByTime(60);
    expect(synth.spoken.at(-1).text).toBe('Zwei');
  });

  it('can queue instead of replacing', () => {
    tts.speak('Eins', 'de');
    tts.speak('One', 'en', { queue: true });
    expect(synth.cancelled).toBe(0);
    expect(synth.spoken.map((u) => u.text)).toEqual(['Eins', 'One']);
  });
});

describe('speaking state', () => {
  it('tracks start, end and stop, ignoring late events from cancelled speech', () => {
    vi.useFakeTimers();
    const states = [];
    tts.onSpeakingChange((s) => states.push(s));
    tts.speak('Eins', 'de');
    const first = synth.spoken.at(-1);
    expect(tts.speaking()).toBe(true);
    tts.speak('Zwei', 'de');
    vi.advanceTimersByTime(60);
    first.onerror?.({ error: 'interrupted' }); // arrives after the replacement started
    expect(tts.speaking()).toBe(true);
    synth.spoken.at(-1).onend();
    expect(tts.speaking()).toBe(false);
    tts.speak('Drei', 'de');
    tts.stop();
    expect(tts.speaking()).toBe(false);
    expect(states).toEqual([true, false, true, false]);
  });
});

describe('robustness', () => {
  it('stop() also drops speech queued behind a replacement', () => {
    vi.useFakeTimers();
    tts.speak('Eins', 'de');
    tts.speak('Zwei', 'de'); // replaces: waits out the cancel delay
    tts.speak('Drei', 'de', { queue: true });
    tts.stop();
    vi.advanceTimersByTime(500);
    expect(synth.spoken.map((u) => u.text)).toEqual(['Eins']);
    expect(tts.speaking()).toBe(false);
  });

  it('queued speech still follows the replacement when nothing stops it', () => {
    vi.useFakeTimers();
    tts.speak('Eins', 'de');
    tts.speak('Zwei', 'de');
    tts.speak('Drei', 'de', { queue: true });
    vi.advanceTimersByTime(200);
    expect(synth.spoken.map((u) => u.text)).toEqual(['Eins', 'Zwei', 'Drei']);
    expect(synth.cancelled).toBe(1);
  });

  it('recovers when the engine never reports the end of speech', () => {
    vi.useFakeTimers();
    const states = [];
    tts.onSpeakingChange((s) => states.push(s));
    tts.speak('Hallo', 'de');
    vi.advanceTimersByTime(3000);
    expect(tts.speaking()).toBe(true); // still playing as far as the engine says
    synth.speaking = false; // finished, but no end event ever arrives
    vi.advanceTimersByTime(1600);
    expect(tts.speaking()).toBe(false);
    expect(states).toEqual([true, false]);
  });
});

describe('samples', () => {
  it('has a sample sentence for each of the 28 languages', () => {
    for (const { code } of LANGUAGES) {
      expect(tts.sample(code).length).toBeGreaterThan(3);
      if (code !== 'en') expect(tts.sample(code)).not.toBe(tts.sample('en'));
    }
    expect(tts.SAMPLE_LANGS.sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
    expect(tts.sample('xx')).toBe(tts.sample('en'));
  });
});
