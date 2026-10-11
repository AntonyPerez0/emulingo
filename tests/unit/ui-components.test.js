// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/core/store.js', () => ({ store: { get: () => undefined, set: () => true, subscribe: () => () => {} } }));
vi.mock('../../src/core/language.js', () => ({
  LANGUAGES: [
    { code: 'de', name: 'German', endonym: 'Deutsch', ocr: 'neural', google: 'de' },
    { code: 'en', name: 'English', endonym: 'English', ocr: 'neural', google: 'en' },
    { code: 'ja', name: 'Japanese', endonym: '日本語', ocr: 'tesseract', google: 'ja' },
    { code: 'xx', name: 'Klingon', endonym: 'tlhIngan Hol', ocr: 'none', google: null },
  ],
  langName: (c) => c,
}));

const c = await import('../../src/ui/components.js');
const { render, $, $$ } = await import('../../src/ui/dom.js');

const mount = (tpl) => {
  document.body.innerHTML = '<div id="root"></div>';
  return render($('#root'), tpl);
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('fields', () => {
  it('field() links label, hint and error to the control', () => {
    const root = mount(c.field({
      id: 'name', label: 'Name', hint: 'As shown', error: 'Required',
      control: ({ id, describedBy, invalid }) => `${id}|${describedBy}|${invalid}`,
    }));
    expect($('label', root).getAttribute('for')).toBe('name');
    expect(root.textContent).toContain('name|name-hint name-error|true');
    expect($('#name-hint', root).textContent).toBe('As shown');
    expect($('#name-error', root).textContent).toContain('Required');
  });

  it('inputField() and selectField() produce named, described controls', () => {
    const root = mount(c.selectField({ id: 'speed', label: 'Scan speed', hint: 'How often', value: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: '<B>' }, { value: 'c', label: 'C', group: 'More', disabled: true }] }));
    const select = $('select', root);
    expect(select.id).toBe('speed');
    expect(select.getAttribute('aria-describedby')).toBe('speed-hint');
    expect(select.value).toBe('b');
    expect($$('option', root)[1].textContent).toBe('<B>');
    expect($('optgroup', root).getAttribute('label')).toBe('More');
    expect($('optgroup option', root).disabled).toBe(true);
    const root2 = mount(c.inputField({ id: 'q', label: 'Search', error: 'Too short', value: '"x"' }));
    const input = $('input', root2);
    expect(input.value).toBe('"x"');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('q-error');
  });

  it('switchField() is a role=switch checkbox named by its label, described by its hint', () => {
    const root = mount(c.switchField({ id: 'auto', label: 'Speak translations', hint: 'Uses your device voice', checked: true }));
    const input = $('input', root);
    expect(input.getAttribute('role')).toBe('switch');
    expect(input.checked).toBe(true);
    expect($(`#${input.getAttribute('aria-labelledby')}`, root).textContent).toBe('Speak translations');
    expect($(`#${input.getAttribute('aria-describedby')}`, root).textContent).toBe('Uses your device voice');
    expect(input.closest('label')).not.toBeNull();
  });

  it('rangeField() keeps aria-valuetext and the visible output in sync while sliding', () => {
    const fmt = (v) => `${v.toFixed(1)} seconds`;
    const root = mount(c.rangeField({ id: 'delay', label: 'Delay', min: 0.5, max: 3, step: 0.1, value: 1.2, format: fmt }));
    const input = $('input', root);
    expect(input.getAttribute('aria-valuetext')).toBe('1.2 seconds');
    expect($('output', root).textContent).toBe('1.2 seconds');
    input.value = '2.5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.getAttribute('aria-valuetext')).toBe('2.5 seconds');
    expect($('#delay-value', root).textContent).toBe('2.5 seconds');
  });

  it('segmented() exposes aria-pressed and emits change with the value', () => {
    const root = mount(c.segmented({ id: 'theme', label: 'Theme', value: 'system', options: [{ value: 'system', label: 'System', icon: 'monitor' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }] }));
    const group = $('#theme', root);
    expect(group.getAttribute('role')).toBe('group');
    expect($(`#${group.getAttribute('aria-labelledby')}`, root).textContent).toBe('Theme');
    const spy = vi.fn();
    group.addEventListener('change', (e) => spy(e.detail.value));
    $$('button', group)[2].click();
    expect(spy).toHaveBeenCalledWith('light');
    expect($$('button', group).map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    expect(group.dataset.value).toBe('light');
    $$('button', group)[2].click();
    expect(spy).toHaveBeenCalledTimes(1);
    c.setSegmented(group, 'dark');
    expect($$('button', group)[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('segmented() can carry a hint that describes the group', () => {
    const root = mount(c.segmented({ id: 'speed', label: 'Scan speed', hint: 'Faster uses more battery.', options: [{ value: 'normal', label: 'Normal' }], value: 'normal' }));
    const group = $('#speed', root);
    expect(document.getElementById(group.getAttribute('aria-describedby')).textContent).toBe('Faster uses more battery.');
    const plain = mount(c.segmented({ id: 'plain', label: 'Plain', options: [] }));
    expect($('#plain', plain).hasAttribute('aria-describedby')).toBe(false);
  });

  it('searchField() has a label even when it is visually hidden', () => {
    const root = mount(c.searchField({ id: 's', label: 'Search dictionary', placeholder: 'Word or translation' }));
    expect($('label', root).getAttribute('for')).toBe('s');
    expect($('label', root).className).toBe('visually-hidden');
    expect($('input', root).type).toBe('search');
  });
});

describe('buttons and busy state', () => {
  it('button() renders variants, icon-only labels and links', () => {
    const root = mount(c.button({ label: 'Delete “Hallo”', icon: 'trash-2', kind: 'danger', size: 'sm', iconOnly: true, action: 'delete' }));
    const b = $('button', root);
    expect(b.className).toBe('btn btn--danger btn--sm btn--icon');
    expect(b.getAttribute('aria-label')).toBe('Delete “Hallo”');
    expect(b.dataset.action).toBe('delete');
    expect(b.textContent.trim()).toBe('');
    const root2 = mount(c.button({ label: 'Start playing', href: '#/play', kind: 'primary' }));
    expect($('a', root2).getAttribute('href')).toBe('#/play');
  });

  it('setBusy() keeps focus-ability, blocks clicks and swaps the label', () => {
    const root = mount(c.button({ label: 'Translate pending', kind: 'primary' }));
    const b = $('button', root);
    const onClick = vi.fn();
    b.addEventListener('click', onClick);
    c.setBusy(b, true, { label: 'Translating 4 of 20…' });
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.disabled).toBe(false);
    expect(b.textContent).toContain('Translating 4 of 20…');
    b.click();
    expect(onClick).not.toHaveBeenCalled();
    c.setBusy(b, false);
    expect(b.textContent).toContain('Translate pending');
    b.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('iconButton() requires and applies a label', () => {
    const root = mount(c.iconButton({ label: 'Listen', icon: 'volume-2', size: 'sm' }));
    expect($('button', root).getAttribute('aria-label')).toBe('Listen');
    expect($('svg', root).getAttribute('aria-hidden')).toBe('true');
  });
});

describe('display components', () => {
  it('emptyState() renders icon, heading level, body and action', () => {
    const root = mount(c.emptyState({ icon: 'layers', title: 'No cards yet', body: 'Play to collect words.', level: 3, action: { label: 'Start playing', href: '#/play' } }));
    expect($('h3', root).textContent).toBe('No cards yet');
    expect($('.empty-state__icon', root).getAttribute('aria-hidden')).toBe('true');
    expect($('a.btn--primary', root).textContent).toContain('Start playing');
  });

  it('badge() and statusChip() validate their tone/state', () => {
    let root = mount(c.badge('Due now', 'accent'));
    expect($('.badge', root).className).toBe('badge badge--accent');
    root = mount(c.badge('x', 'bogus'));
    expect($('.badge', root).className).toBe('badge badge--neutral');
    root = mount(c.statusChip({ state: 'watching' }));
    const chip = $('.status-chip', root);
    expect(chip.dataset.state).toBe('watching');
    expect(chip.textContent.trim()).toBe('Watching');
    c.setStatusChip(chip, { state: 'error', label: 'Couldn’t read the screen' });
    expect(chip.dataset.state).toBe('error');
    expect(chip.textContent.trim()).toBe('Couldn’t read the screen');
    root = mount(c.statusChip({ state: 'nope' }));
    expect($('.status-chip', root).dataset.state).toBe('off');
  });

  it('progress() uses a labelled native <progress> and supports indeterminate', () => {
    let root = mount(c.progress({ value: 0.42, label: 'Downloading text recognition', id: 'p1' }));
    const bar = $('progress', root);
    expect(bar.getAttribute('value')).toBe('42');
    expect(bar.getAttribute('max')).toBe('100');
    expect($(`#${bar.getAttribute('aria-labelledby')}`, root).textContent).toBe('Downloading text recognition');
    c.setProgress($('.progress', root), 0.9, 'Almost done');
    expect(bar.value).toBe(90);
    expect($('.progress__label', root).textContent).toBe('Almost done');
    root = mount(c.progress({ label: 'Starting' }));
    expect($('progress', root).hasAttribute('value')).toBe(false);
  });

  it('banner(), kbd(), spinner() and skeleton() expose text for assistive tech', () => {
    let root = mount(c.banner({ tone: 'warning', title: 'This text looks English', body: 'Switch game language?' }));
    expect($('.banner', root).className).toBe('banner banner--warning');
    root = mount(c.kbd(['Shift', '?'], { hint: true }));
    expect($$('kbd', root).map((k) => k.textContent)).toEqual(['Shift', '?']);
    root = mount(c.spinner({ label: 'Looking up…' }));
    expect($('[role="status"]', root).textContent).toContain('Looking up…');
    root = mount(c.skeleton({ lines: 2 }));
    expect($$('.skeleton__line', root)).toHaveLength(2);
    expect($('[role="status"]', root).textContent).toBe('Loading…');
  });

  it('listToolbar() renders a polite count', () => {
    const root = mount(c.listToolbar({ search: c.searchField({ id: 'q', label: 'Search' }), count: { id: 'n', text: '3 results' } }));
    expect($('#n', root).getAttribute('role')).toBe('status');
  });
});

describe('langSelectOptions', () => {
  it('lists languages with endonyms and marks the selection', () => {
    const root = mount(c.selectField({ id: 'l', label: 'Translate into', options: c.langSelectOptions('en'), value: 'en' }));
    const opts = $$('option', root);
    expect(opts.map((o) => o.textContent)).toEqual(['German — Deutsch', 'English', 'Japanese — 日本語', 'Klingon — tlhIngan Hol']);
    expect($('select', root).value).toBe('en');
  });

  it('groups by OCR support, disables unsupported languages and supports a placeholder and filter', () => {
    const root = mount(c.selectField({ id: 'g', label: 'Game language', options: c.langSelectOptions(null, { group: 'ocr', placeholder: 'Choose a language', filter: (l) => l.code !== 'de' }) }));
    const groups = $$('optgroup', root);
    expect(groups.map((g) => g.getAttribute('label'))).toEqual(['Full support', 'Basic support — expect more misreads', 'Not supported yet']);
    expect($('optgroup:last-child option', root).disabled).toBe(true);
    const first = $('option', root);
    expect(first.textContent).toBe('Choose a language');
    expect(first.selected).toBe(true);
    expect(root.textContent).not.toContain('German');
  });
});

describe('menu', () => {
  const items = [{ action: 'restart', label: 'Restart…', icon: 'rotate-ccw' }, 'separator', { action: 'eject', label: 'Eject game', icon: 'eject', danger: true }, { action: 'help', label: 'Keyboard help' }];
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('opens with focus on the first item, moves with arrows and type-ahead, closes on Escape', () => {
    const root = mount(c.menu({ id: 'more', label: 'More actions', items }));
    const trigger = $('#more', root);
    const list = $('#more-menu', root);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(list.hidden).toBe(true);
    trigger.click();
    expect(list.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement.dataset.action).toBe('restart');
    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement.dataset.action).toBe('eject');
    key(document.activeElement, 'End');
    expect(document.activeElement.dataset.action).toBe('help');
    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement.dataset.action).toBe('restart');
    key(document.activeElement, 'e');
    expect(document.activeElement.dataset.action).toBe('eject');
    key(document.activeElement, 'Escape');
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    key(trigger, 'ArrowUp');
    expect(document.activeElement.dataset.action).toBe('help');
  });

  it('closes and returns focus to the trigger before item handlers run', () => {
    const root = mount(c.menu({ id: 'm2', label: 'More', items }));
    const trigger = $('#m2', root);
    let focusedDuringHandler = null;
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="restart"]')) focusedDuringHandler = document.activeElement;
    });
    trigger.click();
    $('[data-action="restart"]', root).click();
    expect(focusedDuringHandler).toBe(trigger);
    expect($('#m2-menu', root).hidden).toBe(true);
  });

  it('survives Safari-style clicks that blur the focused item before the click arrives', () => {
    const root = mount(c.menu({ id: 'm4', label: 'More', items }));
    const trigger = $('#m4', root);
    const list = $('#m4-menu', root);
    const seen = [];
    root.addEventListener('click', (e) => { const a = e.target.closest('[data-action]'); if (a) seen.push(a.dataset.action); });
    const press = (el) => {
      el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      // Safari doesn't focus buttons on click: the focused item just blurs (relatedTarget null).
      document.activeElement.blur();
      el.dispatchEvent(new Event('pointerup', { bubbles: true }));
      el.click();
    };
    trigger.click();
    expect(document.activeElement.dataset.action).toBe('restart');
    press($('[data-action="eject"]', root));
    expect(seen).toEqual(['eject']);
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    // Clicking the trigger of an open menu closes it (instead of closing on blur and reopening).
    trigger.click();
    expect(list.hidden).toBe(false);
    press(trigger);
    expect(list.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('Tab closes the menu and continues from its button', () => {
    const root = mount(c.menu({ id: 'm6', label: 'More', items }));
    const trigger = $('#m6', root);
    trigger.click();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect($('#m6-menu', root).hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when focus leaves the menu by keyboard', () => {
    const root = mount(c.menu({ id: 'm5', label: 'More', items }));
    root.insertAdjacentHTML('beforeend', '<button id="next">Next</button>');
    $('#m5', root).click();
    $('#next', root).focus();
    expect($('#m5-menu', root).hidden).toBe(true);
  });

  it('closes when clicking elsewhere', () => {
    const root = mount(c.menu({ id: 'm3', label: 'More', items }));
    root.insertAdjacentHTML('beforeend', '<button id="other">Other</button>');
    $('#m3', root).click();
    $('#other', root).click();
    expect($('#m3-menu', root).hidden).toBe(true);
  });
});

describe('menu inside a dialog', () => {
  it('Escape closes only the menu, not the surrounding dialog', async () => {
    const { openDialog } = await import('../../src/ui/dialog.js');
    const proto = window.HTMLDialogElement.prototype;
    proto.showModal = function showModal() { this.setAttribute('open', ''); };
    proto.close = function close() { if (this.hasAttribute('open')) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } };
    document.body.innerHTML = '<main></main>';
    const dlg = openDialog({ title: 'T', content: c.menu({ id: 'dm', label: 'More', items: [{ action: 'a', label: 'A' }] }) });
    document.getElementById('dm').click();
    const item = document.querySelector('[data-action="a"]');
    expect(document.activeElement).toBe(item);
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.getElementById('dm-menu').hidden).toBe(true);
    expect(document.querySelector('dialog')).not.toBeNull();
    dlg.close();
  });
});
