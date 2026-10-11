// Spell-correction worker: builds nspell spellers off the main thread
// (German takes ~1.4 s, French ~6 s) and corrects lines on request.
//
// Messages in:  { id, type: 'init', lang, aff, dic, words }
//               { id, type: 'correct', lang, text }
//               { id, type: 'add', lang, words }
// Messages out: { id, ok: true, ... } or { id, ok: false, error }

import nspell from 'nspell';
import { createSpeller, correctLine, addWords } from './correct.js';

const spellers = new Map();

function handle(msg) {
  switch (msg.type) {
    case 'init': {
      // one game language at a time: drop the others to free memory
      for (const lang of [...spellers.keys()]) if (lang !== msg.lang) spellers.delete(lang);
      const t0 = performance.now();
      spellers.set(msg.lang, createSpeller(nspell, msg.aff, msg.dic, msg.lang, msg.words || []));
      return { ms: Math.round(performance.now() - t0) };
    }
    case 'correct': {
      const speller = spellers.get(msg.lang);
      // ready: false tells the client to send 'init' for this language again
      return speller ? { text: correctLine(speller, msg.text, msg.lang) } : { text: msg.text, ready: false };
    }
    case 'add': {
      const speller = spellers.get(msg.lang);
      if (speller) addWords(speller, msg.words || []);
      return {};
    }
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    self.postMessage({ id: msg.id, ok: true, ...handle(msg) });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
