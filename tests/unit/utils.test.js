import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  normalize, clamp, dayKey, dateFromKey, relativeTime, debounce, sha1Hex, hashString, newId, ID_RE,
  isQuotaError, segmentWords, toBytes
} from '../../src/core/utils.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('normalize', () => {
  it('folds case, punctuation, full-width forms and spaces', () => {
    expect(normalize('  Ein wildes TAUBSI   erscheint! ')).toBe('ein wildes taubsi erscheint');
    expect(normalize('ＰＯＫéＭＯＮ！')).toBe('pokémon');
    expect(normalize(null)).toBe('');
    expect(normalize(42)).toBe('42');
    // different Pokémon: the gender signs are part of the name
    expect(normalize('NIDORAN♂!')).toBe('nidoran♂');
    expect(normalize('NIDORAN♀')).not.toBe(normalize('NIDORAN♂'));
    expect(normalize('Ja!♂')).toBe('ja ♂');
  });
});

describe('clamp', () => {
  it('bounds a number', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe('dayKey', () => {
  it('uses local calendar days with a 4 am rollover', () => {
    expect(dayKey(new Date(2026, 9, 5, 10, 0))).toBe('2026-10-05');
    expect(dayKey(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
    expect(dayKey(new Date(2026, 9, 6, 3, 59))).toBe('2026-10-05'); // still the evening session
    expect(dayKey(new Date(2026, 9, 6, 4, 0))).toBe('2026-10-06');
    expect(dayKey(new Date(2026, 0, 1, 2, 0))).toBe('2025-12-31');
  });

  it('can use midnight rollover', () => {
    expect(dayKey(new Date(2026, 9, 6, 1, 0), 0)).toBe('2026-10-06');
  });

  it('round-trips through dateFromKey at noon', () => {
    const d = dateFromKey('2026-03-29');
    expect(d.getHours()).toBe(12);
    expect(dayKey(d)).toBe('2026-03-29');
    expect(dateFromKey('nope')).toBe(null);
  });
});

describe('relativeTime', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  it('describes past and future times', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 hours ago');
    expect(relativeTime(now - 86400_000, now)).toBe('yesterday');
    expect(relativeTime(now + 3 * 3600_000, now)).toBe('in 3 hours');
    expect(relativeTime(now + 10_000, now)).toBe('in a moment');
    expect(relativeTime('x', now)).toBe('');
  });
});

describe('debounce', () => {
  it('runs once after the quiet period, with flush and cancel', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1); d(2); d(3);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(3);
    d(4);
    d.flush();
    expect(fn).toHaveBeenLastCalledWith(4);
    d(5);
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honours maxWait while calls keep coming', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100, { maxWait: 250 });
    for (let i = 0; i < 10; i++) { d(i); vi.advanceTimersByTime(50); }
    expect(fn).toHaveBeenCalled();
  });
});

describe('sha1Hex', () => {
  const expected = (s) => createHash('sha1').update(s).digest('hex');
  it('matches node crypto via crypto.subtle', async () => {
    expect(await sha1Hex('abc')).toBe(expected('abc'));
    expect(await sha1Hex(new Uint8Array([1, 2, 3]).buffer)).toBe(expected(Buffer.from([1, 2, 3])));
  });

  it('falls back to the JS implementation without crypto.subtle (plain-http LAN)', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (a) => a });
    for (const len of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 7 + 3) & 255);
      expect(await sha1Hex(bytes)).toBe(expected(Buffer.from(bytes)));
    }
  });
});

describe('ids and hashing', () => {
  it('newId is unique and safe', () => {
    const a = newId('c');
    const b = newId('c');
    expect(a).not.toBe(b);
    expect(a).toMatch(ID_RE);
    expect(a.startsWith('c')).toBe(true);
  });
  it('hashString is stable', () => {
    expect(hashString('Pokemon Rot.gb')).toBe(hashString('Pokemon Rot.gb'));
    expect(hashString('a')).not.toBe(hashString('b'));
  });
  it('toBytes accepts strings, buffers and views', () => {
    expect(toBytes('é').length).toBe(2);
    expect(toBytes(new ArrayBuffer(3)).length).toBe(3);
    expect(toBytes(new Uint16Array(2)).length).toBe(4);
  });
});

describe('isQuotaError', () => {
  it('recognises quota errors across browsers', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error('nope'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe('segmentWords', () => {
  it('splits Latin text into words and gaps', () => {
    const segs = segmentWords('Ein wildes TAUBSI erscheint!', 'de');
    expect(segs.filter((s) => s.word).map((s) => s.text)).toEqual(['Ein', 'wildes', 'TAUBSI', 'erscheint']);
    expect(segs.map((s) => s.text).join('')).toBe('Ein wildes TAUBSI erscheint!');
  });

  it('splits Japanese without spaces', () => {
    const words = segmentWords('ニャースはかわいいポケモンです。', 'ja').filter((s) => s.word);
    expect(words.length).toBeGreaterThan(1);
  });

  it('works without Intl.Segmenter', () => {
    const Seg = Intl.Segmenter;
    try {
      Intl.Segmenter = undefined;
      const segs = segmentWords("Don't stop, POKé-fan!", 'en');
      expect(segs.filter((s) => s.word).map((s) => s.text)).toEqual(["Don't", 'stop', 'POKé-fan']);
      expect(segs.map((s) => s.text).join('')).toBe("Don't stop, POKé-fan!");
    } finally {
      Intl.Segmenter = Seg;
    }
  });
});
