// One table for everything language-specific: names, script and direction,
// which OCR engine can read the game text, and the codes each external
// service expects. Option labels are text only (no flag emoji: Windows shows
// flags as letter pairs and screen readers announce them before every name).

const T = (code, name, endonym, script, ocr, tess, extra = {}) => ({
  code,
  name,
  endonym,
  script,
  dir: extra.dir || 'ltr',
  ocr,
  tess,
  hunspell: !!extra.hunspell,
  google: extra.google || code,
  tts: extra.tts || [code]
});

// ocr: 'neural' = bundled Latin recogniser; 'tesseract' = traineddata per script.
export const LANGUAGES = Object.freeze([
  T('ar', 'Arabic', 'العربية', 'arabic', 'tesseract', 'ara', { dir: 'rtl' }),
  T('zh', 'Chinese', '中文', 'han', 'tesseract', 'chi_sim', { google: 'zh-CN', tts: ['zh', 'cmn', 'yue'] }),
  T('cs', 'Czech', 'Čeština', 'latin', 'neural', 'ces'),
  T('da', 'Danish', 'Dansk', 'latin', 'neural', 'dan'),
  T('nl', 'Dutch', 'Nederlands', 'latin', 'neural', 'nld'),
  T('en', 'English', 'English', 'latin', 'neural', 'eng', { hunspell: true }),
  T('fi', 'Finnish', 'Suomi', 'latin', 'neural', 'fin'),
  T('fr', 'French', 'Français', 'latin', 'neural', 'fra', { hunspell: true }),
  T('de', 'German', 'Deutsch', 'latin', 'neural', 'deu', { hunspell: true }),
  T('el', 'Greek', 'Ελληνικά', 'greek', 'tesseract', 'ell'),
  // Google still uses the retired code 'iw'; some voices report it too
  T('he', 'Hebrew', 'עברית', 'hebrew', 'tesseract', 'heb', { dir: 'rtl', google: 'iw', tts: ['he', 'iw'] }),
  T('hi', 'Hindi', 'हिन्दी', 'devanagari', 'tesseract', 'hin'),
  T('hu', 'Hungarian', 'Magyar', 'latin', 'neural', 'hun'),
  // older Android voices report Indonesian as 'in'
  T('id', 'Indonesian', 'Bahasa Indonesia', 'latin', 'neural', 'ind', { tts: ['id', 'in'] }),
  T('it', 'Italian', 'Italiano', 'latin', 'neural', 'ita', { hunspell: true }),
  T('ja', 'Japanese', '日本語', 'japanese', 'tesseract', 'jpn'),
  T('ko', 'Korean', '한국어', 'hangul', 'tesseract', 'kor'),
  // platforms ship Norwegian voices as Bokmål (nb) or Nynorsk (nn)
  T('no', 'Norwegian', 'Norsk', 'latin', 'neural', 'nor', { tts: ['nb', 'nn', 'no'] }),
  T('pl', 'Polish', 'Polski', 'latin', 'neural', 'pol'),
  T('pt', 'Portuguese', 'Português', 'latin', 'neural', 'por'),
  T('ro', 'Romanian', 'Română', 'latin', 'neural', 'ron'),
  T('ru', 'Russian', 'Русский', 'cyrillic', 'tesseract', 'rus'),
  T('es', 'Spanish', 'Español', 'latin', 'neural', 'spa', { hunspell: true }),
  T('sv', 'Swedish', 'Svenska', 'latin', 'neural', 'swe'),
  T('th', 'Thai', 'ไทย', 'thai', 'tesseract', 'tha'),
  T('tr', 'Turkish', 'Türkçe', 'latin', 'neural', 'tur'),
  T('uk', 'Ukrainian', 'Українська', 'cyrillic', 'tesseract', 'ukr'),
  T('vi', 'Vietnamese', 'Tiếng Việt', 'latin', 'neural', 'vie')
].map((l) => Object.freeze({ ...l, tts: Object.freeze(l.tts) })));

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

// Codes other systems use for our languages (BCP 47 variants, retired ISO codes).
const ALIASES = { iw: 'he', in: 'id', nb: 'no', nn: 'no', cmn: 'zh', yue: 'zh', fil: null };

export function isLang(code) {
  return typeof code === 'string' && BY_CODE.has(code);
}

export function langInfo(code) {
  return BY_CODE.get(code) || null;
}

export function langName(code) {
  if (code == null || code === '') return '';
  const l = BY_CODE.get(code);
  return l ? l.name : 'Unknown language';
}

export function endonym(code) {
  const l = BY_CODE.get(code);
  return l ? l.endonym : '';
}

export function dirFor(code) {
  const l = BY_CODE.get(code);
  return l ? l.dir : 'ltr';
}

export function ocrSupport(code) {
  const l = BY_CODE.get(code);
  return l ? l.ocr : 'none';
}

export function tessCode(code) {
  const l = BY_CODE.get(code);
  return l ? l.tess : null;
}

export function googleCode(code) {
  const l = BY_CODE.get(code);
  return l ? l.google : code;
}

export function ttsAliases(code) {
  const l = BY_CODE.get(code);
  return l ? l.tts : [code];
}

// Scripts written without spaces between words: joins and word splitting differ.
export function usesSpaces(code) {
  const l = BY_CODE.get(code);
  return !l || !['japanese', 'han', 'thai'].includes(l.script);
}

// Map any BCP 47 tag ('de-DE', 'zh-Hant-TW', 'iw', 'nb_NO') to one of our codes, or null.
export function fromAnyCode(tag) {
  if (typeof tag !== 'string' || !tag) return null;
  const primary = tag.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (BY_CODE.has(primary)) return primary;
  return Object.prototype.hasOwnProperty.call(ALIASES, primary) ? ALIASES[primary] : null;
}

// Best "Translate into" suggestion from the browser's languages, avoiding the game language.
export function suggestTarget(exclude = null, languages = globalThis.navigator?.languages || []) {
  for (const tag of languages) {
    const code = fromAnyCode(tag);
    if (code && code !== exclude) return code;
  }
  return exclude === 'en' ? 'de' : 'en';
}
