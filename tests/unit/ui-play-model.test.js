// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  wordTokens, rovingTarget, captureParts, diffCapture, isLowConfidence, captureSummary, sameCaptureText,
  createSentenceTracker, isCardWorthy, speechDelta, keyHintText, keyLabel, statusView
} from '../../src/ui/views/play/model.js';

const cap = (over = {}) => ({
  id: 'cap-1',
  time: 1,
  src: 'de',
  tgt: 'en',
  dialog: { text: 'Hallo! Willkommen', translation: '', status: 'pending' },
  others: [],
  conf: 0.95,
  ...over
});

describe('wordTokens', () => {
  it('splits words from punctuation and spaces', () => {
    const t = wordTokens('Hallo! Willkommen in der Welt.', 'de');
    expect(t.filter((x) => x.word).map((x) => x.text)).toEqual(['Hallo', 'Willkommen', 'in', 'der', 'Welt']);
    expect(t.map((x) => x.text).join('')).toBe('Hallo! Willkommen in der Welt.');
  });

  it('merges runs of non-word text and keeps line breaks', () => {
    const t = wordTokens('KAMPF\nBEUTEL', 'de');
    expect(t).toEqual([{ text: 'KAMPF', word: true }, { text: '\n', word: false }, { text: 'BEUTEL', word: true }]);
  });

  it('keeps POKéMON and apostrophes inside one word', () => {
    const words = wordTokens('It’s POKéMON time', 'en').filter((x) => x.word).map((x) => x.text);
    expect(words).toContain('POKéMON');
    expect(words[0]).toMatch(/^It/);
  });

  it('handles empty text', () => {
    expect(wordTokens('', 'en')).toEqual([]);
  });
});

describe('rovingTarget', () => {
  it('moves with arrows and stops at the ends', () => {
    expect(rovingTarget('ArrowRight', 0, 3)).toBe(1);
    expect(rovingTarget('ArrowRight', 2, 3)).toBe(2);
    expect(rovingTarget('ArrowLeft', 0, 3)).toBe(0);
    expect(rovingTarget('ArrowDown', 1, 3)).toBe(2);
    expect(rovingTarget('ArrowUp', 1, 3)).toBe(0);
  });

  it('jumps with Home and End', () => {
    expect(rovingTarget('Home', 2, 5)).toBe(0);
    expect(rovingTarget('End', 0, 5)).toBe(4);
  });

  it('swaps Left and Right in right-to-left text', () => {
    expect(rovingTarget('ArrowLeft', 0, 3, { rtl: true })).toBe(1);
    expect(rovingTarget('ArrowRight', 1, 3, { rtl: true })).toBe(0);
  });

  it('ignores other keys and empty groups', () => {
    expect(rovingTarget('Enter', 0, 3)).toBe(-1);
    expect(rovingTarget('ArrowRight', 0, 0)).toBe(-1);
  });
});

describe('captureParts / diffCapture', () => {
  it('lists the dialog first, then other regions', () => {
    const c = cap({ others: [{ key: 'm1', kind: 'menu', text: 'JA\nNEIN', translation: '', status: 'pending' }] });
    expect(captureParts(c).map((p) => p.key)).toEqual(['dialog', 'm1']);
    expect(captureParts(null)).toEqual([]);
  });

  it('treats another capture as new', () => {
    expect(diffCapture(cap(), cap({ id: 'cap-2' })).kind).toBe('new');
    expect(diffCapture(null, cap()).kind).toBe('new');
  });

  it('reports a translation landing as a patch of that part only', () => {
    const a = cap({ others: [{ key: 'm1', kind: 'menu', text: 'JA', translation: '', status: 'pending' }] });
    const b = cap({
      dialog: { text: 'Hallo! Willkommen', translation: 'Hello! Welcome', status: 'done' },
      others: [{ key: 'm1', kind: 'menu', text: 'JA', translation: '', status: 'pending' }]
    });
    expect(diffCapture(a, b)).toEqual({ kind: 'translation', changed: ['dialog'] });
  });

  it('reports grown or changed text as a text change', () => {
    const a = cap();
    const b = cap({ dialog: { text: 'Hallo! Willkommen in der Welt', translation: '', status: 'pending' } });
    expect(diffCapture(a, b).kind).toBe('text');
    const c = cap({ others: [{ key: 'm1', kind: 'menu', text: 'JA', translation: '', status: 'pending' }] });
    expect(diffCapture(a, c).kind).toBe('text');
  });

  it('reports no change for an identical snapshot', () => {
    expect(diffCapture(cap(), cap()).kind).toBe('none');
  });
});

describe('isLowConfidence / captureSummary', () => {
  it('flags only real scores below 0.75', () => {
    expect(isLowConfidence(0.5)).toBe(true);
    expect(isLowConfidence(0.75)).toBe(false);
    expect(isLowConfidence(null)).toBe(false);
    expect(isLowConfidence(0)).toBe(false);
  });

  it('summarises dialog, else the other regions', () => {
    expect(captureSummary(cap()).text).toBe('Hallo! Willkommen');
    const menu = cap({ dialog: null, others: [{ key: 'm', kind: 'menu', text: 'JA\nNEIN', translation: 'Yes\nNo', status: 'done' }] });
    expect(captureSummary(menu)).toEqual({ text: 'JA · NEIN', translation: 'Yes · No' });
  });
});

describe('sameCaptureText', () => {
  it('matches the same line read again, not a different pair or text', () => {
    expect(sameCaptureText(cap(), cap({ id: 'cap-2', dialog: { text: 'hallo, willkommen', translation: '', status: 'pending' } }))).toBe(true);
    expect(sameCaptureText(cap(), cap({ id: 'cap-2', tgt: 'fr' }))).toBe(false);
    expect(sameCaptureText(cap(), cap({ id: 'cap-2', dialog: { text: 'Tschüss', translation: '', status: 'pending' } }))).toBe(false);
    expect(sameCaptureText(null, cap())).toBe(false);
  });
});

describe('createSentenceTracker', () => {
  it('hands out each completed sentence once, as the transcript grows', () => {
    const t = createSentenceTracker();
    expect(t.take('a', 'Hello there! Welcome to the', 'en')).toEqual(['Hello there!']);
    expect(t.take('a', 'Hello there! Welcome to the', 'en')).toEqual([]);
    expect(t.take('a', 'Hello there! Welcome to the world of POKéMON! My name is OAK.', 'en'))
      .toEqual(['Welcome to the world of POKéMON!', 'My name is OAK.']);
  });

  it('keeps an unfinished last sentence until the line is over', () => {
    const t = createSentenceTracker();
    expect(t.take('b', 'Die Straße führt nach Süden', 'de')).toEqual([]);
    expect(t.take('b', 'Die Straße führt nach Süden', 'de', { final: true })).toEqual(['Die Straße führt nach Süden']);
    expect(t.take('c', 'ROUTE', 'en', { final: true })).toEqual([]);
  });

  it('tracks captures separately', () => {
    const t = createSentenceTracker();
    expect(t.take('a', 'Ja!', 'de')).toEqual(['Ja!']);
    expect(t.take('b', 'Ja!', 'de')).toEqual(['Ja!']);
  });
});

describe('isCardWorthy', () => {
  it('accepts short real lines', () => {
    expect(isCardWorthy('Ja!')).toBe(true);
    expect(isCardWorthy('Möchtest du gegen mich kämpfen?')).toBe(true);
  });

  it('rejects copyright lines, numbers and empty text', () => {
    expect(isCardWorthy('©1995 GAME FREAK inc.')).toBe(false);
    expect(isCardWorthy('192/200')).toBe(false);
    expect(isCardWorthy('')).toBe(false);
    expect(isCardWorthy('x'.repeat(400))).toBe(false);
  });
});

describe('speechDelta', () => {
  it('speaks only what was added', () => {
    expect(speechDelta('', 'Hello there!')).toBe('Hello there!');
    expect(speechDelta('Hello there!', 'Hello there! Welcome.')).toBe('Welcome.');
    expect(speechDelta('Hello there!', 'Hello there!')).toBe('');
    expect(speechDelta('Hello', 'Goodbye')).toBe('Goodbye');
  });
});

describe('keyHintText', () => {
  it('builds the hint from the key map', () => {
    const text = keyHintText([
      { button: 'A', key: 'Z' }, { button: 'B', key: 'X' }, { button: 'Start', key: 'Enter' },
      { button: 'Select', key: 'V' }, { button: 'D-pad', key: 'Arrow keys' }
    ]);
    expect(text).toBe('Arrow keys move · Z = A · X = B · Enter = Start · V = Select · Esc returns to the app');
  });

  it('reads EmulatorJS key codes as key names', () => {
    const text = keyHintText([
      { button: 'A', key: '90' }, { button: 'B', key: '88' }, { button: 'Start', key: '13' },
      { button: 'Select', key: '86' }, { button: 'D-pad', key: '38 37 40 39' }
    ]);
    expect(text).toBe('Arrow keys move · Z = A · X = B · Enter = Start · V = Select · Esc returns to the app');
    expect(keyLabel(32)).toBe('Space');
    expect(keyLabel('97')).toBe('Numpad 1');
    expect(keyLabel('up arrow')).toBe('Up arrow');
    expect(keyLabel('q')).toBe('Q');
    expect(keyHintText([{ button: 'D-pad', key: '87 65 83 68' }])).toBe('W A S D move · Esc returns to the app');
  });

  it('names custom direction keys', () => {
    expect(keyHintText([{ button: 'D-pad', key: 'W A S D' }])).toBe('W A S D move · Esc returns to the app');
  });
});

describe('statusView', () => {
  it('labels setup with its progress', () => {
    expect(statusView({ state: 'setup', progress: 0.42, message: 'Downloading' })).toMatchObject({ state: 'setup', label: 'Setting up 42%', progress: 0.42 });
    expect(statusView({ state: 'setup', progress: null }).label).toBe('Setting up…');
  });

  it('keeps routine states quiet and explains pauses and errors', () => {
    expect(statusView({ state: 'watching', message: 'Watching for text' })).toMatchObject({ label: 'Watching', message: '' });
    expect(statusView({ state: 'paused', message: 'Auto-translate is paused' }).message).toBe('Auto-translate is paused');
    expect(statusView({ state: 'error', message: 'Couldn’t read', detail: 'boom' })).toMatchObject({ label: 'Error', detail: 'boom' });
    expect(statusView(null).state).toBe('off');
    expect(statusView({ state: 'weird' }).state).toBe('off');
  });
});
