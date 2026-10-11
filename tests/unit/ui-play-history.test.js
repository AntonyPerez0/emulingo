// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
afterAll(() => wait(150));

// "Clear history?" is answered by the test
const confirmAnswer = vi.hoisted(() => ({ value: true }));
vi.mock('../../src/ui/dialog.js', () => ({
  confirmDialog: async () => confirmAnswer.value,
  openDialog: () => ({ el: null, close() {}, closed: Promise.resolve(null) })
}));

let history;
let createRecentLines;
let sortRoms;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = await import('../../src/core/db.js');
  await db.initDb();
  history = await import('../../src/core/history.js');
  ({ createRecentLines } = await import('../../src/ui/views/play/history.js'));
  ({ sortRoms } = await import('../../src/ui/views/play/library.js'));
});

function capture(i, over = {}) {
  return {
    id: `cap-${i}`,
    time: Date.now() - i * 60000,
    src: 'de',
    tgt: 'en',
    dialog: { text: `Satz ${i}`, translation: `Sentence ${i}`, status: 'done' },
    others: [],
    conf: 0.9,
    ...over
  };
}

describe('recent lines', () => {
  let section;
  let opened;
  let recent;

  beforeEach(() => {
    history.clear();
    document.body.innerHTML = '<section id="recent"></section><div id="sr-status" role="status"></div><div id="sr-alert" role="alert"></div>';
    section = document.getElementById('recent');
    opened = [];
  });

  const make = () => { recent = createRecentLines(section, { onOpen: (c) => opened.push(c.id) }); return recent; };

  it('shows an empty state without history', () => {
    make();
    expect(section.querySelector('h2').textContent).toBe('Recent lines');
    expect(section.querySelector('.empty-state').textContent).toContain('No lines yet');
    expect(section.querySelector('[data-action="clear-history"]').hidden).toBe(true);
    recent.destroy();
  });

  it('lists lines as buttons with lang on both texts, newest first', () => {
    history.add(capture(2));
    history.add(capture(1));
    make();
    const rows = [...section.querySelectorAll('.recent-item')];
    expect(rows.map((r) => r.dataset.key)).toEqual(['cap-1', 'cap-2']);
    const btn = rows[0].querySelector('button');
    expect(btn.querySelector('.recent-item__orig').getAttribute('lang')).toBe('de');
    expect(btn.querySelector('.recent-item__trans').getAttribute('lang')).toBe('en');
    expect(btn.querySelector('time').textContent).toMatch(/minute/);
    btn.click();
    expect(opened).toEqual(['cap-1']);
    recent.destroy();
  });

  it('pages with "Show more" and moves focus to the first new line', () => {
    for (let i = 0; i < 25; i++) history.add(capture(i));
    make();
    expect(section.querySelectorAll('.recent-item')).toHaveLength(20);
    const more = section.querySelector('[data-action="more-lines"]');
    expect(more.closest('.recent__more').textContent).toContain('Showing 20 of 25 lines');
    more.click();
    const rows = section.querySelectorAll('.recent-item');
    expect(rows).toHaveLength(25);
    expect(document.activeElement).toBe(rows[20].querySelector('button'));
    expect(section.querySelector('[data-action="more-lines"]')).toBe(null);
    recent.destroy();
  });

  it('marks the line being viewed', () => {
    history.add(capture(1));
    history.add(capture(2));
    make();
    recent.setActive('cap-2');
    const cur = section.querySelector('[aria-current="true"]');
    expect(cur.closest('[data-key]').dataset.key).toBe('cap-2');
    recent.setActive(null);
    expect(section.querySelector('[aria-current]')).toBe(null);
    recent.destroy();
  });

  it('keeps focus on the same line when the list refreshes', async () => {
    history.add(capture(2));
    history.add(capture(3));
    make();
    const btn = section.querySelector('[data-key="cap-3"] button');
    btn.focus();
    history.add(capture(1));
    recent.refresh();
    await wait(200);
    expect(document.activeElement.closest('[data-key]').dataset.key).toBe('cap-3');
    expect(section.querySelectorAll('.recent-item')).toHaveLength(3);
    recent.destroy();
  });

  it('clears after asking, tells the view, and moves focus to the heading', async () => {
    history.add(capture(1));
    let cleared = 0;
    recent = createRecentLines(section, { onOpen: () => {}, onCleared: () => { cleared++; } });
    recent.setActive('cap-1');
    confirmAnswer.value = false;
    section.querySelector('[data-action="clear-history"]').click();
    await wait(10);
    expect(history.list()).toHaveLength(1);
    expect(cleared).toBe(0);
    confirmAnswer.value = true;
    section.querySelector('[data-action="clear-history"]').click();
    await wait(10);
    expect(history.list()).toHaveLength(0);
    expect(cleared).toBe(1);
    expect(section.querySelector('.empty-state')).not.toBe(null);
    expect(document.activeElement).toBe(section.querySelector('h2'));
    // a pending refresh must not bring the old rows back
    recent.refresh();
    await wait(200);
    expect(section.querySelector('.recent-item')).toBe(null);
    recent.destroy();
  });

  it('summarises menu-only captures', () => {
    history.add(capture(1, { dialog: null, others: [{ key: 'm', kind: 'menu', text: 'JA\nNEIN', translation: 'Yes\nNo', status: 'done' }] }));
    make();
    expect(section.querySelector('.recent-item__orig').textContent).toBe('JA · NEIN');
    recent.destroy();
  });
});

describe('sortRoms', () => {
  it('puts the most recently played (or added) game first', () => {
    const list = sortRoms([
      { id: 'a', added: 1, lastPlayed: null },
      { id: 'b', added: 2, lastPlayed: 50 },
      { id: 'c', added: 30, lastPlayed: null }
    ]);
    expect(list.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});
