// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  cleanLine, stripArrow, stripCursor, isHudToken, stripHudTokens, fixPokeWords, fixPkMn,
  fixInvertedPunctuation, normalizeCase, normalizeMenuCase, mergeSplitLetters, repairSpacing,
  fixDigitsInWords, isCapsish, letterCount, alnumCount
} from '../../src/core/ocr/lexicon.js';
import { isKnownWord, gameWords, wordKey } from '../../src/core/ocr/vocab.js';

describe('stripArrow (OCR-02)', () => {
  it('removes the ▼ arrow read as a separate letter on the last line', () => {
    expect(stripArrow('appeared! T')).toBe('appeared!');
    expect(stripArrow('appeared! v')).toBe('appeared!');
    expect(stripArrow('appeared!T')).toBe('appeared!');
  });

  it('removes glued arrow glyphs anywhere', () => {
    expect(stripArrow('dans le monde des+', { isLastLine: false })).toBe('dans le monde des');
    expect(stripArrow('Hello there! ▼')).toBe('Hello there!');
  });

  it('turns a dagger glued to a word into "!"', () => {
    expect(stripArrow('ist es gefährlich†')).toBe('ist es gefährlich!');
    expect(stripArrow('Draußen †')).toBe('Draußen');
  });

  it('leaves single letters alone on other lines', () => {
    expect(stripArrow('Vitamin C or T', { isLastLine: false })).toBe('Vitamin C or T');
  });
});

describe('stripCursor (menus only)', () => {
  it('strips cursor glyphs and cursor letters', () => {
    expect(stripCursor('† Figh t')).toBe('Figh t');
    expect(stripCursor('I Fight')).toBe('Fight');
    expect(stripCursor('• Pokédex')).toBe('Pokédex');
    expect(stripCursor('▶POKéDEX')).toBe('POKéDEX');
    expect(stripCursor('7 ITEM')).toBe('ITEM');
  });

  it('keeps entries that start with a digit or letter', () => {
    expect(stripCursor('1F')).toBe('1F');
    expect(stripCursor('ITEM')).toBe('ITEM');
  });

  it('is not applied to dialog: the pronoun I stays', () => {
    expect(cleanLine('I like shorts!', { kind: 'dialog' })).toBe('I like shorts!');
    expect(cleanLine('I Fight', { kind: 'menu' })).toBe('Fight');
  });
});

describe('HUD tokens (OCR-08)', () => {
  it('recognises level, HP and number fragments', () => {
    for (const t of [': L3', ':L5', 'L5', 'HP :', 'HP:', 'HP', 'HF.', '192', '19/', '20', '19/ 20', 'Lv2', 'Lv. 12']) {
      expect(isHudToken(t), t).toBe(true);
    }
  });

  it('does not match names or words', () => {
    for (const t of ['PIDGEY', 'PIDIGEY', 'HPX', 'Level', 'ROUTE 101', '']) expect(isHudToken(t), t).toBe(false);
  });

  it('strips HUD fragments inside a line', () => {
    expect(stripHudTokens('PIDGEY :L3')).toBe('PIDGEY');
    expect(stripHudTokens('POOCHYENALv2')).toBe('POOCHYENA');
    expect(stripHudTokens('TORCHIC Lv5')).toBe('TORCHIC');
    expect(stripHudTokens('HP: 19/ 20')).toBe('');
    expect(stripHudTokens('ROUTE 101')).toBe('ROUTE 101');
  });
});

describe('fixPokeWords (OCR-16)', () => {
  const cases = [
    ['POKEMON', 'POKéMON'], ['POKeMON', 'POKéMON'], ['POKBMON', 'POKéMON'], ['POK0MON', 'POKéMON'],
    ['POKÉMON', 'POKéMON'], ['POKéMON', 'POKéMON'], ['POKEDEX', 'POKéDEX'], ['POKE BALL', 'POKé BALL'],
    ['POKE MART', 'POKé MART'], ['POKE FLUTE', 'POKé FLUTE'], ['POKE MON', 'POKéMON'],
    ['Pokemon', 'Pokémon'], ['pokemon', 'Pokémon'], ['Pokémon', 'Pokémon'], ['Pokedex', 'Pokédex'],
    ['Poke Ball', 'Poké Ball'], ['PokeGear', 'PokéGear'], ['POKEGEAR', 'POKéGEAR']
  ];
  for (const [input, out] of cases) {
    it(`${input} -> ${out}`, () => expect(fixPokeWords(input)).toBe(out));
  }

  it('repairs the "!" read as "i" before the arrow', () => {
    expect(fixPokeWords('world of Pokémoni')).toBe('world of Pokémon!');
    expect(cleanLine('World of Pokemoni+', { isLastLine: true })).toBe('World of Pokémon!');
    expect(cleanLine('of Pokémoni+', { isLastLine: true })).toBe('of Pokémon!');
  });

  it('leaves other words alone', () => {
    expect(fixPokeWords('poker pokes Pokemons')).toBe('poker pokes Pokemons');
    expect(fixPokeWords('a spoke mon')).toBe('a spoke mon');
  });

  it('maps the PK MN ligature', () => {
    for (const t of ['PkMn', 'PkMr', 'PKMN', 'Pk Mn', 'PKMR']) expect(fixPkMn(t), t).toBe('PkMn');
    expect(cleanLine('PkMr', { kind: 'menu' })).toBe('PkMn');
    expect(fixPkMn('PKMN TRAINER')).toBe('PkMn TRAINER');
  });
});

describe('normalizeCase (OCR-18)', () => {
  it('upper-cases mostly-uppercase tokens', () => {
    expect(normalizeCase('PIKAchU')).toBe('PIKACHU');
    expect(normalizeCase('SAvE')).toBe('SAVE');
    // the games draw the é of POKé small even in all-caps text
    expect(normalizeCase('POKéDEx')).toBe('POKéDEX');
    expect(normalizeCase('POKé')).toBe('POKé');
  });

  it('upper-cases tokens with a capital after a lowercase letter', () => {
    expect(normalizeCase('PikAchu')).toBe('PIKACHU');
    expect(normalizeCase('OpTion')).toBe('OPTION');
    expect(normalizeCase('Spiel SIcheRn?')).toBe('Spiel SICHERN?');
  });

  it('keeps normal words, short tokens, plurals of acronyms and ß', () => {
    expect(normalizeCase('Hello there, PROF. OAK')).toBe('Hello there, PROF. OAK');
    expect(normalizeCase('OK TV PCs iPhone')).toBe('OK TV PCs iPhone');
    expect(normalizeCase("OAK's lab")).toBe("OAK's lab");
    expect(normalizeCase('STRAße')).toBe('STRAßE');
  });

  it('upper-cases stragglers in an all-caps menu', () => {
    expect(normalizeMenuCase(['POKéDEX', 'Option', 'SAVE', 'EXIT'])).toEqual(['POKéDEX', 'OPTION', 'SAVE', 'EXIT']);
    expect(normalizeMenuCase(['PkMn', 'FIGHT', 'Item'])).toEqual(['PkMn', 'FIGHT', 'ITEM']);
    expect(normalizeMenuCase(['New game', 'Continue', 'OPTIONS'])).toEqual(['New game', 'Continue', 'OPTIONS']);
  });
});

describe('mergeSplitLetters', () => {
  it('joins a split letter when the word is known', () => {
    expect(mergeSplitLetters('Figh t', { lang: 'en' })).toBe('Fight');
    expect(mergeSplitLetters('Would you like t o SAVE', { lang: 'en' })).toBe('Would you like to SAVE');
    expect(mergeSplitLetters('Figh t!', { lang: 'en' })).toBe('Fight!');
  });

  it('keeps real words and unknown joins apart', () => {
    expect(mergeSplitLetters('I like it a lot', { lang: 'en' })).toBe('I like it a lot');
    expect(mergeSplitLetters('Pikachu y Bulbasaur', { lang: 'es' })).toBe('Pikachu y Bulbasaur');
    expect(mergeSplitLetters('Plan B now', { lang: 'en' })).toBe('Plan B now');
  });

  it('accepts a custom known-word check (e.g. a speller)', () => {
    expect(mergeSplitLetters('Hous e', { isKnown: (w) => w === 'House' })).toBe('House');
  });

  it('joins letter-spaced menu words, not dialog', () => {
    expect(mergeSplitLetters('K A U FE N', { kind: 'menu' })).toBe('KAUFEN');
    expect(mergeSplitLetters('B A G', { kind: 'menu' })).toBe('BAG');
    expect(mergeSplitLetters('I AM A', { kind: 'dialog' })).toBe('I AM A');
  });
});

describe('repairSpacing and digits', () => {
  it('turns glued commas into spaces and keeps decimals', () => {
    expect(repairSpacing('Hallo,Welt')).toBe('Hallo Welt');
    expect(repairSpacing('Oh!,wait')).toBe('Oh! wait');
    expect(repairSpacing('Price 1,50 now')).toBe('Price 1,50 now');
    expect(repairSpacing('Yes,1 more')).toBe('Yes, 1 more');
  });

  it('removes stray spaces before closing punctuation except French', () => {
    expect(repairSpacing('Ein wildes TAUBSI erscheint !')).toBe('Ein wildes TAUBSI erscheint!');
    expect(repairSpacing('Daten auf .')).toBe('Daten auf.');
    expect(repairSpacing('EICH : Hallo')).toBe('EICH: Hallo');
    expect(repairSpacing('Bonjour !', { lang: 'fr' })).toBe('Bonjour !');
  });

  it('fixes digits inside words', () => {
    expect(fixDigitsInWords('a1 mundo')).toBe('al mundo');
    expect(fixDigitsInWords('he1lo w0rld')).toBe('hello world');
    expect(fixDigitsInWords('P0KéMON')).toBe('POKéMON');
    expect(fixDigitsInWords('Lv1 1st 100')).toBe('Lv1 1st 100');
  });
});

describe('fixInvertedPunctuation (es)', () => {
  it('repairs ¡ and ¿ read as i, !, | or l', () => {
    expect(fixInvertedPunctuation('Hola! iBienvenido al mundo!')).toBe('Hola! ¡Bienvenido al mundo!');
    expect(fixInvertedPunctuation('!Hola!')).toBe('¡Hola!');
    expect(fixInvertedPunctuation('iQué tal?')).toBe('¿Qué tal?');
    expect(fixInvertedPunctuation('|Cuídalo!')).toBe('¡Cuídalo!');
  });

  it('adds dropped opening marks to sentences that start mid-line', () => {
    expect(fixInvertedPunctuation('Hola! Bienvenido!')).toBe('Hola! ¡Bienvenido!');
    expect(fixInvertedPunctuation('Usó Placaje. Es muy eficaz!')).toBe('Usó Placaje. ¡Es muy eficaz!');
    expect(fixInvertedPunctuation('Hola!', { sentenceStart: true })).toBe('¡Hola!');
  });

  it('leaves continuations and abbreviations alone', () => {
    expect(fixInvertedPunctuation('POKéMON!')).toBe('POKéMON!');
    expect(fixInvertedPunctuation('El PROF. OAK te espera!')).toBe('El PROF. OAK te espera!');
    expect(fixInvertedPunctuation('Hola! Bienvenido al mundo de los')).toBe('Hola! Bienvenido al mundo de los');
  });

  it('only runs for Spanish in cleanLine', () => {
    expect(cleanLine('Hola! iBienvenido', { lang: 'es' })).toBe('Hola! ¡Bienvenido');
    expect(cleanLine('Say iHello', { lang: 'en' })).toBe('Say iHello');
  });
});

describe('cleanLine end to end (real engine output)', () => {
  const cases = [
    ['† Figh t', { kind: 'menu' }, 'Fight'],
    ['Wild PIDGEY appeared! T', { isLastLine: true }, 'Wild PIDGEY appeared!'],
    ['Ein Wildes TAUBSI erscheint !', { lang: 'de', isLastLine: true }, 'Ein Wildes TAUBSI erscheint!'],
    ['Möchtest du das Spiel SIcheRn?', { lang: 'de' }, 'Möchtest du das Spiel SICHERN?'],
    ['Vorsicht! Im Gras lauern POkéMoN!', { lang: 'de' }, 'Vorsicht! Im Gras lauern POKéMON!'],
    ['Would you like t o SAVE the game?', {}, 'Would you like to SAVE the game?'],
    ['Aquf está tu POKéMON. iCufdalo!', { lang: 'es' }, 'Aquf está tu POKéMON. ¡Cufdalo!'],
    ['PIDGEY :L3', { kind: 'label' }, 'PIDGEY'],
    ['  Hello   there!  ', {}, 'Hello there!'],
    ['Hello\u0000 □ there', {}, 'Hello there']
  ];
  for (const [input, opts, out] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(out)}`, () => expect(cleanLine(input, opts)).toBe(out));
  }

  it('returns an empty string for empty input', () => {
    expect(cleanLine('')).toBe('');
    expect(cleanLine(null)).toBe('');
  });
});

describe('helpers and vocabulary', () => {
  it('counts letters and digits', () => {
    expect(letterCount('POKéMON 12!')).toBe(7);
    expect(alnumCount('POKéMON 12!')).toBe(9);
  });

  it('detects all-caps menu words', () => {
    expect(isCapsish('POKéDEX')).toBe(true);
    expect(isCapsish('PkMn')).toBe(true);
    expect(isCapsish('FIGHT PkMn')).toBe(true);
    expect(isCapsish('Fight')).toBe(false);
  });

  it('knows game and common words, case- and accent-insensitively', () => {
    expect(isKnownWord('fight', 'en')).toBe(true);
    expect(isKnownWord('POKEMON', 'de')).toBe(true);
    expect(isKnownWord('Hyperball', 'de')).toBe(true);
    expect(isKnownWord('to', 'en')).toBe(true);
    expect(isKnownWord('zzz', 'en')).toBe(false);
    expect(isKnownWord('fight', 'xx')).toBe(false);
    expect(wordKey('Pokémon')).toBe('pokemon');
  });

  it('lists game words for the speller in written and lowercase form', () => {
    const de = gameWords('de');
    expect(de).toContain('Tackle');
    expect(de).toContain('tackle');
    expect(de).toContain('Haustiere');
    expect(de).toContain('POKéMON');
    expect(gameWords('xx')).toContain('Pokémon');
  });
});

describe('review fixes', () => {
  it('drops the arrow alone on the bottom row of a one-line page', () => {
    expect(stripArrow('T')).toBe('');
    expect(stripArrow('v')).toBe('');
    expect(stripArrow('L.')).toBe('');
    expect(stripArrow('T', { isLastLine: false })).toBe('T');
    expect(cleanLine('T', { kind: 'dialog', isLastLine: true })).toBe('');
  });

  it('reads a star glued to a word as "!"', () => {
    expect(stripArrow('Draußen im Gras ist es gefährlich*')).toBe('Draußen im Gras ist es gefährlich!');
  });

  it('keeps item names that start with HP', () => {
    expect(stripHudTokens('HP UP')).toBe('HP UP');
    expect(cleanLine('HP UP', { kind: 'menu' })).toBe('HP UP');
    expect(stripHudTokens('HP:19/20')).toBe('');
    expect(stripHudTokens('HP 19/ 20')).toBe('');
    expect(stripHudTokens('TORCHIC HP')).toBe('TORCHIC');
  });

  it('does not add an opening mark when one opens mid-sentence', () => {
    expect(fixInvertedPunctuation('Oye, ¿quieres luchar?', { sentenceStart: true })).toBe('Oye, ¿quieres luchar?');
    expect(fixInvertedPunctuation('Vale. Oye, ¡qué bien!')).toBe('Vale. Oye, ¡qué bien!');
    expect(fixInvertedPunctuation('Vale. Qué bien!')).toBe('Vale. ¡Qué bien!');
  });

  it('joins a menu word split in two, but never two dialog words', () => {
    expect(cleanLine('Ne In', { kind: 'menu', lang: 'de' })).toBe('NEIN');
    expect(mergeSplitLetters('MEISTER BALL', { kind: 'menu', lang: 'de' })).toBe('MEISTERBALL');
    // both halves are listed words: an item name of two words
    expect(mergeSplitLetters('POKé BALL', { kind: 'menu', lang: 'en' })).toBe('POKé BALL');
    expect(mergeSplitLetters('Ich will kommen', { kind: 'dialog', lang: 'de' })).toBe('Ich will kommen');
  });

  it('strips border decorations around labels and stray quotes in dialog', () => {
    expect(cleanLine('\'- *" Route 101 "* \'', { kind: 'label' })).toBe('Route 101');
    expect(cleanLine('"FLEMMLI', { kind: 'label' })).toBe('FLEMMLI');
    expect(cleanLine('$3000', { kind: 'label' })).toBe('$3000');
    expect(cleanLine('TSCHÜSS!', { kind: 'menu' })).toBe('TSCHÜSS!');
    expect(cleanLine('\' Hello there! Glad to meet you!', { kind: 'dialog' })).toBe('Hello there! Glad to meet you!');
    expect(cleanLine('"Hi!" he said.', { kind: 'dialog' })).toBe('"Hi!" he said.');
  });

  it('drops the arrow glued to the last word when the word without it is known', () => {
    expect(cleanLine('Bienvenue dans le monde desv', { kind: 'dialog', isLastLine: true, lang: 'fr' }))
      .toBe('Bienvenue dans le monde des');
    expect(cleanLine('Welcome to theT', { kind: 'dialog', isLastLine: true })).toBe('Welcome to the');
    // all-caps words and real words stay
    expect(cleanLine('I HIT', { kind: 'dialog', isLastLine: true })).toBe('I HIT');
    expect(cleanLine('Please wait', { kind: 'dialog', isLastLine: true })).toBe('Please wait');
    expect(cleanLine('monde desv', { kind: 'dialog', isLastLine: false, lang: 'fr' })).toBe('monde desv');
  });

  it('strips a blurred cursor read as "L" before an all-caps entry', () => {
    expect(stripCursor('L YES')).toBe('YES');
    expect(stripCursor('L Pokémon')).toBe('L Pokémon');
  });

  it('keeps the small é of POKé when upper-casing', () => {
    expect(normalizeMenuCase(['KAMPF', 'Poké', 'ITEM', 'FLUCHT'])).toEqual(['KAMPF', 'POKé', 'ITEM', 'FLUCHT']);
  });

  it('uses no regex lookbehind (Safari before 16.4 cannot parse it)', () => {
    const src = readFileSync(new URL('../../src/core/ocr/lexicon.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\(\?<[=!]/u);
  });
});
