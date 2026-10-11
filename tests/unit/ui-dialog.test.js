// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { html } from '../../src/ui/dom.js';
import { openDialog, confirmDialog } from '../../src/ui/dialog.js';

// jsdom has no <dialog> behaviour: a minimal showModal/close that mirrors the events we rely on.
const proto = window.HTMLDialogElement.prototype;
proto.showModal = function showModal() { this.setAttribute('open', ''); };
proto.close = function close() {
  if (!this.hasAttribute('open')) return;
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};
Object.defineProperty(proto, 'open', { configurable: true, get() { return this.hasAttribute('open'); } });

const dlg = () => document.querySelector('dialog');
const press = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

beforeEach(() => {
  document.body.innerHTML = '<main><section data-view="settings"><h1>Settings</h1><button id="opener">Erase…</button></section></main>';
  document.documentElement.className = '';
});

describe('openDialog', () => {
  it('renders a labelled modal, locks scroll and focuses the first field', () => {
    document.getElementById('opener').focus();
    const d = openDialog({ title: 'Languages', content: html`<label for="s">Game</label><select id="s"><option>de</option></select>`, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary' }] });
    expect(dlg().hasAttribute('open')).toBe(true);
    const titleId = dlg().getAttribute('aria-labelledby');
    expect(document.getElementById(titleId).textContent).toBe('Languages');
    expect(document.documentElement.classList.contains('has-modal')).toBe(true);
    expect(document.activeElement.id).toBe('s');
    d.close();
    expect(document.documentElement.classList.contains('has-modal')).toBe(false);
  });

  it('closes with the action value and returns focus to the opener', async () => {
    const opener = document.getElementById('opener');
    opener.focus();
    const d = openDialog({ title: 'T', content: 'Body text', actions: [{ label: 'Keep', value: 'keep' }, { label: 'Go', kind: 'primary', value: 'go' }] });
    expect(dlg().querySelector('.dialog__body').textContent).toContain('Body text');
    dlg().querySelectorAll('.dialog__footer button')[1].click();
    expect(await d.closed).toBe('go');
    expect(dlg()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the dialog open when an action returns false', async () => {
    const onClick = vi.fn(() => false);
    openDialog({ title: 'T', actions: [{ label: 'Save', kind: 'primary', onClick }] });
    dlg().querySelector('.dialog__footer button').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onClick).toHaveBeenCalled();
    expect(dlg()).not.toBeNull();
  });

  it('runs an async action once even when clicked twice, while Cancel still closes', async () => {
    let finish;
    const onClick = vi.fn(() => new Promise((r) => { finish = r; }));
    const d = openDialog({ title: 'Import', actions: [{ label: 'Cancel', value: false }, { label: 'Import', kind: 'primary', onClick }] });
    const [cancel, ok] = dlg().querySelectorAll('.dialog__footer button');
    ok.click();
    ok.click();
    await Promise.resolve();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ok.getAttribute('aria-busy')).toBe('true');
    cancel.click();
    expect(await d.closed).toBe(false);
    finish();
    await Promise.resolve();
    expect(ok.hasAttribute('aria-busy')).toBe(false);
  });

  it('also accepts openDialog(content, { title })', async () => {
    const node = document.createElement('p');
    node.textContent = 'From a node';
    const d = openDialog(node, { title: 'Alias' });
    expect(dlg().querySelector('.dialog__title').textContent).toBe('Alias');
    expect(dlg().querySelector('.dialog__body').textContent).toContain('From a node');
    d.close();
  });

  it('carries its own live regions, because the page behind a modal is inert', () => {
    openDialog({ title: 'T' });
    expect(dlg().querySelector('[data-live="polite"][role="status"]')).not.toBeNull();
    expect(dlg().querySelector('[data-live="assertive"][role="alert"]')).not.toBeNull();
  });

  it('Escape and the close button dismiss with undefined; non-dismissible ignores Escape', async () => {
    let d = openDialog({ title: 'T' });
    press(dlg(), 'Escape');
    expect(await d.closed).toBeUndefined();
    d = openDialog({ title: 'T' });
    dlg().querySelector('[data-dialog-close]').click();
    expect(await d.closed).toBeUndefined();
    d = openDialog({ title: 'T', dismissible: false });
    expect(dlg().querySelector('[data-dialog-close]')).toBeNull();
    press(dlg(), 'Escape');
    expect(dlg()).not.toBeNull();
    d.close('x');
    expect(await d.closed).toBe('x');
  });

  it('falls back to the view heading when the opener is gone', async () => {
    const opener = document.getElementById('opener');
    opener.focus();
    const d = openDialog({ title: 'T' });
    opener.remove();
    d.close();
    await d.closed;
    expect(document.activeElement.tagName).toBe('H1');
  });

  it('closes on a backdrop click only when the press started on the backdrop', async () => {
    const d = openDialog({ title: 'T', content: html`<p id="p">x</p>` });
    const el = dlg();
    el.querySelector('#p').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dlg()).not.toBeNull();
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await d.closed).toBeUndefined();
  });

  it('makes a body that scrolls with nothing focusable inside keyboard-focusable (WCAG 2.1.1)', () => {
    const sh = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'scrollHeight');
    const ch = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList.contains('dialog__body') ? 900 : 0; } });
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList.contains('dialog__body') ? 200 : 0; } });
    try {
      const d = openDialog({ title: 'Keyboard shortcuts', content: html`<dl><dt>T</dt><dd>Translate now</dd></dl>` });
      const body = dlg().querySelector('.dialog__body');
      expect(body.tabIndex).toBe(0);
      expect(body.getAttribute('role')).toBe('region');
      expect(document.getElementById(body.getAttribute('aria-labelledby')).textContent).toBe('Keyboard shortcuts');
      d.close();
      // a scrolling body with a field inside needs no extra tab stop
      openDialog({ title: 'Form', content: html`<input id="f" aria-label="Name">` });
      expect(dlg().querySelector('.dialog__body').hasAttribute('tabindex')).toBe(false);
    } finally {
      if (sh) Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', sh); else delete window.HTMLElement.prototype.scrollHeight;
      if (ch) Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', ch); else delete window.HTMLElement.prototype.clientHeight;
    }
  });

  it('accepts a DOM node as content and escapes string titles', () => {
    const node = document.createElement('p');
    node.textContent = 'node content';
    openDialog({ title: '<b>x</b>', content: node });
    expect(dlg().querySelector('.dialog__title b')).toBeNull();
    expect(dlg().querySelector('.dialog__body').textContent).toBe('node content');
  });
});

describe('confirmDialog', () => {
  it('focuses Cancel, never the destructive button, and resolves false on cancel', async () => {
    const p = confirmDialog({ title: 'Delete this game?', body: 'Its saves are deleted too.', confirmLabel: 'Delete', danger: true });
    const buttons = dlg().querySelectorAll('.dialog__footer button');
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[1].classList.contains('btn--danger')).toBe(true);
    const desc = dlg().getAttribute('aria-describedby');
    expect(document.getElementById(desc).textContent).toBe('Its saves are deleted too.');
    buttons[0].click();
    expect(await p).toBe(false);
  });

  it('resolves true on confirm and false on Escape', async () => {
    let p = confirmDialog({ title: 'Restart game?', confirmLabel: 'Restart' });
    dlg().querySelectorAll('.dialog__footer button')[1].click();
    expect(await p).toBe(true);
    p = confirmDialog({ title: 'Restart game?' });
    press(dlg(), 'Escape');
    expect(await p).toBe(false);
  });

  it('accepts a DOM node as the confirm body and describes the dialog with it', async () => {
    const body = document.createElement('ul');
    body.innerHTML = '<li>12 cards</li>';
    const result = confirmDialog({ title: 'Replace?', body, confirmLabel: 'Replace' });
    const d = dlg();
    const desc = document.getElementById(d.getAttribute('aria-describedby'));
    expect(desc.textContent).toBe('12 cards');
    press(d, 'Escape');
    expect(await result).toBe(false);
  });

  it('requireText keeps confirm disabled until the word is typed', async () => {
    const p = confirmDialog({ title: 'Erase all data?', body: 'This can’t be undone.', confirmLabel: 'Erase everything', danger: true, requireText: 'ERASE' });
    const input = dlg().querySelector('input');
    const ok = dlg().querySelectorAll('.dialog__footer button')[1];
    expect(document.activeElement).toBe(input);
    expect(ok.disabled).toBe(true);
    ok.click();
    expect(dlg()).not.toBeNull();
    input.value = 'eras';
    input.dispatchEvent(new Event('input'));
    press(input, 'Enter');
    expect(dlg()).not.toBeNull();
    input.value = 'erase ';
    input.dispatchEvent(new Event('input'));
    expect(ok.disabled).toBe(false);
    press(input, 'Enter');
    expect(await p).toBe(true);
  });
});
