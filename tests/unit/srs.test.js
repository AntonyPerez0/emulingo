import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A non-UTC zone reproduces the old UTC day-key bugs (DATA-04).
process.env.TZ = 'America/New_York';

let srs;
let db;

const DAY = 86_400_000;
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const MON = at(2026, 10, 5, 21); // Monday 5 October 2026, 21:00 New York
const fixed = () => 0.5; // no fuzz

async function fresh() {
  vi.resetModules();
  db = await import('../../src/core/db.js');
  srs = await import('../../src/core/srs.js');
}

function add(text, extra = {}) {
  return srs.addCard({ text, translation: 'T:' + text, src: 'de', tgt: 'en', ...extra }).card;
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // no localStorage in this environment
  globalThis.indexedDB = new IDBFactory();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MON);
  await fresh();
});

afterEach(() => {
  db.cancelPending({ freeze: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('addCard', () => {
  it('adds, dedupes on normalized text + language pair, and validates', () => {
    const a = srs.addCard({ text: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!', src: 'de', tgt: 'en', origin: 'auto' });
    expect(a.status).toBe('added');
    expect(a.card).toMatchObject({ src: 'de', tgt: 'en', origin: 'auto', seen: 0, reps: 0, ease: 2.5, due: MON });
    const dup = srs.addCard({ text: '  ein wildes taubsi erscheint ', translation: 'x', src: 'de', tgt: 'en' });
    expect(dup).toEqual({ status: 'duplicate', card: a.card });
    expect(srs.addCard({ text: 'Ein wildes TAUBSI erscheint!', translation: 'Un PIDGEY sauvage', src: 'de', tgt: 'fr' }).status).toBe('added');
    expect(srs.addCard({ text: '', src: 'de', tgt: 'en' }).status).toBe('error');
    expect(srs.addCard({ text: '!!!', src: 'de', tgt: 'en' }).status).toBe('error');
    expect(srs.addCard({ text: 'Hallo', src: 'xx', tgt: 'en' }).status).toBe('error');
    expect(srs.totalCards()).toBe(2);
  });

  it('fills an empty back on a duplicate and refuses engine error text', () => {
    const first = srs.addCard({ text: 'KAMPF', translation: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS', src: 'de', tgt: 'en' });
    expect(first.card.translation).toBe('');
    const again = srs.addCard({ text: 'KAMPF', translation: 'FIGHT', src: 'de', tgt: 'en' });
    expect(again.status).toBe('duplicate');
    expect(again.card.translation).toBe('FIGHT');
  });

  it('does not count as study activity', () => {
    add('Hallo');
    expect(srs.reviewsOn(srs.todayKey())).toBe(0);
    expect(srs.streak()).toBe(0);
  });
});

describe('scheduling', () => {
  it('Good on a new card: 1 day, due at the next 4 am boundary, ease unchanged', () => {
    const c = add('Hallo');
    const g = srs.grade(c.id, srs.GRADES.GOOD, { now: MON, random: fixed });
    expect(g).toMatchObject({ reps: 1, ease: 2.5, interval: DAY, seen: 1, lastResult: 2, firstReview: MON, lastReview: MON });
    expect(g.due).toBe(at(2026, 10, 6, 4)); // Tuesday 04:00, not Tuesday 21:00
    expect(srs.getCard(c.id)).toEqual(g);
  });

  it('a review after midnight still belongs to the evening study day', () => {
    const c = add('Hallo');
    const lateNight = at(2026, 10, 6, 2); // Tue 02:00 = Monday's study day
    const g = srs.grade(c.id, srs.GRADES.GOOD, { now: lateNight, random: fixed });
    expect(g.due).toBe(at(2026, 10, 6, 4));
    expect(srs.todayKey(lateNight)).toBe('2026-10-05');
  });

  it('Good keeps the ease; intervals grow by it and are capped', () => {
    let c = add('Hallo');
    const days = [];
    let now = MON;
    for (let i = 0; i < 9; i++) {
      c = srs.grade(c.id, srs.GRADES.GOOD, { now, random: fixed });
      days.push(c.interval / DAY);
      now = c.due + 3600_000;
    }
    expect(c.ease).toBe(2.5);
    expect(days).toEqual([1, 3, 8, 20, 50, 125, 313, 365, 365]);
  });

  it('Easy raises ease by 0.15, Hard lowers it by 0.15 with a shorter interval', () => {
    let c = add('Hallo');
    c = srs.grade(c.id, srs.GRADES.EASY, { now: MON, random: fixed });
    expect(c.ease).toBe(2.65);
    expect(c.interval).toBe(4 * DAY);
    c = srs.grade(c.id, srs.GRADES.HARD, { now: c.due, random: fixed });
    expect(c.ease).toBe(2.5);
    expect(c.interval).toBe(5 * DAY); // max(4 + 1, 4 × 1.2)
  });

  it('Again on a brand-new card is not a lapse', () => {
    const c = add('Hallo');
    const g = srs.grade(c.id, srs.GRADES.AGAIN, { now: MON });
    expect(g).toMatchObject({ lapses: 0, reps: 0, ease: 2.5, interval: 10 * 60_000, due: MON + 10 * 60_000, seen: 1 });
  });

  it('Again on a learned card is a lapse and restarts at 1 day', () => {
    let c = add('Hallo');
    c = srs.grade(c.id, srs.GRADES.GOOD, { now: MON, random: fixed });
    c = srs.grade(c.id, srs.GRADES.GOOD, { now: c.due, random: fixed });
    const lapse = srs.grade(c.id, srs.GRADES.AGAIN, { now: c.due });
    expect(lapse).toMatchObject({ lapses: 1, reps: 0, ease: 2.3 });
    // the Review view re-queues THIS updated copy; grading it Good gives 1 day, not a long interval
    const relearned = srs.grade(lapse.id, srs.GRADES.GOOD, { now: lapse.due, random: fixed });
    expect(relearned.interval).toBe(DAY);
  });

  it('fuzzes longer intervals by ±5 %', () => {
    const card = { reps: 3, interval: 8 * DAY, ease: 2.5 };
    const lo = srs.schedule(card, 2, { now: MON, random: () => 0 });
    const hi = srs.schedule(card, 2, { now: MON, random: () => 0.999 });
    expect(lo.interval / DAY).toBe(19);
    expect(hi.interval / DAY).toBe(21);
  });

  it('previews nominal intervals for the four buttons', () => {
    const c = add('Hallo');
    expect(srs.previewIntervals(c)).toEqual({ 0: 600_000, 1: DAY, 2: DAY, 3: 4 * DAY });
    const g = srs.grade(c.id, 2, { now: MON, random: fixed });
    expect(srs.previewIntervals(g)).toEqual({ 0: 600_000, 1: 2 * DAY, 2: 3 * DAY, 3: 4 * DAY });
  });

  it('studying ahead keeps a card’s schedule unless it was forgotten', () => {
    let c = add('Hallo');
    c = srs.grade(c.id, 2, { now: MON, random: fixed });
    const ahead = srs.grade(c.id, 3, { now: MON + 1000, ahead: true });
    expect(ahead.due).toBe(c.due);
    expect(ahead.interval).toBe(c.interval);
    expect(ahead.seen).toBe(2);
    const forgot = srs.grade(c.id, 0, { now: MON + 2000, ahead: true });
    expect(forgot.due).toBe(MON + 2000 + 600_000);
  });

  it('ignores unknown cards and grades', () => {
    expect(srs.grade('nope', 2)).toBe(null);
    const c = add('Hallo');
    expect(srs.grade(c.id, 7)).toBe(null);
  });
});

describe('due cards', () => {
  it('lists due reviews first, then new cards up to the daily limit', () => {
    const cards = [];
    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(MON - (30 - i) * 1000);
      cards.push(add('Wort ' + i));
    }
    vi.setSystemTime(MON);
    expect(srs.dueCards({ limitNew: 20, now: MON })).toHaveLength(20);
    expect(srs.dueCards({ limitNew: 20, now: MON })[0].text).toBe('Wort 0'); // oldest first
    // study five new cards today
    for (const c of cards.slice(0, 5)) srs.grade(c.id, 2, { now: MON, random: fixed });
    expect(srs.dueCards({ limitNew: 20, now: MON + 1000 })).toHaveLength(15);
    expect(srs.dueCards({ limitNew: Infinity, now: MON + 1000 })).toHaveLength(25);
    expect(srs.dueCards({ limitNew: 0, now: MON + 1000 })).toHaveLength(0);
    // next morning: the five reviews are due and the new-card allowance is back
    const tue = at(2026, 10, 6, 9);
    const due = srs.dueCards({ limitNew: 20, now: tue });
    expect(due.slice(0, 5).every((c) => c.seen === 1)).toBe(true);
    expect(due).toHaveLength(25);
    expect(srs.dueBreakdown({ limitNew: 20, now: tue })).toEqual({ reviews: 5, fresh: 20, total: 25 });
  });

  it('uses the newPerDay setting by default and says when the next card is due', async () => {
    const { store } = await import('../../src/core/store.js');
    store.set('newPerDay', 2);
    for (let i = 0; i < 4; i++) add('Wort ' + i);
    expect(srs.dueCount({ now: MON })).toBe(2);
    store.set('newPerDay', 0);
    const c = srs.cards()[0];
    srs.grade(c.id, 2, { now: MON, random: fixed });
    expect(srs.nextDueAt({ now: MON + 1000, limitNew: 0 })).toBe(at(2026, 10, 6, 4));
    store.set('newPerDay', 20);
  });

  it('counts mature cards', () => {
    const c = add('Hallo');
    srs.updateCard(c.id, { text: 'Hallo!' });
    expect(srs.matureCount()).toBe(0);
  });
});

describe('activity, streak and week', () => {
  it('logs graded reviews on local study days and computes the streak when read', () => {
    const c = add('Hallo');
    const monMorning = at(2026, 10, 5, 10);
    const tueEvening = at(2026, 10, 6, 21); // 01:00 UTC Wednesday
    srs.grade(c.id, 2, { now: monMorning, random: fixed });
    srs.grade(c.id, 2, { now: tueEvening, random: fixed });
    expect(srs.reviewsOn('2026-10-05')).toBe(1);
    expect(srs.reviewsOn('2026-10-06')).toBe(1);
    expect(srs.streak(tueEvening)).toBe(2);
    expect(srs.streak(at(2026, 10, 7, 9))).toBe(2); // today still empty
    expect(srs.streak(at(2026, 10, 12, 9))).toBe(0); // a week off breaks it
  });

  it('reports the last 7 days with local weekday labels', () => {
    const c = add('Hallo');
    srs.grade(c.id, 2, { now: at(2026, 10, 5, 10), random: fixed });
    const week = srs.weekStats(at(2026, 10, 7, 9));
    expect(week).toHaveLength(7);
    expect(week.at(-1)).toMatchObject({ key: '2026-10-07', label: 'Wed', today: true });
    const mon = week.find((d) => d.key === '2026-10-05');
    expect(mon).toMatchObject({ label: 'Mon', count: 1 });
    expect(mon.long).toMatch(/Monday/);
  });
});

describe('edit, remove and undo', () => {
  it('removes and restores a card', () => {
    const c = add('Hallo');
    const removed = srs.removeCard(c.id);
    expect(srs.totalCards()).toBe(0);
    expect(srs.addCard({ text: 'Hallo', src: 'de', tgt: 'en' }).status).toBe('added');
    srs.removeCard(srs.findCard('Hallo', 'de', 'en').id);
    expect(srs.restoreCard(removed)).toEqual(c);
    expect(srs.restoreCard(removed)).toBe(null); // already back
  });

  it('edits front and back, refusing duplicates', () => {
    const a = add('Hallo');
    add('Tschüss');
    expect(srs.updateCard(a.id, { translation: 'Hi there' }).translation).toBe('Hi there');
    expect(srs.updateCard(a.id, { text: 'tschüss!' })).toBe(null);
    expect(srs.updateCard(a.id, { text: '' })).toBe(null);
    expect(srs.updateCard(a.id, { text: 'Guten Tag', id: 'hacked', ease: 9 })).toMatchObject({ id: a.id, text: 'Guten Tag', ease: 2.5 });
    expect(srs.findCard('Guten Tag', 'de', 'en').id).toBe(a.id);
    srs.clearAll();
    expect(srs.totalCards()).toBe(0);
  });
});

describe('export', () => {
  it('guards CSV cells against formula injection', () => {
    for (const [text, tr] of [['=HYPERLINK("http://x")', 'a'], ['-> WEITER', '-> NEXT'], ['+10 KP', '@SUM(A1)'], ['Sag "Hallo"', 'Say "hi"']]) {
      add(text, { translation: tr });
    }
    const csv = srs.exportCsv();
    expect(csv.startsWith('﻿"Front","Back"')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(csv).toContain('"\'-> WEITER","\'-> NEXT"');
    expect(csv).toContain('"\'+10 KP","\'@SUM(A1)"');
    expect(csv).toContain('"Sag ""Hallo""","Say ""hi"""');
    expect(csv.split('\r\n').length).toBe(6);
    expect(srs.csvCell('\tx')).toBe('"\'\tx"');
  });

  it('exports Anki-friendly TSV', () => {
    add('Zeile\teins\nzwei', { translation: 'line\tone' });
    expect(srs.exportTsv()).toBe('Zeile eins zwei\tline one\n');
  });
});

describe('sanitizeCard', () => {
  it('upgrades a v1 card', () => {
    const v1 = { id: '1759650000000-ab12c', text: 'Ein wildes TAUBSI erscheint!', lang: 'de', translation: 'A wild PIDGEY appears!',
      ease: 2.45, interval: DAY, reps: 1, lapses: 0, due: MON, added: MON - DAY, lastResult: 1, seen: 1 };
    expect(srs.sanitizeCard(v1, { fallbackTgt: 'en' })).toMatchObject({
      src: 'de', tgt: 'en', lastResult: 2, origin: 'manual', ease: 2.45, reps: 1, seen: 1, lastReview: null, firstReview: null
    });
  });

  it('rejects or neutralises hostile values', () => {
    expect(srs.sanitizeCard({ id: 'x"><img src=x onerror=alert(1)>', text: 'a', src: 'de', tgt: 'en' })).toBe(null);
    expect(srs.sanitizeCard({ id: 'c1', text: 'a', src: '<b>', tgt: 'en' })).toBe(null);
    expect(srs.sanitizeCard({ id: 'c1', text: { toString: () => 'x' }, src: 'de' })).toBe(null);
    const c = srs.sanitizeCard({
      id: 'c1', text: 'Hallo', src: 'de', tgt: '"><svg>', translation: 'MYMEMORY WARNING: QUOTA',
      ease: '"><img>', interval: Infinity, reps: -5, seen: 'lots', due: 'soon', lastResult: '<x>'
    }, { fallbackTgt: 'fr' });
    expect(c).toMatchObject({ tgt: 'fr', translation: '', ease: 2.5, interval: 0, reps: 0, seen: 0, lastResult: null });
    expect(Number.isFinite(c.due)).toBe(true);
    expect(srs.sanitizeActivity({ id: '2026-10-05', count: '"><img>' })).toBe(null);
    expect(srs.sanitizeActivity({ id: '<b>', count: 3 })).toBe(null);
    expect(srs.sanitizeActivity({ id: '2026-10-05', count: 3 })).toEqual({ id: '2026-10-05', count: 3 });
  });
});

describe('persistence', () => {
  it('cards and activity survive a reload', async () => {
    vi.useRealTimers();
    await db.initDb();
    const c = add('Hallo');
    srs.grade(c.id, 2, { random: fixed });
    await db.flush();
    db.cancelPending({ freeze: true });
    const { closeDb } = await import('../../src/core/idb.js');
    await closeDb();
    await fresh();
    await db.initDb();
    expect(srs.getCard(c.id).seen).toBe(1);
    expect(srs.reviewsOn(srs.todayKey())).toBe(1);
    expect(srs.addCard({ text: 'hallo', src: 'de', tgt: 'en' }).status).toBe('duplicate');
  });
});
