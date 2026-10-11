// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: { shortcuts: true } }));
vi.mock('../../src/core/store.js', () => ({
  store: {
    get: (k) => state.settings[k],
    set: (k, v) => { state.settings[k] = v; return true; },
    subscribe: () => () => {},
  },
}));

const { announce, focusHeading, registerShortcut, shortcutsEnabled, installEmulatorFocusRelease, listShortcuts, keyLabelParts, initA11y, focusableIn } = await import('../../src/ui/a11y.js');

function installDialogPolyfill() {
  const proto = window.HTMLDialogElement.prototype;
  proto.showModal = function showModal() { this.setAttribute('open', ''); this._modal = true; };
  proto.close = function close() { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  const matches = Element.prototype.matches;
  Element.prototype.matches = function m(sel) {
    if (sel === ':modal') return !!this._modal && this.hasAttribute('open');
    return matches.call(this, sel);
  };
}
installDialogPolyfill();
Element.prototype.checkVisibility = function checkVisibility() { return true; };

const key = (target, k, opts = {}) => {
  const e = new KeyboardEvent(opts.type || 'keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  state.settings = { shortcuts: true };
  document.body.innerHTML = `
    <div id="sr-status" role="status"></div><div id="sr-alert" role="alert"></div>
    <main id="main"><section data-view="review"><h1>Review</h1><button id="btn">B</button><input id="field"></section></main>`;
  document.body.dataset.view = 'review';
});

describe('announce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes polite and assertive messages to their regions after clearing', () => {
    const status = document.getElementById('sr-status');
    status.textContent = 'old';
    announce('Card added');
    expect(status.textContent).toBe('');
    vi.advanceTimersByTime(150);
    expect(status.textContent).toBe('Card added');
    announce('Could not save', { assertive: true });
    vi.advanceTimersByTime(150);
    expect(document.getElementById('sr-alert').textContent).toBe('Could not save');
  });

  it('drops an identical message within the dedupe window and allows it afterwards', () => {
    const status = document.getElementById('sr-status');
    announce('Saved');
    vi.advanceTimersByTime(150);
    status.textContent = 'x';
    announce('Saved');
    vi.advanceTimersByTime(150);
    expect(status.textContent).toBe('x');
    vi.advanceTimersByTime(2000);
    announce('Saved');
    vi.advanceTimersByTime(150);
    expect(status.textContent).toBe('Saved');
  });

  it('merges messages queued in the same frame and clears later', () => {
    const status = document.getElementById('sr-status');
    announce('First.');
    announce('Second.');
    vi.advanceTimersByTime(150);
    expect(status.textContent).toBe('First. Second.');
    vi.advanceTimersByTime(9000);
    expect(status.textContent).toBe('');
  });

  it('speaks into the open dialog’s own regions while a modal is open', () => {
    document.body.insertAdjacentHTML('beforeend', '<dialog open><div data-live="polite"></div><div data-live="assertive"></div></dialog>');
    announce('Import finished');
    announce('Import failed', { assertive: true });
    vi.advanceTimersByTime(150);
    const d = document.querySelector('dialog');
    expect(d.querySelector('[data-live="polite"]').textContent).toBe('Import finished');
    expect(d.querySelector('[data-live="assertive"]').textContent).toBe('Import failed');
    expect(document.getElementById('sr-status').textContent).toBe('');
    // Closed before the message lands: it goes to the page's region instead.
    announce('Saved after close');
    d.remove();
    vi.advanceTimersByTime(150);
    expect(document.getElementById('sr-status').textContent).toBe('Saved after close');
  });

  it('ignores empty messages', () => {
    announce('   ');
    vi.advanceTimersByTime(150);
    expect(document.getElementById('sr-status').textContent).toBe('');
  });

  it('marks game text and translations with their language (WCAG 3.1.2)', () => {
    announce([{ text: 'Ein wildes TAUBSI erscheint!', lang: 'de' }, 'English:', { text: 'A wild PIDGEY appears!', lang: 'en' }]);
    vi.advanceTimersByTime(150);
    const region = document.getElementById('sr-status');
    expect(region.textContent).toBe('Ein wildes TAUBSI erscheint! English: A wild PIDGEY appears!');
    expect(Array.from(region.querySelectorAll('span[lang]')).map((s) => [s.lang, s.textContent])).toEqual([
      ['de', 'Ein wildes TAUBSI erscheint!'], ['en', 'A wild PIDGEY appears!'],
    ]);
  });
});

describe('focusHeading', () => {
  it('focuses the view h1 and makes it programmatically focusable', () => {
    const h = focusHeading(document.querySelector('[data-view="review"]'));
    expect(document.activeElement).toBe(h);
    expect(h.tagName).toBe('H1');
    expect(h.getAttribute('tabindex')).toBe('-1');
  });
});

describe('registerShortcut', () => {
  let offs = [];
  const reg = (opts) => { const off = registerShortcut(opts); offs.push(off); return off; };
  afterEach(() => { offs.forEach((off) => off()); offs = []; document.querySelectorAll('dialog').forEach((d) => d.remove()); });

  it('runs global and current-view shortcuts and prevents the default', () => {
    const g = vi.fn();
    const r = vi.fn();
    const d = vi.fn();
    reg({ key: 't', label: 'Translate', scope: 'global', handler: g });
    reg({ key: '1', label: 'Again', scope: 'review', handler: r });
    reg({ key: '2', label: 'Other view', scope: 'deck', handler: d });
    const e = key(document.body, 'T');
    key(document.body, '1');
    key(document.body, '2');
    expect(g).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(r).toHaveBeenCalledTimes(1);
    expect(d).not.toHaveBeenCalled();
  });

  it('prefers the view-scoped shortcut over a global one with the same key', () => {
    const g = vi.fn();
    const v = vi.fn();
    reg({ key: 's', scope: 'global', handler: g });
    reg({ key: 's', scope: 'review', handler: v });
    key(document.body, 's');
    expect(v).toHaveBeenCalled();
    expect(g).not.toHaveBeenCalled();
  });

  it('ignores keys typed in fields, Enter/Space on buttons, modifiers and repeats', () => {
    const fn = vi.fn();
    reg({ key: 'Space', scope: 'review', handler: fn });
    reg({ key: 'k', scope: 'review', handler: fn });
    key(document.getElementById('field'), 'k');
    key(document.getElementById('btn'), ' ');
    key(document.body, 'k', { ctrlKey: true });
    key(document.body, 'k', { repeat: true });
    expect(fn).not.toHaveBeenCalled();
    key(document.body, ' ');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can be switched off for character keys only (WCAG 2.1.4)', () => {
    const ch = vi.fn();
    const esc = vi.fn();
    reg({ key: 'p', scope: 'global', handler: ch });
    reg({ key: 'Escape', scope: 'global', handler: esc });
    state.settings.shortcuts = false;
    expect(shortcutsEnabled()).toBe(false);
    key(document.body, 'p');
    key(document.body, 'Escape');
    expect(ch).not.toHaveBeenCalled();
    expect(esc).toHaveBeenCalled();
  });

  it('respects handlers that return false and stops when unregistered', () => {
    const fn = vi.fn(() => false);
    const off = reg({ key: 'x', handler: fn });
    const e = key(document.body, 'x');
    expect(fn).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    off();
    key(document.body, 'x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('only runs allowInGame shortcuts inside #game, before the emulator sees the key', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="game" tabindex="0"><canvas></canvas></div>');
    const game = document.getElementById('game');
    const emulator = vi.fn();
    game.addEventListener('keydown', emulator);
    const normal = vi.fn();
    const inGame = vi.fn();
    reg({ key: 'n', handler: normal });
    reg({ key: 'g', handler: inGame, allowInGame: true });
    key(game, 'n');
    expect(normal).not.toHaveBeenCalled();
    expect(emulator).toHaveBeenCalledTimes(1);
    key(game, 'g');
    expect(inGame).toHaveBeenCalledTimes(1);
    expect(emulator).toHaveBeenCalledTimes(1);
  });

  it('is ignored while a modal dialog is open', () => {
    const fn = vi.fn();
    reg({ key: 'z', handler: fn });
    const dlg = document.createElement('dialog');
    document.body.appendChild(dlg);
    dlg.showModal();
    key(document.body, 'z');
    expect(fn).not.toHaveBeenCalled();
  });

  it('parses combos and lists shortcuts for help', () => {
    reg({ key: 'Shift+ArrowLeft', label: 'Back', scope: 'review', handler: () => {} });
    expect(keyLabelParts('Shift+ArrowLeft')).toEqual(['Shift', '←']);
    expect(keyLabelParts('Space')).toEqual(['Space']);
    expect(keyLabelParts('Ctrl+k')).toEqual(['Ctrl', 'K']);
    expect(listShortcuts().some((s) => s.label === 'Back' && s.scope === 'review')).toBe(true);
  });

  it("'?' opens a help dialog listing the current view's and global shortcuts", () => {
    initA11y();
    reg({ key: '1', label: 'Again', scope: 'review', handler: () => {} });
    reg({ key: 'q', label: 'Elsewhere', scope: 'deck', handler: () => {} });
    key(document.body, '?', { shiftKey: true });
    const dlg = document.querySelector('dialog[open]');
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).toContain('Keyboard shortcuts');
    expect(dlg.textContent).toContain('Again');
    expect(dlg.textContent).toContain('Show keyboard shortcuts');
    expect(dlg.textContent).not.toContain('Elsewhere');
    dlg.querySelector('.dialog__footer button').click();
  });
});

describe('installEmulatorFocusRelease', () => {
  let off;
  beforeEach(() => {
    document.body.innerHTML = `
      <div role="toolbar" id="tb"><button id="first">Translate now</button><button id="mid" disabled>Save</button><button id="last">More</button></div>
      <div id="game" tabindex="0"><canvas></canvas><div class="ejs_menu_bar"><button id="ejs-pause" class="ejs_menu_button">Pause</button></div></div>
      <button id="after">After</button>`;
  });
  afterEach(() => off && off());

  it('moves Tab and Shift+Tab from the game to the toolbar ends, past EmulatorJS’s listener', () => {
    const game = document.getElementById('game');
    const ejs = vi.fn((e) => e.preventDefault());
    game.addEventListener('keydown', ejs);
    off = installEmulatorFocusRelease({ gameEl: game, toolbarEl: document.getElementById('tb') });
    game.focus();
    const e = key(game, 'Tab');
    expect(document.activeElement.id).toBe('first');
    expect(e.defaultPrevented).toBe(true);
    game.focus();
    key(game, 'Tab', { shiftKey: true });
    expect(document.activeElement.id).toBe('last');
    expect(ejs).not.toHaveBeenCalled();
  });

  it('Shift+Tab leaves for the control before the game when the toolbar follows it (no loop)', () => {
    document.body.innerHTML = `
      <a id="skip" href="#live">Skip</a>
      <div id="game" tabindex="0"><canvas></canvas><button id="ejs-pause">Pause</button></div>
      <div id="tb"><button id="first">Translate now</button><button id="last">More</button></div>`;
    const game = document.getElementById('game');
    off = installEmulatorFocusRelease({ gameEl: game, toolbarEl: document.getElementById('tb') });
    game.focus();
    const e = key(game, 'Tab', { shiftKey: true });
    expect(document.activeElement.id).toBe('skip');
    expect(e.defaultPrevented).toBe(true);
    game.focus();
    key(game, 'Tab');
    expect(document.activeElement.id).toBe('first');
  });

  it('Escape calls onEscape (default: first toolbar control)', () => {
    const game = document.getElementById('game');
    const onEscape = vi.fn();
    off = installEmulatorFocusRelease({ gameEl: game, toolbarEl: document.getElementById('tb'), onEscape });
    key(game, 'Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
    off();
    off = installEmulatorFocusRelease({ gameEl: game, toolbarEl: document.getElementById('tb') });
    game.focus();
    key(game, 'Escape');
    expect(document.activeElement.id).toBe('first');
  });

  it('lets Enter/Space reach EmulatorJS buttons natively but keeps game keys for the game', () => {
    const game = document.getElementById('game');
    const ejs = vi.fn();
    game.addEventListener('keydown', ejs);
    off = installEmulatorFocusRelease({ gameEl: game, toolbarEl: document.getElementById('tb') });
    key(document.getElementById('ejs-pause'), 'Enter');
    expect(ejs).not.toHaveBeenCalled();
    key(game, 'ArrowUp');
    key(game, 'x');
    expect(ejs).toHaveBeenCalledTimes(2);
  });

  it('redirects keyboard focus that lands on an EmulatorJS control from outside to #game', () => {
    const game = document.getElementById('game');
    off = installEmulatorFocusRelease({ gameEl: game, toolbarEl: document.getElementById('tb') });
    const after = document.getElementById('after');
    after.focus();
    key(after, 'Tab', { shiftKey: true });
    document.getElementById('ejs-pause').focus();
    expect(document.activeElement).toBe(game);
  });

  it('focusableIn skips disabled controls', () => {
    expect(focusableIn(document.getElementById('tb')).map((b) => b.id)).toEqual(['first', 'last']);
  });
});
