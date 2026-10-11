import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let history;
let db;
let store;

const capture = (id, extra = {}) => ({
  id,
  time: 1000 + Number(String(id).replace(/\D/g, '') || 0),
  src: 'de',
  tgt: 'en',
  dialog: { text: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!', status: 'done' },
  others: [{ key: 'menu-1', kind: 'menu', text: 'KAMPF', translation: 'FIGHT', status: 'done' }],
  conf: 0.93,
  ...extra
});

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = await import('../../src/core/db.js');
  ({ store } = await import('../../src/core/store.js'));
  history = await import('../../src/core/history.js');
});

afterEach(() => {
  db.cancelPending({ freeze: true });
  vi.restoreAllMocks();
});

describe('add and update', () => {
  it('stores captures newest first', () => {
    history.add(capture('c1'));
    history.add(capture('c2'));
    expect(history.list().map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(history.get('c1').dialog.translation).toBe('A wild PIDGEY appears!');
    expect(history.get('c1').others[0]).toEqual({ key: 'menu-1', kind: 'menu', text: 'KAMPF', translation: 'FIGHT', status: 'done' });
  });

  it('replaces by id in place, never duplicating', () => {
    history.add(capture('c1', { dialog: { text: 'Hallo', translation: '', status: 'pending' } }));
    history.add(capture('c2'));
    const updated = history.update(capture('c1', { time: 99999, dialog: { text: 'Hallo', translation: 'Hello', status: 'done' } }));
    expect(updated.dialog).toEqual({ text: 'Hallo', translation: 'Hello', status: 'done' });
    expect(history.list().map((c) => c.id)).toEqual(['c2', 'c1']); // kept its place
    history.add(capture('c1'));
    expect(history.list()).toHaveLength(2);
  });

  it('update ignores unknown captures', () => {
    expect(history.update(capture('nope'))).toBe(null);
    expect(history.update(null)).toBe(null);
    expect(history.list()).toHaveLength(0);
  });

  it('keeps in-flight statuses while running', () => {
    const c = history.add(capture('c1', { dialog: { text: 'Hallo', translation: '', status: 'translating' } }));
    expect(c.dialog.status).toBe('translating');
  });
});

describe('cap', () => {
  it('trims to keepHistory, also when the setting goes down', () => {
    store.set('keepHistory', 25);
    for (let i = 0; i < 30; i++) history.add(capture('c' + i));
    expect(history.list()).toHaveLength(25);
    expect(history.list().at(-1).id).toBe('c5');
    store.set('keepHistory', 20);
    expect(history.list()).toHaveLength(20);
    expect(history.list().at(-1).id).toBe('c10');
    store.set('keepHistory', 200);
  });
});

describe('sanitizeCapture', () => {
  it('maps unsafe scanner ids to a stable safe id', () => {
    const a = history.add(capture('frame 12 / dialog'));
    expect(a.id).toMatch(/^[\w.:-]+$/);
    expect(history.update(capture('frame 12 / dialog', { dialog: { text: 'x', translation: 'y', status: 'done' } })).id).toBe(a.id);
    expect(history.get('frame 12 / dialog').dialog.text).toBe('x');
  });

  it('rejects captures without languages or text', () => {
    expect(history.add(capture('c1', { src: 'xx' }))).toBe(null);
    expect(history.add(capture('c1', { tgt: undefined }))).toBe(null);
    expect(history.add(capture('c1', { dialog: null, others: [] }))).toBe(null);
    expect(history.add(capture('', {}))).toBe(null);
  });

  it('neutralises hostile values (escaping stays the view’s job)', () => {
    const c = history.sanitizeCapture({
      id: 'c1', time: 'now', src: 'de', tgt: 'en', conf: '"><img src=x>',
      dialog: { text: '<img src=x onerror=alert(1)>', translation: 'MYMEMORY WARNING: QUOTA', status: '"><b>' },
      others: [{ key: 'x'.repeat(200), kind: '<script>', text: 'KAMPF', translation: 'FIGHT', status: 'done' }, 'junk', { text: '' }]
    }, { stored: true });
    expect(c.conf).toBe(null);
    expect(Number.isFinite(c.time)).toBe(true);
    expect(c.dialog).toEqual({ text: '<img src=x onerror=alert(1)>', translation: '', status: 'error' });
    expect(c.others).toEqual([{ key: 'r0', kind: 'label', text: 'KAMPF', translation: 'FIGHT', status: 'done' }]);
  });

  it('finalises unfinished statuses when loaded from storage', () => {
    const c = history.sanitizeCapture(capture('c1', {
      dialog: { text: 'Hallo', translation: '', status: 'translating' },
      others: [{ key: 'a', kind: 'menu', text: 'KAMPF', translation: 'FIGHT', status: 'pending' }]
    }), { stored: true });
    expect(c.dialog.status).toBe('error');
    expect(c.others[0].status).toBe('done');
  });

  it('keeps layout region keys as they are', () => {
    const c = history.sanitizeCapture(capture('c1', { others: [{ key: 'menu|12,40 ~2', kind: 'menu', text: 'KAMPF' }] }));
    expect(c.others[0].key).toBe('menu|12,40 ~2');
  });

  it('caps the number of other regions', () => {
    const others = Array.from({ length: 40 }, (_, i) => ({ key: 'k' + i, kind: 'label', text: 'Wort ' + i }));
    expect(history.sanitizeCapture(capture('c1', { others })).others).toHaveLength(24);
  });

  it('upgrades v1 history entries', () => {
    const v1 = {
      id: 'h1759650005000-0',
      original: 'KAMPF / Ein wildes TAUBSI erscheint!', translation: 'FIGHT / A wild PIDGEY appears!',
      regions: [{ original: 'KAMPF', translation: 'FIGHT', conf: 90 }, { original: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!', conf: 95 }],
      time: 1759650005000, conf: 92, src: 'de', tgt: 'en', status: 'translating'
    };
    expect(history.sanitizeCapture(v1)).toEqual({
      id: 'h1759650005000-0', time: 1759650005000, src: 'de', tgt: 'en', conf: 0.92, // v1 percentages become 0..1
      dialog: { text: 'Ein wildes TAUBSI erscheint!', translation: 'A wild PIDGEY appears!', status: 'done' },
      others: [{ key: 'v1-0', kind: 'label', text: 'KAMPF', translation: 'FIGHT', status: 'done' }]
    });
  });
});

describe('other tabs', () => {
  it('keeps captures another tab is still translating, but finalises them at the next boot', async () => {
    const idb = await import('../../src/core/idb.js');
    await db.initDb();
    const live = capture('c7', { dialog: { text: 'Hallo', translation: '', status: 'translating' } });
    await idb.idbBatch([{ store: 'history', type: 'put', value: live }]); // written by the other tab
    const other = new BroadcastChannel('emulingo-db');
    other.postMessage({ type: 'changed', from: 'other-tab', collections: ['history'] });
    await vi.waitFor(() => expect(history.get('c7')).toBeTruthy());
    other.close();
    expect(history.get('c7').dialog.status).toBe('translating');
    await db.flush();
    expect((await idb.idbGetAll('history'))[0].dialog.status).toBe('translating'); // not rewritten

    // a later session: nobody will finish that translation now
    db.cancelPending({ freeze: true });
    await idb.closeDb();
    vi.resetModules();
    db = await import('../../src/core/db.js');
    history = await import('../../src/core/history.js');
    await db.initDb();
    expect(history.get('c7').dialog.status).toBe('error');
  });
});

describe('remove, clear, import', () => {
  it('removes and clears', () => {
    history.add(capture('c1'));
    history.add(capture('c2'));
    expect(history.remove('c1').id).toBe('c1');
    expect(history.list()).toHaveLength(1);
    history.clear();
    expect(history.list()).toEqual([]);
  });

  it('imports with existing ids winning on merge', () => {
    history.add(capture('c1'));
    const incoming = [history.sanitizeCapture(capture('c1', { dialog: { text: 'Other', translation: 'x', status: 'done' } })), history.sanitizeCapture(capture('c3'))];
    expect(history.importCaptures(incoming, { mode: 'merge' })).toBe(1);
    expect(history.get('c1').dialog.text).toBe('Ein wildes TAUBSI erscheint!');
    expect(history.importCaptures(incoming, { mode: 'replace' })).toBe(2);
    expect(history.get('c1').dialog.text).toBe('Other');
  });
});
