// Text clean-up for OCR lines read from game screens (pure, synchronous).
//
// The neural engine reads pixel fonts well, but game screens add glyphs
// that are not text (the blinking ▼ "more" arrow, the ▶ menu cursor, HP
// and level plates) and the PK/MN and é tiles that no recogniser knows.
// Every rule here is a narrow pattern repair seen in real engine output
// (OCR-02, OCR-08, OCR-16, OCR-18): a missed repair costs a little, a wrong
// "repair" poisons translations, cards and the dictionary.
//
// No regex lookbehind: Safari before 16.4 rejects it (the bundler turns
// such literals into RegExp calls that throw when the module loads). A word
// start is matched as (^|[^\p{L}\p{N}]) and put back instead.

import { isKnownWord } from './vocab.js';

const LETTER = /\p{L}/gu;
const ALNUM = /[\p{L}\p{N}]/gu;

export function letterCount(s) {
  return (String(s || '').match(LETTER) || []).length;
}

export function alnumCount(s) {
  return (String(s || '').match(ALNUM) || []).length;
}

function isUpper(ch) {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

// Uppercase share of the letters, ignoring the é of POKé (the game font
// draws it lowercase inside otherwise all-caps words) and counting the
// PkMn ligature as caps.
function upperRatio(s) {
  const letters = String(s || '').replace(/POKé/gu, 'POKE').replace(/PkMn/gu, 'PKMN').match(LETTER) || [];
  if (!letters.length) return 0;
  return letters.filter(isUpper).length / letters.length;
}

// "POKéDEX", "KAMPF", "PkMn" count as all-caps menu words.
export function isCapsish(s) {
  const t = String(s || '');
  return letterCount(t) > 0 && upperRatio(t) >= 0.85;
}

// ▶/▷ menu cursor read as a glyph or letter in front of the entry
// ("† Figh t", "I Fight", "• Pokédex", "7 ITEM"). Menus only: in dialog a
// leading "I" is the English pronoun.
export function stripCursor(text) {
  return String(text || '')
    .replace(/^[†‡•·▶►▸▹▷>|*»]+\s*/u, '')
    .replace(/^[7Il1]\s+(?=\p{Lu})/u, '')
    .replace(/^L\s+(?=\p{Lu}{2})/u, ''); // a blurred ▶ ("L YES")
}

// The ▼ "more" arrow (blinking in Gen 1/2, bouncing in Gen 3) read as "+",
// "▼", "T", "v" or "†" at the end of the text.
export function stripArrow(text, { isLastLine = true } = {}) {
  let s = String(text || '');
  s = s.replace(/\s*[+▼▾▽↓]+$/u, '');
  // a dagger or star glued to a word is "!" (or "!" plus the arrow) misread
  s = s.replace(/(\p{L})[†‡*]$/u, '$1!');
  s = s.replace(/\s*[†‡]$/u, '');
  if (isLastLine) {
    // (a still, unblinking arrow also comes back as "r" or "*")
    s = s.replace(/\s+[TVvr>*]$/u, '');
    s = s.replace(/([!?.…])[TVvr*]$/u, '$1');
    // the arrow alone on the bottom row (a one-line page): no line is just this
    if (/^(?:[TVvr>*]|L\.)$/u.test(s.trim())) s = '';
  }
  return s;
}

// Box borders and decorations read as symbols around a label or menu item
// ('- *" Route 101 "* '), and a quote standing apart from the words of a
// dialog line ("' Hello there!"). Real quotes touch their word; currency
// signs and closing punctuation stay.
export function stripEdgeJunk(text, { kind = 'dialog' } = {}) {
  const s = String(text || '');
  if (kind === 'dialog') return s.replace(/^["'“”‘’`´„]+\s+/u, '').replace(/\s+["'“”‘’`´]+$/u, '');
  return s.replace(/^[^\p{L}\p{N}¡¿$¥€£(]+/u, '').replace(/[^\p{L}\p{N}!?.…%)]+$/u, '');
}

// The arrow glued to the last word of a page ("monde desv", "desT"): drop
// it when the word without it is listed and the word with it is not. Only
// after a lowercase letter - in all-caps text "HIT" is a word.
function stripGluedArrow(s, known) {
  const m = /(?:^|\s)(\p{L}*\p{Ll})([vVT])$/u.exec(s);
  if (!m || m[1].length < 2 || !known(m[1]) || known(m[1] + m[2])) return s;
  return s.slice(0, -1);
}

const HUD_PATTERNS = [
  /^:?\s?L\s?\d{1,3}$/u,          // ":L3", ": L5"
  /^:\s?L$/u,
  /^H[PF]\s?[:.'’]?$/u,           // "HP", "HP:", "HF." (HP misread)
  /^\d{1,3}\s?\/?\s?\d{0,3}$/u,   // "192", "19/", "19/ 20"
  /^Lv\.?\s?\d{1,3}$/iu,          // "Lv5", "Lv. 12"
  /^[:;.\s]+$/u
];

// Battle HUD fragments: level and HP plates, HP numbers.
export function isHudToken(text) {
  const t = String(text || '').trim();
  return !!t && HUD_PATTERNS.some((re) => re.test(t));
}

// Remove HUD fragments inside a line ("PIDGEY :L3" -> "PIDGEY",
// "POOCHYENALv2" -> "POOCHYENA"). Standalone numbers stay ("ROUTE 101").
export function stripHudTokens(text) {
  return String(text || '')
    .replace(/(\p{Lu}{2})\s?:\s?L\s?\d{1,3}(?=\s|$)/gu, '$1 ')
    .replace(/(\p{Lu}{2})Lv\.?\s?\d{1,3}(?=\s|$)/gu, '$1 ')
    .replace(/(^|\s):?\s?L\s?\d{1,3}(?=\s|$)/gu, ' ')
    .replace(/(^|\s)Lv\.?\s?\d{1,3}(?=\s|$)/giu, ' ')
    // "HP:" anywhere, a bare "HP" only before numbers or at the end: the
    // item "HP UP" keeps its name
    .replace(/(^|\s)H[PF](?:\s?[:.'’](?=\s|\d|$)|(?=\s*(?:\d|$)))/gu, ' ')
    .replace(/(^|\s)\d{1,3}\s?\/\s?\d{1,3}(?=\s|$)/gu, ' ')
    .replace(/(^|\s)\d{1,3}\s?\/(?=\s|$)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

// Suffixes written without a space in the games (POKéMON, POKéDEX); the
// others keep whatever spacing was read (POKé BALL, POKé MART).
const POKE_JOINED = new Set(['mon', 'dex', 'gear', 'nav', 'com', 'block']);
// (Tesseract reads the bold pixel P as F and é as &, £ or €: "FOK&MON")
const POKE_RE = /(^|[^\p{L}\p{N}])(pok|fok)([eéèēbo0ÉÈĒ&£€]?)(\s?)(mon|dex|gear|nav|com|balls|ball|mart|center|centre|flute|doll|block)(?![\p{L}\p{N}])/giu;

// The PK and MN ligature tiles ("PkMr", "PKMN", "Pk Mn").
export function fixPkMn(text) {
  return String(text || '').replace(/(^|[^\p{L}\p{N}])P\s?[kK]\s?M\s?[nNrR](?![\p{L}\p{N}])/gu, '$1PkMn');
}

// Canonical POKé spellings (OCR-16). Case-insensitive and tolerant of a
// missing or misread é and of a space before the suffix. All-caps text
// gets the Gen 1-3 "POKé" form, anything else "Poké".
export function fixPokeWords(text) {
  let s = String(text || '');
  // "Pokémoni" at the end of a line: the "!" read as "i"/"l" (OCR-02)
  s = s.replace(/(^|[^\p{L}\p{N}])(pok[eéèēbo0ÉÈĒ]?\s?mon)[il1|]$/iu, '$1$2!');
  s = s.replace(POKE_RE, (m, pre, pok, e, sp, suffix) => {
    const caps = upperRatio(pok + suffix) >= 0.5;
    const low = suffix.toLowerCase();
    const space = POKE_JOINED.has(low) ? '' : sp;
    if (caps) return pre + 'POKé' + space + suffix.toUpperCase();
    const tail = suffix === suffix.toUpperCase() ? low : suffix;
    return pre + 'Poké' + space + tail;
  });
  return fixPkMn(s);
}

// "!" read as "l" (or "1", "I", "|") at the end of a word before the next
// sentence or the line end: "Hello therel Welcome" -> "there!". Only when
// the word without it is listed and the word with it is not, and the stem
// has 4+ letters: the vocabulary is short, and "Quel", "dal", "sul" are
// words whose short stems are listed.
export function fixBangMisread(text, { lang = 'en', isKnown } = {}) {
  const known = isKnown || ((w) => isKnownWord(w, lang));
  return String(text || '').replace(/(^|[^\p{L}\p{N}])(\p{L}{4,})[l1I|](?=\s+[\p{Lu}¡¿"“„]|$)/gu, (m, pre, stem) => {
    const last = m.slice(-1);
    return known(stem) && !known(stem + last) ? `${pre}${stem}!` : m;
  });
}

// Abbreviations whose full stop does not end a sentence ("PROF. OAK").
export const ABBREVIATION = /(?:^|[\s(])(?:prof|dr|mr|mrs|ms|st|sr|sra|srta|hr|fr|mme|mlle|m|sig|ca|bzw|usw|vs|etc|[a-z])\.$/iu;

// The first sentence-ending ! or ? after `from` ('' when none).
function nextMark(s, from) {
  const m = /[!?]/u.exec(s.slice(from));
  return m ? m[0] : '';
}

// Spanish ¡ and ¿ (not in the recogniser's alphabet) come back as "i",
// "!", "|" or "l" glued to the next word: "iBienvenido" -> "¡Bienvenido".
// Sentences that start mid-line and end in ! or ? get the opening mark
// when it was dropped. The first sentence of a line only when the caller
// knows it starts there (the previous line ended a sentence).
export function fixInvertedPunctuation(text, { sentenceStart = false } = {}) {
  let s = String(text || '');
  s = s.replace(/(^|[\s"“«(])[i!|lI1?](?=\p{Lu}\p{Ll})/gu, (m, pre, off) => {
    return pre + (nextMark(s, off + m.length) === '?' ? '¿' : '¡');
  });
  // insert dropped opening marks, scanning sentence starts right to left so
  // earlier offsets stay valid
  const starts = [];
  if (sentenceStart) starts.push(0);
  const re = /[.!?…]+\s+/gu;
  let m;
  while ((m = re.exec(s))) {
    if (m[0].startsWith('.') && ABBREVIATION.test(s.slice(0, m.index + 1))) continue;
    starts.push(m.index + m[0].length);
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    const at = starts[i];
    if (!/^\p{Lu}/u.test(s.slice(at))) continue;
    const end = /[.!?…]/u.exec(s.slice(at));
    if (!end || (end[0] !== '!' && end[0] !== '?')) continue;
    // the mark can open mid-sentence: "Oye, ¿quieres luchar?"
    if (/[¡¿]/u.test(s.slice(at, at + end.index))) continue;
    s = s.slice(0, at) + (end[0] === '!' ? '¡' : '¿') + s.slice(at);
  }
  return s;
}

// Capital umlauts and accented capitals squeezed into an 8×8 tile (Ö drawn
// as a small O with dots above) are read as lowercase: "nicht! öffne". Game
// text starts its sentences with a capital, so a lowercase accented letter
// right after a sentence end (or at a known sentence start) is a misread
// capital. Plain letters are left alone, and so is text after an ellipsis
// or an abbreviation ("z.B. über").
const SQUASHED = /^[äöüàáâèéêëìíîïòóôùúûñç]/u;
export function capitalizeSentenceStarts(text, { sentenceStart = false } = {}) {
  let s = String(text || '');
  const upAt = (i) => {
    if (SQUASHED.test(s.slice(i))) s = s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
  };
  if (sentenceStart) upAt(/^[^\p{L}\p{N}]*/u.exec(s)[0].length);
  const re = /(^|[^.])([.!?]|[!?]{2,3})["'”’»)]*\s+[¡¿"“„«(]*/gu;
  let m;
  while ((m = re.exec(s))) {
    const head = s.slice(0, m.index + m[0].indexOf('.') + 1);
    if (m[2] === '.' && (ABBREVIATION.test(head) || /\p{L}\.\p{L}\.$/u.test(head))) continue;
    upAt(m.index + m[0].length);
  }
  return s;
}

// Uppercase that keeps ß (its uppercase "SS" would change the length) and
// the small é of POKé, which the all-caps games always draw lowercase.
function upper(s) {
  return s.replace(/[^ß]+/gu, (p) => p.toUpperCase()).replace(/POKÉ/gu, 'POKé');
}

function fixTokenCase(part) {
  const letters = part.match(LETTER) || [];
  if (letters.length < 3) return part;
  const up = letters.filter(isUpper).length;
  if (up === letters.length || up === 0) return part;
  if (/^\p{Lu}{2,}s$/u.test(part)) return part;          // "PCs", "TMs"
  if (up / letters.length >= 0.5) return upper(part);    // "PIKAchU", "SAvE"
  // an uppercase letter right after a lowercase one inside a word does not
  // happen in game text: "PikAchu", "OpTion", "SIcheRn" are caps misreads
  if (up >= 2 && letters.length >= 4 && /\p{Ll}\p{Lu}/u.test(part)) return upper(part);
  return part;
}

// Mixed-case misreads of all-caps pixel text (OCR-18). Possessives and
// elisions are handled per part ("OAK's", "l'ATTAQUE").
export function normalizeCase(text) {
  return String(text || '').split(/(\s+)/u).map((tok) => {
    if (!tok || /^\s+$/u.test(tok)) return tok;
    return tok.split(/(['’])/u).map((p) => (p === "'" || p === '’' ? p : fixTokenCase(p))).join('');
  }).join('');
}

// In a menu whose items are mostly all-caps, the stragglers are misreads
// ("Option" between "SAVE" and "EXIT").
export function normalizeMenuCase(items) {
  const wordy = items.filter((t) => letterCount(t) >= 2);
  if (wordy.length < 2) return items;
  const caps = wordy.filter(isCapsish).length;
  if (caps / wordy.length < 0.6) return items;
  return items.map((t) => (t === 'PkMn' || isCapsish(t) ? t : upper(t)));
}

// Split a token into leading punctuation, letters and trailing punctuation.
function parts(tok) {
  const m = /^([^\p{L}]*)(\p{L}+)([^\p{L}]*)$/u.exec(tok);
  return m ? { lead: m[1], core: m[2], trail: m[3] } : null;
}

// Letters the engine split apart: "Figh t" -> "Fight", "t o" -> "to"
// (only when the joined word is known and the pieces are not both words),
// letter-spaced menu words "K A U FE N" -> "KAUFEN", and split menu words
// "Ne In" -> "NeIn" (normalizeCase then makes it "NEIN").
export function mergeSplitLetters(text, { lang = 'en', isKnown, kind = 'dialog' } = {}) {
  const known = isKnown || ((w) => isKnownWord(w, lang));
  const toks = String(text || '').split(/\s+/u).filter(Boolean);
  if (!toks.length) return '';
  if (kind !== 'dialog' && toks.length >= 3) {
    const short = toks.every((t) => /^\p{L}{1,2}$/u.test(t));
    const singles = toks.filter((t) => t.length === 1).length;
    if (short && singles / toks.length >= 0.6) return toks.join('');
  }
  let changed = true;
  while (changed && toks.length > 1) {
    changed = false;
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = parts(toks[i]);
      const b = parts(toks[i + 1]);
      if (!a || !b || a.trail || b.lead) continue;
      // dialog only re-joins a lone letter: two real words can form a listed
      // one ("will kommen" vs "willkommen"); a menu item is a single word
      if (kind === 'dialog' && a.core.length !== 1 && b.core.length !== 1) continue;
      const merged = a.core + b.core;
      if (!known(merged)) continue;
      if (known(a.core) && known(b.core)) continue;
      toks.splice(i, 2, a.lead + merged + b.trail);
      changed = true;
      break;
    }
  }
  return toks.join(' ');
}

// Pixel fonts read spaces as commas, and glued commas appear everywhere.
// Real game text always has a space after sentence punctuation; decimals
// like "1,50" are digit-digit. A comma read inside a known word (the GBA
// font's wide "n j" gap: "Bon,jour") is dropped instead. Also drops the
// stray space OCR puts before closing punctuation ("erscheint !"), except
// in French where it is the typographic norm before ! ? ; :.
export function repairSpacing(text, { lang, isKnown } = {}) {
  const known = isKnown || (lang ? (w) => isKnownWord(w, lang) : null);
  let s = String(text || '');
  // (two words that also form one, "in,to", keep the space: it may be one)
  if (known) s = s.replace(/(\p{L}+),(\p{L}+)/gu, (m, a, b) => (known(a + b) && !(known(a) && known(b)) ? a + b : m));
  s = s
    .replace(/([?.!…]),(?=\S)/gu, '$1 ')
    .replace(/(\d),(?=\p{L})/gu, '$1 ')
    .replace(/(\p{L}),(?=\p{L})/gu, '$1 ')
    .replace(/,(?=\S)/gu, (m, i, str) => (/\d/u.test(str[i - 1] || '') && /\d/u.test(str[i + 1] || '') ? ',' : ', '));
  s = lang === 'fr'
    ? s.replace(/(\S)\s+([.,…])(?=\s|$)/gu, '$1$2')
    : s.replace(/(\S)\s+([.,!?;:…])(?=\s|$)/gu, '$1$2');
  return s.replace(/\s{2,}/gu, ' ');
}

// Digits read inside words: "a1 mundo" -> "al mundo", "he1lo" -> "hello".
export function fixDigitsInWords(text) {
  return String(text || '')
    .replace(/(\p{Ll})1(?=\p{Ll})/gu, '$1l')
    .replace(/(^|[^\p{L}\p{N}])(\p{Ll}+)1(?=\s+\p{Ll})/gu, '$1$2l')
    .replace(/(\p{Ll})0(?=\p{Ll})/gu, '$1o')
    .replace(/(\p{Lu})0(?=\p{Lu})/gu, '$1O');
}

// Full clean-up of one line of text.
// kind: 'dialog' | 'menu' | 'label' (menus strip the cursor, non-dialog
// lines lose HUD fragments). isLastLine: the line the ▼ arrow follows.
// sentenceStart: the line begins a new sentence (Spanish ¡/¿ insertion).
export function cleanLine(text, { kind = 'dialog', isLastLine = false, lang = 'en', isKnown, sentenceStart = false } = {}) {
  let s = String(text || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\ufffd□■◻◼]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!s) return '';
  if (kind === 'menu') s = stripCursor(s);
  s = stripArrow(s, { isLastLine: isLastLine && kind === 'dialog' });
  if (kind !== 'dialog') s = stripHudTokens(s);
  s = stripEdgeJunk(s, { kind });
  if (isLastLine && kind === 'dialog') s = stripGluedArrow(s, isKnown || ((w) => isKnownWord(w, lang)));
  if (kind === 'dialog') s = fixBangMisread(s, { lang, isKnown });
  s = repairSpacing(s, { lang, isKnown });
  s = fixDigitsInWords(s);
  s = mergeSplitLetters(s, { lang, isKnown, kind });
  s = normalizeCase(fixPkMn(s));
  s = fixPokeWords(s);
  if (lang === 'es') s = fixInvertedPunctuation(s, { sentenceStart });
  if (kind === 'dialog') s = capitalizeSentenceStarts(s, { sentenceStart });
  return s.replace(/\s+/gu, ' ').trim();
}
