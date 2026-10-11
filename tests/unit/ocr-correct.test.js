// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import nspell from 'nspell';
import {
  createSpeller, correctLine, createCorrector, hasDictionary, dictLang, dictionaryUrl, DICTS, addWords
} from '../../src/core/ocr/correct.js';

// the dev-dependency dictionaries are the same pinned versions the app fetches
const dictFiles = (lang) => {
  const dir = new URL(`../../node_modules/dictionary-${lang}/`, import.meta.url);
  return { aff: readFileSync(new URL('index.aff', dir), 'utf8'), dic: readFileSync(new URL('index.dic', dir), 'utf8') };
};

const spellers = {};
beforeAll(() => {
  for (const lang of ['de', 'en', 'es']) {
    const { aff, dic } = dictFiles(lang);
    spellers[lang] = createSpeller(nspell, aff, dic, lang);
  }
}, 30000);

describe('language codes', () => {
  it('uses app codes, never Tesseract codes (OCR-17)', () => {
    expect(hasDictionary('es')).toBe(true);
    expect(hasDictionary('de-AT')).toBe(true);
    expect(hasDictionary('spa')).toBe(false);
    expect(hasDictionary('ja')).toBe(false);
    expect(dictLang('pt-BR')).toBe('pt');
    expect(dictionaryUrl('de', 'dic')).toBe(`https://cdn.jsdelivr.net/npm/dictionary-de@${DICTS.de.version}/index.dic`);
    expect(dictionaryUrl('xx', 'dic')).toBe(null);
  });
});

describe('German: correct words stay unchanged (OCR-06 regressions)', () => {
  const unchanged = [
    'Für manche sind POKéMON Haustiere, andere tragen Kämpfe mit ihnen aus.',
    'Der Gegner setzt Tackle ein!',
    'Ich will es wissen.',
    'Du musst daran glauben.',
    'Wir lernen viel.',
    'Willst du ihn benutzen?',
    'Du musst ihn besiegen!',
    'Ein wild lebendes POKéMON.',
    'Der Berg ist hoch.',
    'Ein wildes TAUBSI erscheint! Willst du es fangen?',
    'Dein Spielstand wurde gesichert.',
    'Ein Volltreffer!',
    'Du hast einen Hyperball, einen Trank und den Beutel.',
    'KAMPF FLUCHT BEUTEL'
  ];
  for (const line of unchanged) {
    it(line, () => expect(correctLine(spellers.de, line, 'de')).toBe(line));
  }
});

describe('German: misreads are fixed', () => {
  it('restores dropped umlauts', () => {
    expect(correctLine(spellers.de, 'Das ist fur dich.', 'de')).toBe('Das ist für dich.');
    expect(correctLine(spellers.de, 'Das Madchen lacht.', 'de')).toBe('Das Mädchen lacht.');
  });
});

describe('English', () => {
  it('leaves correct text alone', () => {
    for (const line of ['Hello there! Welcome to the world of POKéMON!', 'My name is OAK!', 'Hi, I like shorts!']) {
      expect(correctLine(spellers.en, line, 'en')).toBe(line);
    }
  });

  it('fixes pixel-font merges', () => {
    expect(correctLine(spellers.en, 'You have no rnoney!', 'en')).toBe('You have no money!');
  });

  it('re-joins letters the engine split when the speller knows the word', () => {
    expect(correctLine(spellers.en, 'Would you like t o SAVE the game?', 'en')).toBe('Would you like to SAVE the game?');
    expect(correctLine(spellers.en, 'Use Figh t now', 'en')).toBe('Use Fight now');
    expect(correctLine(spellers.en, 'I like it a lot', 'en')).toBe('I like it a lot');
    expect(correctLine(spellers.de, 'Ich will es wiss en', 'de')).toBe('Ich will es wiss en');
  });
});

describe('Spanish', () => {
  it('fixes a word-initial rn -> m (first-letter guard allows pair confusions)', () => {
    expect(correctLine(spellers.es, 'Bienvenido al rnundo', 'es')).toBe('Bienvenido al mundo');
  });

  it('fixes í read as f', () => {
    expect(correctLine(spellers.es, 'Aquf está tu POKéMON. ¡Cufdalo!', 'es')).toBe('Aquí está tu POKéMON. ¡Cuídalo!');
  });
});

describe('wrong language guard', () => {
  it('does not "correct" English with the German dictionary (e2e: "My Dame is Oak")', () => {
    const line = 'Hello there! Welcome to the world of POKéMON! My name is OAK!';
    expect(correctLine(spellers.de, line, 'de')).toBe(line);
    expect(correctLine(spellers.de, 'world of Pokémon! My name is Oak.', 'de')).toBe('world of Pokémon! My name is Oak.');
  });

  it('handles empty input and a missing speller', () => {
    expect(correctLine(spellers.en, '', 'en')).toBe('');
    expect(correctLine(null, 'tbe', 'en')).toBe('tbe');
  });

  it('accepts extra words at runtime', () => {
    const sp = spellers.en;
    expect(correctLine(sp, 'Zorbix attacks!', 'en')).toBe('Zorbix attacks!');
    addWords(sp, ['Glumbo']);
    expect(sp.correct('Glumbo')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Client: download, cache and worker protocol, with the real worker module.

let workerHandler = null;
async function loadWorker() {
  const replies = [];
  globalThis.self = { postMessage: (m) => replies.push(m) };
  vi.resetModules();
  await import('../../src/core/ocr/correct.worker.js');
  workerHandler = globalThis.self.onmessage;
  return replies;
}

function fakeWorkerFactory(replies) {
  const made = [];
  const factory = () => {
    const w = {
      onmessage: null,
      onerror: null,
      terminated: false,
      posted: [],
      postMessage(msg) {
        this.posted.push(msg.type);
        setTimeout(() => {
          if (this.terminated) return;
          workerHandler({ data: msg });
          const reply = replies.shift();
          this.onmessage && this.onmessage({ data: reply });
        }, 0);
      },
      terminate() { this.terminated = true; }
    };
    made.push(w);
    return w;
  };
  factory.made = made;
  return factory;
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, get: async (k) => data.get(k), set: async (k, v) => { data.set(k, v); } };
}

describe('createCorrector', () => {
  afterEach(() => {
    delete globalThis.self;
  });

  it('downloads with progress, caches in storage and corrects in the worker', async () => {
    const replies = await loadWorker();
    const files = dictFiles('es');
    const fetchText = vi.fn(async (url, onFrac) => {
      onFrac(0.5);
      onFrac(1);
      return url.endsWith('.dic') ? files.dic : files.aff;
    });
    const storage = memoryStorage();
    const events = [];
    const createWorker = fakeWorkerFactory(replies);
    const c = createCorrector({ createWorker, fetchText, storage, onStatus: (s) => events.push(s) });

    expect(await c.correct('Bienvenido al rnundo', 'es', 0.7)).toBe('Bienvenido al mundo');
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(fetchText.mock.calls[0][0]).toBe(dictionaryUrl('es', 'dic'));
    expect(storage.data.get('spelldict:es')).toMatchObject({ version: DICTS.es.version });
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe('download');
    expect(phases).toContain('init');
    expect(phases[phases.length - 1]).toBe('ready');
    const progress = events.filter((e) => e.phase === 'download').map((e) => e.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(Math.max(...progress)).toBe(1);
    expect(c.isReady('es')).toBe(true);

    // a second corrector finds the dictionary in storage
    const c2 = createCorrector({ createWorker: fakeWorkerFactory(replies), fetchText, storage });
    expect(await c2.correct('rnundo', 'es')).toBe('mundo');
    expect(fetchText).toHaveBeenCalledTimes(2);
    c.dispose();
    c2.dispose();
  }, 30000);

  it('passes through text for languages without a dictionary', async () => {
    const fetchText = vi.fn();
    const createWorker = vi.fn();
    const c = createCorrector({ createWorker, fetchText, storage: memoryStorage() });
    expect(await c.correct('こんにちは', 'ja')).toBe('こんにちは');
    expect(await c.warm('spa')).toBe(false);
    expect(fetchText).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('returns the raw text when the download fails and backs off', async () => {
    let now = 0;
    const fetchText = vi.fn(async () => { throw new Error('offline'); });
    const events = [];
    const c = createCorrector({
      createWorker: vi.fn(), fetchText, storage: memoryStorage(), now: () => now, onStatus: (s) => events.push(s)
    });
    expect(await c.correct('rnundo', 'es')).toBe('rnundo');
    expect(events.at(-1)).toMatchObject({ phase: 'error', lang: 'es' });
    expect(await c.correct('rnundo', 'es')).toBe('rnundo');
    expect(fetchText).toHaveBeenCalledTimes(1);
    now = 20000;
    await c.correct('rnundo', 'es');
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it('survives a crashed worker', async () => {
    const files = dictFiles('en');
    const storage = memoryStorage({ 'spelldict:en': files });
    let worker = null;
    const createWorker = () => {
      worker = {
        postMessage: (msg) => setTimeout(() => {
          if (msg.type === 'init') worker.onmessage({ data: { id: msg.id, ok: true } });
          else worker.onerror({ message: 'boom', preventDefault() {} });
        }, 0),
        terminate: vi.fn()
      };
      return worker;
    };
    const c = createCorrector({ createWorker, fetchText: vi.fn(), storage });
    expect(await c.correct('rnoney', 'en')).toBe('rnoney');
    expect(worker.terminate).toHaveBeenCalled();
    expect(c.isReady('en')).toBe(false);
  });

  it('builds a language again after the worker dropped it for another one', async () => {
    const replies = await loadWorker();
    const storage = memoryStorage({ 'spelldict:es': dictFiles('es'), 'spelldict:en': dictFiles('en') });
    const createWorker = fakeWorkerFactory(replies);
    const c = createCorrector({ createWorker, fetchText: vi.fn(), storage });
    expect(await c.correct('rnundo', 'es')).toBe('mundo');
    // the worker keeps one speller: building English drops Spanish
    expect(await c.correct('rnoney', 'en')).toBe('money');
    expect(c.isReady('es')).toBe(false);
    expect(c.isReady('en')).toBe(true);
    expect(await c.correct('rnundo', 'es')).toBe('mundo');
    expect(createWorker.made[0].posted).toEqual(['init', 'correct', 'init', 'correct', 'init', 'correct']);
    c.dispose();
  }, 30000);

  it('rebuilds when the worker reports a missing speller', async () => {
    const replies = await loadWorker();
    const storage = memoryStorage({ 'spelldict:en': dictFiles('en') });
    const createWorker = fakeWorkerFactory(replies);
    const c = createCorrector({ createWorker, fetchText: vi.fn(), storage });
    expect(await c.warm('en')).toBe(true);
    // another client (or a bug) replaced the speller behind our back
    workerHandler({ data: { id: 0, type: 'init', lang: 'de', aff: '', dic: '' } });
    replies.length = 0;
    expect(await c.correct('rnoney', 'en')).toBe('rnoney');
    expect(c.isReady('en')).toBe(false);
    expect(await c.correct('rnoney', 'en')).toBe('money');
    c.dispose();
  }, 30000);

  it('sends words added while the speller was being built', async () => {
    const replies = await loadWorker();
    const storage = memoryStorage({ 'spelldict:en': dictFiles('en') });
    const createWorker = fakeWorkerFactory(replies);
    const c = createCorrector({ createWorker, fetchText: vi.fn(), storage });
    const ready = c.warm('en');
    await new Promise((r) => setTimeout(r, 0));
    c.addWords('en', ['Zorbix']);
    expect(await ready).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(createWorker.made[0].posted).toEqual(['init', 'add']);
    c.dispose();
  }, 30000);

  it('starts over with a fresh worker when building the speller times out', async () => {
    const storage = memoryStorage({ 'spelldict:en': dictFiles('en') });
    const workers = [];
    const createWorker = () => {
      const w = { postMessage: vi.fn(), terminate: vi.fn() }; // never answers
      workers.push(w);
      return w;
    };
    const c = createCorrector({ createWorker, fetchText: vi.fn(), storage, config: { initTimeout: 20 } });
    expect(await c.warm('en')).toBe(false);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalled();
    c.dispose();
  });

  it('accepts cached v1 entries without a version', async () => {
    const replies = await loadWorker();
    const storage = memoryStorage({ 'spelldict:en': dictFiles('en') });
    const fetchText = vi.fn();
    const c = createCorrector({ createWorker: fakeWorkerFactory(replies), fetchText, storage });
    expect(await c.warm('en')).toBe(true);
    expect(fetchText).not.toHaveBeenCalled();
    c.addWords('en', ['Zzyzx']);
    c.dispose();
  }, 30000);
});
