// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let t;

// Recorded from translate.googleapis.com (client=gtx, dt=t) on 2026-10-11.
const GTX_DE_EN = [[['A wild TAUBSI appears! ', 'Ein wildes TAUBSI erscheint! ', null, null, 3, null, null, [[]], [[['ad3d68f0fc47c8c7a84213b3d785dc3a', 'de_en_2023q1.md']]]], ['What should PIKACHU do?', 'Was soll PIKACHU tun?', null, null, 3, null, null, [[]], [[['ad3d68f0fc47c8c7a84213b3d785dc3a', 'de_en_2023q1.md']]]]], null, 'de', null, null, null, null, []];
const GTX_AUTO_LB = [[['PIKACHU uses THUNDERSHOCK!', 'PIKACHU setzt DONNERSCHOCK ein!', null, null, 3, null, null, [[]], [[['1eb561d2d816b8957a38cd5018eb164c', 'tea_AllEn_2022q2.md']]]]], null, 'lb', null, null, null, 0.61564964, [], [['lb'], null, [0.61564964], ['lb']]];
const GTX_AUTO_JA = [[['Meowth is a cute Pokemon.', 'ニャースは かわいい ポケモン です。', null, null, 3, null, null, [[]], [[['8610ded6ae1f9c19659bfa9bcb7344e7', 'ja_en_2023q1.md']]]]], null, 'ja', null, null, null, 1, [], [['ja'], null, [1], ['ja']]];
const GTX_AUTO_HE = [[['peace! ', 'שלום! ', null, null, 2], ['Nice to meet you.', 'נעים להכיר.', null, null, 3, null, null, [[]], [[['1eb561d2d816b8957a38cd5018eb164c', 'tea_AllEn_2022q2.md']]]]], null, 'iw', null, null, null, 1, [], [['iw'], null, [1], ['iw']]];
const GTX_EMPTY = [[['', '', null, null, 5]], null, 'de', null, null, null, null, []];

// MyMemory reply shapes (api.mymemory.translated.net is blocked in the sandbox; shapes from the audit).
const MM_OK = { responseData: { translatedText: 'A wild PIDGEY appears!', match: 0.98 }, quotaFinished: false, responseStatus: 200 };
const MM_QUOTA = { responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. NEXT AVAILABLE IN  10 HOURS 20 MINUTES 31 SECONDS VISIT HTTPS://MYMEMORY.TRANSLATED.NET/DOC/USAGELIMITS.PHP TO TRANSLATE MORE', match: 1 }, quotaFinished: true, responseStatus: 429 };
const MM_QUOTA_200 = { ...MM_QUOTA, responseStatus: 200 };
const MM_DISTINCT = { responseData: { translatedText: 'PLEASE SELECT TWO DISTINCT LANGUAGES', match: 0 }, responseStatus: '403' };
const MM_LENGTH = { responseData: { translatedText: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS', match: 0 }, responseStatus: 403 };
const MM_NOQUERY = { responseData: { translatedText: 'NO QUERY SPECIFIED. EXAMPLE REQUEST: GET?Q=HELLO&LANGPAIR=EN|IT', match: 0 }, responseStatus: 403 };
const MM_INVALID = { responseData: { translatedText: 'INVALID SOURCE LANGUAGE. EXAMPLE: LANGPAIR=EN|IT USING 2 LETTER ISO OR RFC3066 LIKE ZH-CN.' }, responseStatus: 403 };
const MM_SNEAKY = { responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.' }, responseStatus: 200, quotaFinished: false };

const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function gtxFor(q) {
  return [[[`EN(${q})`, q, null, null, 3]], null, 'de', null, null, null, null, []];
}

// Route fetches by host; each handler gets the decoded q.
function stubFetch(handlers) {
  const fn = vi.fn(async (url) => {
    const u = new URL(url);
    const q = u.searchParams.get('q');
    const h = handlers[u.hostname];
    if (!h) return json(null, 404);
    return h(q, u);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function fresh() {
  vi.resetModules();
  t = await import('../../src/core/translate.js');
}

beforeEach(async () => {
  localStorage.clear();
  await fresh();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('response parsers', () => {
  it('parses recorded gtx responses', () => {
    expect(t.parseGtx(GTX_DE_EN)).toEqual({ text: 'A wild TAUBSI appears! What should PIKACHU do?', detected: 'de', confidence: null });
    expect(t.parseGtx(GTX_AUTO_LB)).toMatchObject({ text: 'PIKACHU uses THUNDERSHOCK!', detected: 'lb', confidence: 0.61564964 });
    expect(t.parseGtx(GTX_AUTO_HE).text).toBe('peace! Nice to meet you.');
    expect(t.parseGtx(GTX_EMPTY).text).toBe('');
    expect(t.parseGtx({})).toBe(null);
    expect(t.parseGtx('<html>')).toBe(null);
  });

  it('parses dict-chrome-ex responses', () => {
    expect(t.parseDictChrome(['Hello'])).toBe('Hello');
    expect(t.parseDictChrome([['Hello', 'de']])).toBe('Hello');
    expect(t.parseDictChrome(['A &amp; B'])).toBe('A & B');
    expect(t.parseDictChrome({})).toBe(null);
    expect(t.parseDictChrome([])).toBe(null);
  });

  it('accepts a MyMemory translation', () => {
    expect(t.parseMyMemory(MM_OK)).toBe('A wild PIDGEY appears!');
    expect(t.parseMyMemory({ ...MM_OK, responseStatus: '200' })).toBe('A wild PIDGEY appears!');
  });

  it('rejects every MyMemory error reply', () => {
    for (const reply of [MM_QUOTA, MM_QUOTA_200, MM_DISTINCT, MM_LENGTH, MM_NOQUERY, MM_INVALID, MM_SNEAKY, null, {}, { responseStatus: 200 }]) {
      expect(t.parseMyMemory(reply)).toBe(null);
    }
  });

  it('recognises engine error text that may already be stored', () => {
    expect(t.isEngineErrorText('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.')).toBe(true);
    expect(t.isEngineErrorText('Mymemory warning: you used all available free translations for today.')).toBe(true);
    expect(t.isEngineErrorText('Please select two distinct languages')).toBe(true);
    expect(t.isEngineErrorText('No query specified. Example request: get?q=hello')).toBe(true);
    expect(t.isEngineErrorText('A wild PIDGEY appears!')).toBe(false);
  });
});

describe('text helpers', () => {
  it('decodes entities in one pass, with a code point guard', () => {
    expect(t.decodeEntities('Ça va &lt;bien&gt; &#8217;ok&#8217; &apos;x&apos; a&nbsp;b &#x27;z&#x27; &amp;lt;'))
      .toBe('Ça va <bien> ’ok’ \'x\' a b \'z\' &lt;');
    expect(t.decodeEntities('&#99999999; &#xD800; &bogus;')).toBe('&#99999999; &#xD800; &bogus;');
  });

  it('keeps all caps when the game text was all caps', () => {
    expect(t.fixCase('PIKACHU! I CHOOSE YOU!', 'PIKACHU! ICH WÄHLE DICH!', 'en')).toBe('PIKACHU! I CHOOSE YOU!');
    expect(t.fixCase('PIKACHU! I CHOOSE YOU!', 'Pikachu! Ich wähle dich!', 'en')).toBe('Pikachu! I choose you!');
    expect(t.fixCase('HOLA I AMIGOS', 'Hallo Freunde', 'es')).toBe('Hola i amigos');
    expect(t.fixCase('Already fine', 'x', 'en')).toBe('Already fine');
  });

  it('chunks CJK text without empty chunks', () => {
    const text = 'あ'.repeat(900);
    const chunks = t.chunkText(text, 420);
    expect(chunks.every((c) => c.length > 0 && c.length <= 420)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('chunks a long first word without an empty chunk', () => {
    const chunks = t.chunkText('x'.repeat(500) + ' hello', 420);
    expect(chunks.every((c) => c.length > 0 && c.length <= 420)).toBe(true);
    expect(chunks).toEqual(['x'.repeat(420), 'x'.repeat(80) + ' hello']);
  });

  it('prefers sentence boundaries', () => {
    expect(t.chunkText('One. Two! Three?', 10)).toEqual(['One. Two!', 'Three?']);
    expect(t.chunkText('Short.', 100)).toEqual(['Short.']);
    expect(t.chunkText('   ', 100)).toEqual([]);
  });

  it('can size chunks in UTF-8 bytes and never splits a surrogate pair', () => {
    const bytes = (s) => new TextEncoder().encode(s).length;
    const ja = 'ポケモン'.repeat(105); // 420 chars = 1,260 bytes
    const chunks = t.chunkText(ja, 480, bytes);
    expect(chunks.every((c) => bytes(c) <= 480)).toBe(true);
    expect(chunks.join('')).toBe(ja);
    const emoji = '😀'.repeat(200);
    const e = t.chunkText(emoji, 100, bytes);
    expect(e.join('')).toBe(emoji);
    expect(e.every((c) => !/[\uD800-\uDBFF]$/.test(c))).toBe(true);
  });
});

describe('translate', () => {
  it('translates with Google and caches the result', async () => {
    const fetch = stubFetch({ 'translate.googleapis.com': () => json(GTX_DE_EN) });
    const q = 'Ein wildes TAUBSI erscheint! Was soll PIKACHU tun?';
    expect(await t.translate(q, 'de', 'en')).toBe('A wild TAUBSI appears! What should PIKACHU do?');
    expect(await t.translate('  ' + q + ' ', 'de', 'en')).toBe('A wild TAUBSI appears! What should PIKACHU do?');
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('sl')).toBe('de');
    expect(url.searchParams.get('tl')).toBe('en');
  });

  it('keeps Google all-caps output for all-caps game text', async () => {
    stubFetch({ 'translate.googleapis.com': () => json([[['PIKACHU! I CHOOSE YOU!', 'x']], null, 'de']) });
    expect(await t.translate('PIKACHU! ICH WÄHLE DICH!', 'de', 'en')).toBe('PIKACHU! I CHOOSE YOU!');
  });

  it('maps language codes for Google', async () => {
    const fetch = stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q)) });
    await t.translate('שלום', 'he', 'zh');
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('sl')).toBe('iw');
    expect(url.searchParams.get('tl')).toBe('zh-CN');
  });

  it('short-circuits identical languages and empty text', async () => {
    const fetch = stubFetch({});
    expect(await t.translate(' Hello world ', 'en', 'en')).toBe('Hello world');
    expect(await t.translate('   ', 'de', 'en')).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unknown languages', async () => {
    await expect(t.translate('Hallo', null, 'en')).rejects.toMatchObject({ name: 'TranslateError' });
    await expect(t.translate('Hallo', 'de', '<x>')).rejects.toMatchObject({ name: 'TranslateError' });
  });

  it('falls back to MyMemory with zh-CN and fixes its shouting', async () => {
    const fetch = stubFetch({
      'translate.googleapis.com': () => json(null, 500),
      'clients5.google.com': () => json(null, 500),
      'api.mymemory.translated.net': () => json({ ...MM_OK, responseData: { translatedText: '你好' } })
    });
    expect(await t.translate('Hello', 'en', 'zh')).toBe('你好');
    const mm = new URL(fetch.mock.calls.find((c) => c[0].includes('mymemory'))[0]);
    expect(mm.searchParams.get('langpair')).toBe('en|zh-CN');
  });

  it('throws instead of caching MyMemory error text', async () => {
    let googleUp = false;
    const fetch = stubFetch({
      'translate.googleapis.com': (q) => (googleUp ? json(gtxFor(q)) : json(null, 429)),
      'clients5.google.com': () => json(null, 429),
      'api.mymemory.translated.net': () => json(MM_QUOTA_200)
    });
    const err = await t.translate('Ein wildes TAUBSI erscheint!', 'de', 'en').catch((e) => e);
    expect(err.name).toBe('TranslateError');
    expect(err.code).toBe('rate-limited');
    expect(t.cacheSize()).toBe(0);
    // Google comes back after its cool-down: the line translates (it was never cached as failed)
    googleUp = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(await t.translate('Ein wildes TAUBSI erscheint!', 'de', 'en')).toBe('EN(Ein wildes TAUBSI erscheint!)');
    expect(fetch).toHaveBeenCalled();
  });

  it('never accepts error text from any engine', async () => {
    stubFetch({
      'translate.googleapis.com': () => json(null, 500),
      'clients5.google.com': () => json(['PLEASE SELECT TWO DISTINCT LANGUAGES']),
      'api.mymemory.translated.net': () => json(MM_DISTINCT)
    });
    await expect(t.translate('Hallo', 'de', 'en')).rejects.toMatchObject({ code: 'failed' });
  });

  it('reports being offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(t.translate('Hallo', 'de', 'en')).rejects.toMatchObject({ code: 'offline' });
  });

  it('can bypass the cache for "Translate again"', async () => {
    let n = 0;
    const fetch = stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q + ++n)) });
    expect(await t.translate('KAMPF', 'de', 'en')).toBe('EN(KAMPF1)');
    expect(await t.translate('KAMPF', 'de', 'en')).toBe('EN(KAMPF1)');
    expect(await t.translate('KAMPF', 'de', 'en', { refresh: true })).toBe('EN(KAMPF2)');
    expect(await t.translate('KAMPF', 'de', 'en')).toBe('EN(KAMPF2)');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one request between identical concurrent calls', async () => {
    const fetch = stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q)) });
    const [a, b] = await Promise.all([t.translate('KAMPF', 'de', 'en'), t.translate('KAMPF', 'de', 'en')]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('joins chunks without spaces for Japanese targets', async () => {
    stubFetch({ 'translate.googleapis.com': () => json([[['です', 'x']], null, 'en']) });
    const long = 'Hello there. '.repeat(100).trim(); // > 900 chars: two chunks
    expect(await t.translate(long, 'en', 'ja')).toBe('ですです');
  });
});

describe('cache', () => {
  it('is an LRU capped by size', async () => {
    stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q)) });
    const line = (i) => `${i} `.padEnd(800, 'x');
    for (let i = 0; i < 20; i++) await t.translate(line(i), 'de', 'en');
    expect(t.cacheSize()).toBe(20);
    await t.translate(line(0), 'de', 'en'); // touch the oldest
    for (let i = 20; i < 200; i++) await t.translate(line(i), 'de', 'en');
    const { entries, chars } = t.cacheStats();
    expect(chars).toBeLessThanOrEqual(300_000);
    expect(entries).toBeLessThan(200);
    const fetch = stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q)) });
    await t.translate(line(199), 'de', 'en');
    expect(fetch).not.toHaveBeenCalled(); // recent entry kept
    await t.translate(line(1), 'de', 'en');
    expect(fetch).toHaveBeenCalledTimes(1); // old entry evicted
  });

  it('is saved after a short delay and restored on the next load', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q)) });
    await t.translate('KAMPF', 'de', 'en');
    expect(localStorage.getItem('emulingo:translations')).toBe(null);
    vi.advanceTimersByTime(2000);
    const saved = JSON.parse(localStorage.getItem('emulingo:translations'));
    expect(saved).toEqual({ v: 3, entries: [['de>en|KAMPF', 'EN(KAMPF)']] });
    vi.useRealTimers();
    await fresh();
    const fetch = stubFetch({});
    expect(await t.translate('KAMPF', 'de', 'en')).toBe('EN(KAMPF)');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a cache hit doesn’t rewrite storage; the new order is saved when the page is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q)) });
    await t.translate('KAMPF', 'de', 'en');
    await t.translate('BEUTEL', 'de', 'en');
    vi.advanceTimersByTime(2000);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    expect(await t.translate('KAMPF', 'de', 'en')).toBe('EN(KAMPF)');
    vi.advanceTimersByTime(10000);
    expect(setItem).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    expect(setItem).toHaveBeenCalled(); // (module copies from earlier tests listen too; ours runs last)
    const saved = JSON.parse(localStorage.getItem('emulingo:translations'));
    expect(saved.entries.map((e) => e[0])).toEqual(['de>en|BEUTEL', 'de>en|KAMPF']); // most recent last
  });

  it('drops older cache namespaces and poisoned entries', async () => {
    localStorage.setItem('emulingo:translations', JSON.stringify({
      'v2|de>en|Hallo': 'Mymemory warning: you used all available free translations for today.',
      'de>en|Hallo': 'Hello'
    }));
    await fresh();
    expect(t.cacheSize()).toBe(0);
    expect(localStorage.getItem('emulingo:translations')).toBe(null);

    localStorage.setItem('emulingo:translations', JSON.stringify({ v: 3, entries: [['de>en|a', 'MYMEMORY WARNING: X'], ['de>en|b', 'B'], ['bad'], [1, 2]] }));
    await fresh();
    expect(t.cacheSize()).toBe(1);
  });

  it('shrinks itself when storage is full', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q)) });
    for (let i = 0; i < 10; i++) await t.translate('line ' + i, 'de', 'en');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(t.cacheSize()).toBeLessThan(10);
  });

  it('clears', async () => {
    stubFetch({ 'translate.googleapis.com': (q) => json(gtxFor(q)) });
    await t.translate('KAMPF', 'de', 'en');
    t.clearTranslateCache();
    expect(t.cacheSize()).toBe(0);
    expect(t.cacheStats()).toEqual({ entries: 0, chars: 0 });
  });
});

describe('detectLanguage', () => {
  it('maps Google codes to ours', async () => {
    stubFetch({ 'translate.googleapis.com': (q) => json(q.includes('שלום') ? GTX_AUTO_HE : GTX_AUTO_JA) });
    expect(await t.detectLanguage('שלום! נעים להכיר.')).toBe('he');
    expect(await t.detectLanguage('ニャースは かわいい ポケモン です。')).toBe('ja');
  });

  it('returns null for unsure or unsupported answers', async () => {
    stubFetch({ 'translate.googleapis.com': () => json(GTX_AUTO_LB) });
    expect(await t.detectLanguage('PIKACHU setzt DONNERSCHOCK ein!')).toBe(null);
  });

  it('returns null on failure or for too little text, without throwing', async () => {
    const fetch = stubFetch({ 'translate.googleapis.com': () => json(null, 500) });
    expect(await t.detectLanguage('Ein wildes TAUBSI erscheint!')).toBe(null);
    expect(await t.detectLanguage('L5')).toBe(null);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
