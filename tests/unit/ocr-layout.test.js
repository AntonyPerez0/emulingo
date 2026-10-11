// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRegions, buildRegionsFromCells, joinLines, isSentenceLike } from '../../src/core/ocr/layout.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/ocr/layout-screens.json', import.meta.url), 'utf8'));

const L = (text, x, y, w, h = 8, score = 0.98) => ({ text, score, box: { x, y, w, h } });
const GB_DIALOG = { key: 'dialog:0,96,160,48', kind: 'dialog', x: 3, y: 99, w: 154, h: 42 };
const GB = { w: 160, h: 144 };

describe('buildRegions on engine output from Pokémon screens', () => {
  for (const screen of fixture.screens) {
    it(screen.name, () => {
      const regions = buildRegions(screen.lines, screen.container, screen.frame, { lang: screen.lang });
      expect(regions.map((r) => r.kind)).toEqual(screen.expect.map((e) => e.kind));
      screen.expect.forEach((e, i) => {
        if (e.lines) expect(regions[i].lines).toEqual(e.lines);
        if (e.text) expect(regions[i].text).toBe(e.text);
        expect(regions[i].containerKey).toBe(screen.container.key);
      });
    });
  }

  it('gives regions stable keys, a native box, and per-line scores', () => {
    const [r] = buildRegions([L('Hello there!', 8, 112, 96, 8, 0.99), L('Welcome to the', 8, 128, 112, 8, 0.8)], GB_DIALOG, GB);
    expect(r.key).toBe('dialog:0,96,160,48:dialog0');
    expect(r.box).toEqual({ x: 8, y: 112, w: 112, h: 24 });
    expect(r.score).toBe(0.8);
    expect(r.lineScores).toEqual([0.99, 0.8]);
  });

  it('never strips the pronoun I in dialog', () => {
    const [r] = buildRegions([L('I like shorts!', 8, 112, 112), L("They're comfy and", 8, 128, 136)], GB_DIALOG, GB);
    expect(r.text).toBe("I like shorts! They're comfy and");
  });

  it('drops items below the confidence floor and empty boxes', () => {
    expect(buildRegions([L('Hello there!', 8, 112, 96, 8, 0.5)], GB_DIALOG, GB)).toEqual([]);
    expect(buildRegions([], GB_DIALOG, GB)).toEqual([]);
    expect(buildRegions(null, GB_DIALOG, GB)).toEqual([]);
  });

  it('ignores specks on the box border', () => {
    const [r] = buildRegions([L('a', 3, 112, 3, 8), L('Hello there!', 8, 112, 96)], GB_DIALOG, GB);
    expect(r.text).toBe('Hello there!');
  });

  it('treats a menu drawn into the dialog box crop as a menu', () => {
    const regions = buildRegions([L('YES', 120, 112, 24), L('NO', 120, 128, 16)], GB_DIALOG, GB);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe('menu');
    expect(regions[0].lines).toEqual(['YES', 'NO']);
    expect(regions[0].text).toBe('YES\nNO');
  });

  it('keeps an all-caps column ending in "!" a menu', () => {
    const box = { key: 'menu:8,24,80,56', kind: 'menu', x: 8, y: 24, w: 80, h: 56 };
    const regions = buildRegions([L('KAUFEN', 16, 32, 48), L('VERKAUFEN', 16, 48, 72), L('TSCHÜSS!', 16, 64, 64)], box, GB, { lang: 'de' });
    expect(regions.map((r) => r.kind)).toEqual(['menu']);
    expect(regions[0].lines).toEqual(['KAUFEN', 'VERKAUFEN', 'TSCHÜSS!']);
  });

  it('merges letter-spaced menu words', () => {
    const box = { key: 'menu:8,24,80,56', kind: 'menu', x: 8, y: 24, w: 80, h: 56 };
    const regions = buildRegions([L('K A U FE N', 16, 32, 48), L('V E R K A U F E N', 16, 48, 72)], box, GB, { lang: 'de' });
    expect(regions[0].lines).toEqual(['KAUFEN', 'VERKAUFEN']);
  });

  it('splits free reads into several regions', () => {
    const free = { key: 'free', kind: 'free', x: 0, y: 0, w: 160, h: 144 };
    const regions = buildRegions([
      L('NEW GAME', 48, 40, 64), L('CONTINUE', 48, 56, 64), L('OPTION', 48, 72, 48),
      L('PRESS START', 36, 120, 88)
    ], free, GB);
    expect(regions.map((r) => [r.kind, r.text])).toEqual([
      ['menu', 'NEW GAME\nCONTINUE\nOPTION'],
      ['label', 'PRESS START']
    ]);
  });

  it('orders dialog regions first, then menus, then labels', () => {
    const free = { key: 'zone', kind: 'zone', x: 0, y: 0, w: 160, h: 144 };
    const regions = buildRegions([
      L('ROUTE 1', 8, 8, 56),
      L('YES', 120, 40, 24), L('NO', 120, 56, 16),
      L('Do you want to go?', 8, 120, 144)
    ], free, GB);
    expect(regions.map((r) => r.kind)).toEqual(['dialog', 'menu', 'label']);
  });

  it('handles a container without size (whole frame)', () => {
    const regions = buildRegions([L('Hello there friend!', 8, 112, 144)], { key: 'z', kind: 'zone', x: 0, y: 0, w: 0, h: 0 }, GB);
    expect(regions[0].text).toBe('Hello there friend!');
  });
});

describe('buildRegionsFromCells', () => {
  it('uses the cells\' ink boxes as line boxes', () => {
    const menu = { key: 'menu:72,96,88,48', kind: 'menu', x: 75, y: 99, w: 82, h: 42 };
    const cells = [
      { row: 0, col: 0, x: 80, y: 112, w: 39, h: 7, text: 'FIGHT', score: 0.99 },
      { row: 0, col: 1, x: 128, y: 112, w: 31, h: 7, text: 'PkMn', score: 0.9 },
      { row: 1, col: 0, x: 80, y: 128, w: 31, h: 7, text: 'ITEM', score: 0.99 },
      { row: 1, col: 1, x: 128, y: 128, w: 23, h: 7, text: 'RUN', score: 0.99 },
      { row: 2, col: 0, x: 80, y: 136, w: 7, h: 4, text: '', score: 0 }
    ];
    const [r] = buildRegionsFromCells(cells, menu, GB);
    expect(r.kind).toBe('menu');
    expect(r.lines).toEqual(['FIGHT', 'PkMn', 'ITEM', 'RUN']);
    expect(buildRegionsFromCells([], menu, GB)).toEqual([]);
  });
});

describe('joinLines', () => {
  it('removes a wrap hyphen before a lowercase continuation', () => {
    expect(joinLines(['zeich-', 'net Daten'])).toBe('zeichnet Daten');
    expect(joinLines(['Er ist auf-', 'geweckt'])).toBe('Er ist aufgeweckt');
  });

  it('keeps the hyphen in compounds (OCR-15)', () => {
    expect(joinLines(['Willkommen im POKéMON-', 'CENTER!'])).toBe('Willkommen im POKéMON-CENTER!');
    expect(joinLines(['der Pokémon-', 'Trainer'])).toBe('der Pokémon-Trainer');
    expect(joinLines(['TM-', '24'])).toBe('TM-24');
    expect(joinLines(['im POKéMON-', 'markt'])).toBe('im POKéMON-markt');
  });

  it('joins with single spaces and skips blanks', () => {
    expect(joinLines(['Hello there!', '', '  Welcome to the  '])).toBe('Hello there! Welcome to the');
    expect(joinLines([])).toBe('');
  });
});

describe('isSentenceLike', () => {
  it('recognises prompts and dialog', () => {
    expect(isSentenceLike('What will PIKACHU do?')).toBe(true);
    expect(isSentenceLike('Wild PIDGEY appeared!')).toBe(true);
    expect(isSentenceLike('Would you like to')).toBe(true);
  });

  it('rejects menu entries and names', () => {
    expect(isSentenceLike('POKéDEX')).toBe(false);
    expect(isSentenceLike('FIGHT PkMn')).toBe(false);
    expect(isSentenceLike('NEW BARK TOWN')).toBe(false);
    expect(isSentenceLike('Hi!')).toBe(false);
  });
});

describe('review fixes', () => {
  const kinds = (regions) => regions.map((r) => [r.kind, r.text]);

  it('keeps short dialog lines inside text boxes (OCR-M5)', () => {
    expect(kinds(buildRegions([L('Ja!', 8, 112, 24)], GB_DIALOG, GB, { lang: 'de' }))).toEqual([['dialog', 'Ja!']]);
    expect(kinds(buildRegions([L('OK!', 8, 112, 24)], GB_DIALOG, GB))).toEqual([['dialog', 'OK!']]);
    expect(kinds(buildRegions([L('はい', 8, 112, 16)], GB_DIALOG, GB, { lang: 'ja' }))).toEqual([['dialog', 'はい']]);
    expect(kinds(buildRegions([L('100', 8, 112, 24)], GB_DIALOG, GB))).toEqual([['dialog', '100']]);
    const zone = { key: 'zone', kind: 'zone', x: 0, y: 96, w: 160, h: 48 };
    expect(kinds(buildRegions([L('Oh!', 8, 112, 24)], zone, GB))).toEqual([['dialog', 'Oh!']]);
    const battle = { key: 'battle:0,112,240,48', kind: 'battle', x: 0, y: 112, w: 240, h: 48 };
    expect(kinds(buildRegions([L('Ow!', 8, 120, 24)], battle, { w: 240, h: 160 }))).toEqual([['dialog', 'Ow!']]);
  });

  it('still drops symbols-only lines, and short lines in free reads', () => {
    expect(buildRegions([L('!?', 8, 112, 16)], GB_DIALOG, GB)).toEqual([]);
    expect(buildRegions([L('1', 8, 112, 8)], GB_DIALOG, GB)).toEqual([]);
    const free = { key: 'free', kind: 'free', x: 0, y: 0, w: 160, h: 144 };
    expect(buildRegions([L('Oh!', 8, 112, 24)], free, GB)).toEqual([]);
  });

  it('drops the ▼ arrow alone on the bottom row', () => {
    const regions = buildRegions([L('Ja!', 8, 112, 24), L('T', 144, 128, 7)], GB_DIALOG, GB, { lang: 'de' });
    expect(kinds(regions)).toEqual([['dialog', 'Ja!']]);
    expect(regions[0].lines).toEqual(['Ja!']);
  });

  it('keeps the menu columns the box detector found, even when narrow', () => {
    const menu = { key: 'menu:69,101,86,38', kind: 'menu', x: 69, y: 101, w: 86, h: 38 };
    const cells = [
      { row: 0, col: 0, x: 80, y: 113, w: 39, h: 7, text: 'FIGHT', score: 1 },
      { row: 0, col: 1, x: 128, y: 113, w: 23, h: 7, text: '', score: 0 }, // PkMn unreadable
      { row: 1, col: 0, x: 80, y: 129, w: 31, h: 7, text: 'ITEM', score: 0.999 },
      { row: 1, col: 1, x: 128, y: 129, w: 23, h: 7, text: 'RUN', score: 0.999 }
    ];
    expect(buildRegionsFromCells(cells, menu, GB)[0].lines).toEqual(['FIGHT', 'ITEM', 'RUN']);
    // the same lines without cell columns fall back to geometry
    const lines = cells.filter((c) => c.text).map((c) => L(c.text, c.x, c.y, c.w, c.h, c.score));
    expect(buildRegions(lines, menu, GB)[0].lines).toEqual(['FIGHT', 'ITEM RUN']);
  });

  it('adds the opening ¡ to a page that starts a sentence, not to an all-caps name', () => {
    const [a] = buildRegions([L('Hola! iEncantado de', 8, 112, 136), L('conocerte!', 8, 128, 80)], GB_DIALOG, GB, { lang: 'es' });
    expect(a.text).toBe('¡Hola! ¡Encantado de conocerte!');
    const [b] = buildRegions([L('OAK!', 8, 112, 32)], GB_DIALOG, GB, { lang: 'es' });
    expect(b.text).toBe('OAK!');
  });
});
