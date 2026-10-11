// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  createDialogTracker, splitSentences, normalizeForCompare, similarText, isCompleteSentence
} from '../../src/core/ocr/dialog.js';

const page = (...lines) => ({ lines });

describe('normalizeForCompare', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(normalizeForCompare('World of POKéMON!')).toBe('world of pokemon');
    expect(normalizeForCompare('  Hallo,   Welt… ')).toBe('hallo welt');
    expect(normalizeForCompare('Straße')).toBe('strasse');
    expect(normalizeForCompare(null)).toBe('');
  });

  it('treats one-letter read differences as the same text', () => {
    expect(similarText('world of pokemon', 'world of pokemoni')).toBe(true);
    expect(similarText('hello there', 'hallo there')).toBe(true);
    expect(similarText('hello there', 'yellow there')).toBe(false);
    expect(similarText('my name is oak', 'welcome to the')).toBe(false);
    expect(similarText('hi', 'ho')).toBe(false);
  });
});

describe('splitSentences', () => {
  it('splits on sentence punctuation', () => {
    expect(splitSentences('Hello there! Welcome to the world of POKéMON! My name is OAK!', 'en'))
      .toEqual(['Hello there!', 'Welcome to the world of POKéMON!', 'My name is OAK!']);
  });

  it('keeps abbreviations and ellipses inside sentences', () => {
    expect(splitSentences('PROF. OAK is waiting. Go!', 'en')).toEqual(['PROF. OAK is waiting.', 'Go!']);
    expect(splitSentences('Myself… I study POKéMON.', 'en')).toEqual(['Myself… I study POKéMON.']);
  });

  it('handles Spanish marks and an unfinished tail', () => {
    expect(splitSentences('¡Hola! ¡Bienvenido al mundo de los', 'es')).toEqual(['¡Hola!', '¡Bienvenido al mundo de los']);
  });

  it('falls back to a regex without Intl.Segmenter', () => {
    const saved = Intl.Segmenter;
    try {
      Intl.Segmenter = undefined;
      expect(splitSentences('Hello there! Welcome to the', 'en')).toEqual(['Hello there!', 'Welcome to the']);
      expect(splitSentences('PROF. OAK is here.', 'en')).toEqual(['PROF. OAK is here.']);
    } finally {
      Intl.Segmenter = saved;
    }
  });

  it('returns nothing for empty text', () => {
    expect(splitSentences('', 'en')).toEqual([]);
  });

  it('knows complete sentences', () => {
    expect(isCompleteSentence('My name is OAK!')).toBe(true);
    expect(isCompleteSentence('Was soll ich tun?“')).toBe(true);
    expect(isCompleteSentence('Welcome to the')).toBe(false);
  });
});

describe('createDialogTracker', () => {
  it('merges a Gen 1/2 scrolling conversation into one transcript', () => {
    const t = createDialogTracker({ lang: 'en' });
    const a = t.update(page('Hello there!', 'Welcome to the'), 0);
    expect(a.continued).toBe(false);
    expect(a.text).toBe('Hello there! Welcome to the');
    expect(a.sentences).toEqual({ complete: ['Hello there!'], partial: 'Welcome to the' });

    const b = t.update(page('Welcome to the', 'world of POKéMON!'), 2000);
    expect(b.continued).toBe(true);
    expect(b.id).toBe(a.id);
    expect(b.added).toBe('world of POKéMON!');
    expect(b.page).toBe('Welcome to the world of POKéMON!');
    expect(b.text).toBe('Hello there! Welcome to the world of POKéMON!');
    expect(b.sentences.complete).toEqual(['Welcome to the world of POKéMON!']);

    const c = t.update(page('world of POKéMON!', 'My name is OAK!'), 4000);
    expect(c.continued).toBe(true);
    expect(c.text).toBe('Hello there! Welcome to the world of POKéMON! My name is OAK!');
    expect(c.added).toBe('My name is OAK!');
    expect(c.sentences).toEqual({ complete: ['My name is OAK!'], partial: '' });
  });

  it('tolerates a re-read of the scrolled line that differs by a letter', () => {
    const t = createDialogTracker();
    t.update(page('Welcome to the', 'world of POKéMON!'), 0);
    const s = t.update(page('world of POKéMONi', 'My name is OAK!'), 1000);
    expect(s.continued).toBe(true);
    expect(s.text).toBe('Welcome to the world of POKéMON! My name is OAK!');
  });

  it('is a no-op for the same page, a partial re-read and a scroll in progress', () => {
    const t = createDialogTracker();
    const first = t.update(page('Hello there!', 'Welcome to the'), 0);
    for (const p of [page('Hello there!', 'Welcome to the'), page('Hello there!'), page('Welcome to the')]) {
      const s = t.update(p, 100);
      expect(s.continued).toBe(true);
      expect(s.added).toBe('');
      expect(s.text).toBe(first.text);
    }
  });

  it('grows the page when typing resumes after a pause', () => {
    const t = createDialogTracker();
    t.update(page('Hello there!', 'Welc'), 0);
    const s = t.update(page('Hello there!', 'Welcome to the'), 600);
    expect(s.continued).toBe(true);
    expect(s.text).toBe('Hello there! Welcome to the');
    expect(s.added).toBe('Welcome to the');
  });

  it('handles a scroll after a mid-line pause', () => {
    const t = createDialogTracker();
    t.update(page('Hello there!', 'Welcome t'), 0);
    const s = t.update(page('Welcome to the', 'world of POKéMON!'), 1500);
    expect(s.continued).toBe(true);
    expect(s.text).toBe('Hello there! Welcome to the world of POKéMON!');
  });

  it('starts a new transcript for an unrelated Gen 3 page', () => {
    const t = createDialogTracker();
    const a = t.update(page('Hello there! Glad to meet you!', 'Welcome to the world of POKéMON!'), 0);
    const b = t.update(page('My name is BIRCH.', 'But everyone calls me the POKéMON PROFESSOR.'), 3000);
    expect(b.continued).toBe(false);
    expect(b.id).not.toBe(a.id);
    expect(b.text).toBe('My name is BIRCH. But everyone calls me the POKéMON PROFESSOR.');
    expect(b.added).toBe(b.text);
  });

  it('continues a sentence across a Gen 3 page clear', () => {
    const t = createDialogTracker();
    t.update(page('This world is widely inhabited', 'by creatures known as'), 0);
    const s = t.update(page('POKéMON.'), 2500);
    expect(s.continued).toBe(true);
    expect(s.text).toBe('This world is widely inhabited by creatures known as POKéMON.');
  });

  it('keeps the hyphen rule when joining pages', () => {
    const t = createDialogTracker();
    t.update(page('Der POKéDEX zeich-'), 0);
    const s = t.update(page('Der POKéDEX zeich-', 'net Daten auf.'), 500);
    expect(s.text).toBe('Der POKéDEX zeichnet Daten auf.');
  });

  it('resets when the dialog has been gone for more than a second', () => {
    const t = createDialogTracker();
    const a = t.update(page('Hello there!', 'Welcome to the'), 0);
    expect(t.update(null, 100).text).toBe(a.text);
    expect(t.update(null, 900).continued).toBe(true);
    const gone = t.update(null, 1200);
    expect(gone.text).toBe('');
    expect(gone.continued).toBe(false);
    const again = t.update(page('Welcome to the', 'world of POKéMON!'), 1300);
    expect(again.continued).toBe(false);
    expect(again.text).toBe('Welcome to the world of POKéMON!');
  });

  it('does not reset for a short gap', () => {
    const t = createDialogTracker();
    t.update(page('Hello there!', 'Welcome to the'), 0);
    t.update(null, 100);
    t.update(null, 800);
    const s = t.update(page('Welcome to the', 'world of POKéMON!'), 900);
    expect(s.continued).toBe(true);
  });

  it('caps the transcript and restarts it at a sentence boundary', () => {
    const t = createDialogTracker({ lang: 'en' });
    const lines = [
      'Hello there!', 'Welcome to the', 'world of POKéMON!', 'My name is OAK!', 'People call me', 'the POKéMON PROF!',
      'This world is', 'inhabited by'
    ];
    let s = t.update(page(lines[0], lines[1]), 0);
    const firstId = s.id;
    for (let i = 2; i < 6; i++) {
      s = t.update(page(lines[i - 1], lines[i]), i * 1000);
      expect(s.continued).toBe(true);
    }
    expect(s.text).toBe('Hello there! Welcome to the world of POKéMON! My name is OAK! People call me the POKéMON PROF!');
    s = t.update(page(lines[5], lines[6]), 7000);
    expect(s.continued).toBe(false);
    expect(s.id).not.toBe(firstId);
    expect(s.text).toBe('This world is');
    s = t.update(page(lines[6], lines[7]), 8000);
    expect(s.continued).toBe(true);
    expect(s.text).toBe('This world is inhabited by');
  });

  it('cuts one endless sentence at a line once it passes twice the cap', () => {
    const t = createDialogTracker({ capLines: 2 });
    let s = t.update(page('one two', 'three four'), 0);
    s = t.update(page('three four', 'five six'), 1);
    expect(s.continued).toBe(true);
    s = t.update(page('five six', 'seven eight'), 2);
    expect(s.continued).toBe(true);
    expect(s.text).toBe('one two three four five six seven eight');
    s = t.update(page('seven eight', 'nine ten'), 3);
    expect(s.continued).toBe(false);
    expect(s.text).toBe('nine ten');
  });

  it('reset() forgets the transcript', () => {
    const t = createDialogTracker();
    const a = t.update(page('Hello there!', 'Welcome to the'), 0);
    t.reset();
    const b = t.update(page('Hello there!', 'Welcome to the'), 10);
    expect(b.continued).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it('ignores empty lines in a region', () => {
    const t = createDialogTracker();
    expect(t.update({ lines: ['', '  '] }, 0).text).toBe('');
    expect(t.update({ lines: [' Hi there! '] }, 10).text).toBe('Hi there!');
  });
});

describe('similarText: numbers and stricter ratios', () => {
  it('treats a changed number as different text', () => {
    expect(similarText('pikachu grew to level 6', 'pikachu grew to level 7')).toBe(false);
    expect(similarText('pikachu grew to level 6', 'pikachu grew to levei 6')).toBe(true);
  });

  it('accepts a tighter tolerance', () => {
    expect(similarText('wild rattata appeared', 'wild raticate appeared')).toBe(true);
    expect(similarText('wild rattata appeared', 'wild raticate appeared', 0.08)).toBe(false);
    expect(similarText('option', 'optlon', 0.08)).toBe(true);
  });

  it('starts a new page when only a number changed', () => {
    const t = createDialogTracker({ lang: 'en' });
    const a = t.update(page('PIKACHU grew to', 'level 6!'), 0);
    const b = t.update(page('PIKACHU grew to', 'level 7!'), 500);
    expect(b.id).not.toBe(a.id);
    expect(b.text).toBe('PIKACHU grew to level 7!');
  });
});
