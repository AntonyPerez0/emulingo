// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { html, render, $, $$ } from '../../src/ui/dom.js';
import {
  createListController, listToolbar, listBody, listRow, termLines, editForm, rowAction,
  statsStrip, quoteTerm, PAGE_SIZE,
} from '../../src/ui/views/listview.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Let pending screen-reader announcements (filled after 100 ms) land before teardown.
afterAll(() => wait(150));

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `i${i}`, text: `Wort ${i}`, translation: i % 2 ? `word ${i}` : '' }));
}

let data;
let list;
let onAction;
let onSave;

function setup(n = 250) {
  data = makeItems(n);
  document.body.innerHTML = '<main><section data-view="deck"><h1 tabindex="-1">Deck</h1><div id="lv"></div></section></main><div id="sr-status"></div><div id="sr-alert"></div>';
  const root = $('#lv');
  render(root, html`${listToolbar({
    id: 't',
    searchLabel: 'Search things',
    filterLabel: 'Show',
    filters: [{ value: 'all', label: 'All' }, { value: 'odd', label: 'Translated' }],
    menuItems: [{ action: 'export', label: 'Export' }],
  })}${listBody({ id: 't', label: 'Things' })}`);
  onAction = vi.fn();
  onSave = vi.fn((key, value) => {
    const it = data.find((d) => d.id === key);
    it.translation = value;
    return { ...it };
  });
  list = createListController(root, {
    noun: ['thing', 'things'],
    overall: () => data.length,
    query: ({ q, filter, limit }) => {
      const all = data.filter((d) => (filter === 'odd' ? d.translation : true) && (!q || d.text.includes(q)));
      return { items: all.slice(0, limit), total: all.length };
    },
    keyOf: (d) => d.id,
    renderRow: (d, { editing }) => listRow({
      key: d.id,
      body: termLines({ text: d.text, src: 'de', translation: d.translation, tgt: 'en', editor: editing ? editForm({ key: d.id, term: d.text, value: d.translation, tgt: 'en' }) : null }),
      actions: [
        rowAction({ action: 'edit', label: `Edit translation of ${quoteTerm(d.text)}`, icon: 'type' }),
        rowAction({ action: 'delete', label: `Delete ${quoteTerm(d.text)}`, icon: 'trash-2', danger: true }),
      ],
    }),
    noMatch: ({ q }) => `Nothing matches ${quoteTerm(q)}.`,
    onAction,
    onSave,
    onRetranslate: async () => 'fresh',
    onMenu: vi.fn(),
  });
  list.render();
  return root;
}

const rows = () => $$('.lv-row');
const count = () => $('[data-lv-count]').textContent;

beforeEach(() => setup());
afterEach(() => list.destroy());

describe('helpers', () => {
  it('quoteTerm quotes and shortens long text', () => {
    expect(quoteTerm('Hallo')).toBe('“Hallo”');
    const long = quoteTerm('x'.repeat(100), 10);
    expect([...long].length).toBe(12);
    expect(long.endsWith('…”')).toBe(true);
  });

  it('statsStrip renders a labelled description list', () => {
    document.body.innerHTML = String(statsStrip({ label: 'Overview', tiles: [{ label: 'Due now', value: '3' }] }));
    const dl = $('dl');
    expect(dl.getAttribute('aria-label')).toBe('Overview');
    expect($('dt').textContent.trim()).toBe('Due now');
    expect($('dd').textContent).toBe('3');
  });

  it('termLines marks languages and escapes text', () => {
    document.body.innerHTML = String(termLines({ text: '<b>Hallo</b>', src: 'de', translation: 'שלום', tgt: 'he' }));
    expect($('.lv-term').getAttribute('lang')).toBe('de');
    expect($('.lv-term').textContent).toBe('<b>Hallo</b>');
    expect($('.lv-translation').getAttribute('lang')).toBe('he');
    expect($('.lv-translation').getAttribute('dir')).toBe('rtl');
  });
});

describe('paging and counts', () => {
  it('shows one page, then more, moving focus to the first new row', async () => {
    expect(rows()).toHaveLength(PAGE_SIZE);
    expect(count()).toBe('250 things');
    const more = $('[data-lv-action="more"]');
    expect($('[data-lv-more]').hidden).toBe(false);
    expect(more.textContent).toContain('Show 100 more');
    more.click();
    expect(rows()).toHaveLength(200);
    expect(document.activeElement.closest('li').dataset.key).toBe('i100');
    $('[data-lv-action="more"]').click();
    expect(rows()).toHaveLength(250);
    expect($('[data-lv-more]').hidden).toBe(true);
  });

  it('labels the toolbar controls', () => {
    const input = $('[data-lv-search]');
    expect(input.type).toBe('search');
    expect($(`label[for="${input.id}"]`).textContent).toBe('Search things');
    expect(input.getAttribute('aria-describedby')).toBe('t-count');
    expect($('[data-lv-count]').getAttribute('role')).toBe('status');
    expect($$('.segmented__option')[0].getAttribute('aria-pressed')).toBe('true');
  });
});

describe('search and filter', () => {
  it('debounces the search, shows a clear button and a filtered count', async () => {
    const input = $('[data-lv-search]');
    input.value = 'Wort 12';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect($('[data-lv-action="clear"]').hidden).toBe(false);
    await wait(200);
    expect(rows().map((r) => r.dataset.key)).toEqual(['i12', 'i120', 'i121', 'i122', 'i123', 'i124', 'i125', 'i126', 'i127', 'i128', 'i129']);
    expect(count()).toBe('11 of 250 things');
    $('[data-lv-action="clear"]').click();
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(count()).toBe('250 things');
  });

  it('Enter in the search runs it at once', () => {
    const input = $('[data-lv-search]');
    input.value = 'Wort 249';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(rows().map((r) => r.dataset.key)).toEqual(['i249']);
  });

  it('Escape in the search clears it', async () => {
    const input = $('[data-lv-search]');
    input.value = 'nothing-like-this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    expect(rows()).toHaveLength(0);
    expect($('[data-lv-empty]').hidden).toBe(false);
    expect($('[data-lv-empty]').textContent).toContain('Nothing matches “nothing-like-this”.');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('');
    expect(rows()).toHaveLength(PAGE_SIZE);
  });

  it('segmented filter keeps focus on the pressed option', () => {
    const opt = $$('.segmented__option')[1];
    opt.focus();
    opt.click();
    expect(opt.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(opt);
    expect(count()).toBe('125 of 250 things');
    expect(rows().every((r) => r.querySelector('.lv-translation:not(.lv-translation--empty)'))).toBe(true);
  });

  it('“Clear search and filters” resets both', async () => {
    $$('.segmented__option')[1].click();
    const input = $('[data-lv-search]');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    $('[data-lv-action="reset"]').click();
    expect(list.state).toMatchObject({ q: '', filter: 'all' });
    expect($$('.segmented__option')[0].getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toHaveLength(PAGE_SIZE);
  });
});

describe('rows', () => {
  it('routes row actions through one delegated listener', () => {
    rows()[3].querySelector('[data-action="delete"]').click();
    expect(onAction).toHaveBeenCalledWith('delete', expect.objectContaining({ key: 'i3' }));
  });

  it('removed() focuses the first button of the row that took its place', () => {
    const btn = rows()[3].querySelector('[data-action="delete"]');
    btn.focus();
    data = data.filter((d) => d.id !== 'i3');
    list.removed('i3');
    expect(rows()[3].dataset.key).toBe('i4');
    expect(document.activeElement).toBe(rows()[3].querySelector('[data-action="edit"]'));
  });

  it('removed() on the last remaining row falls back to the search field', () => {
    data = data.slice(0, 1);
    list.render();
    data = [];
    list.removed('i0');
    expect(document.activeElement).toBe($('[data-lv-search]'));
  });

  it('refresh keeps focus on the same control of the same row', () => {
    const btn = rows()[5].querySelector('[data-action="delete"]');
    btn.focus();
    list.refresh();
    expect(document.activeElement.closest('li').dataset.key).toBe('i5');
    expect(document.activeElement.dataset.action).toBe('delete');
  });
});

describe('inline edit', () => {
  it('opens on Edit, saves on submit and returns focus to Edit', async () => {
    rows()[1].querySelector('[data-action="edit"]').click();
    const input = rows()[1].querySelector('input');
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('word 1');
    expect(input.getAttribute('lang')).toBe('en');
    expect($(`label[for="${input.id}"]`).textContent).toBe('Translation of “Wort 1”');
    input.value = 'Word one';
    input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await wait(0);
    expect(onSave).toHaveBeenCalledWith('i1', 'Word one', expect.anything());
    expect(rows()[1].querySelector('input')).toBeNull();
    expect(rows()[1].querySelector('.lv-translation').textContent).toBe('Word one');
    expect(document.activeElement).toBe(rows()[1].querySelector('[data-action="edit"]'));
  });

  it('Escape cancels without saving', () => {
    rows()[1].querySelector('[data-action="edit"]').click();
    const input = rows()[1].querySelector('input');
    input.value = 'changed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onSave).not.toHaveBeenCalled();
    expect(rows()[1].querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(rows()[1].querySelector('[data-action="edit"]'));
  });

  it('Translate again fills the input without saving', async () => {
    rows()[1].querySelector('[data-action="edit"]').click();
    rows()[1].querySelector('[data-edit-action="retranslate"]').click();
    await wait(0);
    await wait(0);
    expect(rows()[1].querySelector('input').value).toBe('fresh');
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('untilText', () => {
  it('counts study days, not 24-hour blocks', async () => {
    const { untilText } = await import('../../src/ui/views/listview.js');
    const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
    const now = at(11, 21); // Sunday 21:00
    expect(untilText(now + 20_000, now)).toBe('in a moment');
    expect(untilText(now + 10 * 60_000, now)).toBe('in 10 min');
    expect(untilText(at(12, 2), now)).toBe('in 5 hours'); // still tonight's study day
    expect(untilText(at(12, 4), now)).toBe('tomorrow');
    expect(untilText(at(13, 4), now)).toBe('in 2 days');
    expect(untilText(at(12, 4), at(11, 9))).toBe('tomorrow');
    expect(untilText(at(11, 9) + 90 * 86_400_000, at(11, 9))).toBe('in 3 months');
    expect(untilText(now + 59.7 * 60_000, now)).toBe('in 1 hour'); // not 'in 60 min'
  });
});

describe('undo', () => {
  it('runLastUndo runs the newest Undo of its own view, once', async () => {
    const { undoToast, runLastUndo } = await import('../../src/ui/views/listview.js');
    const first = vi.fn();
    const second = vi.fn();
    undoToast('Deleted “a”.', first, { scope: 'deck' });
    undoToast('Deleted “b”.', second, { scope: 'deck' });
    expect(runLastUndo('dictionary')).toBe(false);
    expect(runLastUndo('deck')).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(runLastUndo('deck')).toBe(false); // only the newest one
    // The toast's own button can't run it a second time.
    const btn = [...document.querySelectorAll('.toast__action')].find((b) => b.closest('.toast').textContent.includes('“b”'));
    if (btn) btn.click();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('applyParams', () => {
  it('updates the search field and the filter, ignoring unknown filters', () => {
    expect(list.applyParams({ q: 'Wort 1', filter: 'odd' })).toBe(true);
    expect($('[data-lv-search]').value).toBe('Wort 1');
    expect($$('.segmented__option')[1].getAttribute('aria-pressed')).toBe('true');
    expect(list.state).toMatchObject({ q: 'Wort 1', filter: 'odd' });
    expect(rows().every((r) => r.querySelector('.lv-term').textContent.startsWith('Wort 1'))).toBe(true);
    expect(list.applyParams({ filter: 'bogus' })).toBe(false);
    expect(list.applyParams({})).toBe(false);
    expect(list.state.filter).toBe('odd');
  });
});

describe('save errors', () => {
  it('a save that throws keeps the editor open with the typed text', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    onSave.mockImplementationOnce(() => { throw new Error('boom'); });
    rows()[1].querySelector('[data-action="edit"]').click();
    const input = rows()[1].querySelector('input');
    input.value = 'kept';
    input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await wait(0);
    expect(rows()[1].querySelector('input').value).toBe('kept');
    expect(document.activeElement).toBe(rows()[1].querySelector('input'));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('edit drafts', () => {
  it('a refresh keeps the text being typed', () => {
    rows()[1].querySelector('[data-action="edit"]').click();
    rows()[1].querySelector('input').value = 'half typed';
    list.refresh();
    expect(rows()[1].querySelector('input').value).toBe('half typed');
  });
});
