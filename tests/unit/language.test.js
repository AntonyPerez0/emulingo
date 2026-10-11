import { describe, it, expect } from 'vitest';
import {
  LANGUAGES, langInfo, langName, dirFor, ocrSupport, isLang, fromAnyCode, googleCode, ttsAliases,
  tessCode, usesSpaces, suggestTarget, endonym
} from '../../src/core/language.js';

const NEURAL = ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'tr', 'sv', 'da', 'no', 'fi', 'cs', 'hu', 'ro', 'id', 'vi'];
const TESS = ['ja', 'zh', 'ko', 'ru', 'uk', 'el', 'he', 'ar', 'hi', 'th'];

describe('LANGUAGES', () => {
  it('has the 28 supported languages, each fully described', () => {
    expect(LANGUAGES).toHaveLength(28);
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(28);
    for (const l of LANGUAGES) {
      expect(l.code).toMatch(/^[a-z]{2}$/);
      expect(l.name).toBeTruthy();
      expect(l.endonym).toBeTruthy();
      expect(['ltr', 'rtl']).toContain(l.dir);
      expect(['neural', 'tesseract']).toContain(l.ocr);
      expect(l.tess).toMatch(/^[a-z_]{3,7}$/);
      expect(Array.isArray(l.tts) && l.tts.length).toBeTruthy();
      expect(typeof l.hunspell).toBe('boolean');
      expect(Object.isFrozen(l)).toBe(true);
    }
  });

  it('carries no flag emoji', () => {
    const text = JSON.stringify(LANGUAGES);
    expect(/[\u{1F1E6}-\u{1F1FF}]/u.test(text)).toBe(false);
  });

  it('routes Latin scripts to the neural engine and the rest to Tesseract', () => {
    for (const c of NEURAL) expect(ocrSupport(c)).toBe('neural');
    for (const c of TESS) expect(ocrSupport(c)).toBe('tesseract');
    expect(ocrSupport('xx')).toBe('none');
    expect(tessCode('zh')).toBe('chi_sim');
    expect(tessCode('es')).toBe('spa');
  });

  it('marks Hunspell dictionaries for de en fr es it only', () => {
    expect(LANGUAGES.filter((l) => l.hunspell).map((l) => l.code).sort()).toEqual(['de', 'en', 'es', 'fr', 'it']);
  });
});

describe('lookups', () => {
  it('names and directions', () => {
    expect(langName('de')).toBe('German');
    expect(langName('xx')).toBe('Unknown language');
    expect(langName(null)).toBe('');
    expect(langName('<img src=x>')).toBe('Unknown language');
    expect(endonym('ja')).toBe('日本語');
    expect(dirFor('he')).toBe('rtl');
    expect(dirFor('ar')).toBe('rtl');
    expect(dirFor('de')).toBe('ltr');
    expect(dirFor(undefined)).toBe('ltr');
    expect(langInfo('xx')).toBe(null);
    expect(isLang('de')).toBe(true);
    expect(isLang('DE')).toBe(false);
    expect(isLang({})).toBe(false);
  });

  it('maps service codes', () => {
    expect(googleCode('zh')).toBe('zh-CN');
    expect(googleCode('he')).toBe('iw');
    expect(googleCode('no')).toBe('no');
    expect(googleCode('de')).toBe('de');
    expect(ttsAliases('no')).toEqual(['nb', 'nn', 'no']);
    expect(ttsAliases('he')).toEqual(['he', 'iw']);
  });

  it('normalises any language tag to our codes', () => {
    expect(fromAnyCode('de-DE')).toBe('de');
    expect(fromAnyCode('nb_NO')).toBe('no');
    expect(fromAnyCode('iw')).toBe('he');
    expect(fromAnyCode('zh-Hant-TW')).toBe('zh');
    expect(fromAnyCode('in')).toBe('id');
    expect(fromAnyCode('lb')).toBe(null);
    expect(fromAnyCode('')).toBe(null);
  });

  it('knows which scripts use spaces', () => {
    expect(usesSpaces('de')).toBe(true);
    expect(usesSpaces('ko')).toBe(true);
    expect(usesSpaces('ja')).toBe(false);
    expect(usesSpaces('zh')).toBe(false);
    expect(usesSpaces('th')).toBe(false);
  });

  it('suggests a target from the browser languages', () => {
    expect(suggestTarget('de', ['de-DE', 'en-GB'])).toBe('en');
    expect(suggestTarget('ja', ['fr-CA'])).toBe('fr');
    expect(suggestTarget('en', ['en-US'])).toBe('de');
    expect(suggestTarget(null, [])).toBe('en');
  });
});

describe('LANGUAGES agree with the OCR engine and the spell checker', () => {
  it('flags Hunspell exactly for the languages with a bundled dictionary', async () => {
    const { DICTS, hasDictionary } = await import('../../src/core/ocr/correct.js');
    for (const l of LANGUAGES) expect(hasDictionary(l.code), l.code).toBe(l.hunspell);
    expect(Object.keys(DICTS).every(isLang)).toBe(true);
  });

  it('routes every language to a reader that matches its table entry', async () => {
    const { routeFor } = await import('../../src/core/ocr/engine.js');
    for (const l of LANGUAGES) {
      const r = routeFor(l.code);
      expect(r.tess, l.code).toBe(l.tess);
      if (l.ocr === 'neural') expect(r, l.code).toMatchObject({ kind: 'latin', rec: 'latin' });
      else expect(['cjk', 'tesseract'], l.code).toContain(r.kind);
    }
  });
});
