// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/core/store.js', () => ({ store: { get: () => undefined, set: () => true, subscribe: () => () => {} } }));

const { toast, dismissAllToasts } = await import('../../src/ui/toast.js');

const region = () => document.getElementById('toast-region');
const visible = () => Array.from(region().querySelectorAll('.toast:not([data-leaving])'));

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<main id="main"><section data-view="play"><h1>Play</h1><button id="b">x</button></section></main>
    <section class="toast-region" id="toast-region" aria-label="Notifications"></section>
    <div id="sr-status"></div><div id="sr-alert"></div>`;
});

afterEach(() => {
  dismissAllToasts();
  vi.advanceTimersByTime(1000);
  vi.useRealTimers();
});

describe('toast', () => {
  it('renders kind, icon, message and a labelled close button, and announces it', () => {
    toast('Card added to your deck', { kind: 'success' });
    const el = visible()[0];
    expect(el.classList.contains('toast--success')).toBe(true);
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.querySelector('.toast__message').textContent).toBe('Card added to your deck');
    expect(el.querySelector('.toast__close').getAttribute('aria-label')).toBe('Dismiss notification');
    vi.advanceTimersByTime(150);
    expect(document.getElementById('sr-status').textContent).toBe('Card added to your deck');
  });

  it('escapes message text', () => {
    toast('<img src=x onerror=alert(1)>');
    expect(region().querySelector('img')).toBeNull();
  });

  it('announces errors assertively, prefixes them for screen readers and keeps them until dismissed', () => {
    const t = toast('Couldn’t load the game', { kind: 'error', timeout: 2000 });
    vi.advanceTimersByTime(150);
    expect(document.getElementById('sr-alert').textContent).toBe('Couldn’t load the game');
    expect(visible()[0].querySelector('.visually-hidden').textContent).toBe('Error: ');
    vi.advanceTimersByTime(60000);
    expect(visible()).toHaveLength(1);
    t.dismiss();
    expect(visible()).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(region().children).toHaveLength(0);
  });

  it('gives info toasts at least 5 s and removes them afterwards', () => {
    toast('Saved', { timeout: 1000 });
    vi.advanceTimersByTime(4900);
    expect(visible()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(visible()).toHaveLength(0);
  });

  it('timeout 0 keeps a toast until dismissed', () => {
    toast('Update available', { timeout: 0 });
    vi.advanceTimersByTime(120000);
    expect(visible()).toHaveLength(1);
  });

  it('pauses while hovered or focused', () => {
    toast('Saved');
    const el = visible()[0];
    vi.advanceTimersByTime(3000);
    el.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(20000);
    expect(visible()).toHaveLength(1);
    el.dispatchEvent(new MouseEvent('mouseleave'));
    el.querySelector('.toast__close').focus();
    vi.advanceTimersByTime(20000);
    expect(visible()).toHaveLength(1);
    document.getElementById('b').focus();
    vi.advanceTimersByTime(3200);
    expect(visible()).toHaveLength(0);
  });

  it('runs the action, then dismisses; action toasts last at least 10 s', async () => {
    const onClick = vi.fn();
    toast('Card deleted', { action: { label: 'Undo', onClick } });
    vi.advanceTimersByTime(150);
    expect(document.getElementById('sr-status').textContent).toBe('Card deleted Undo available.');
    vi.advanceTimersByTime(8850);
    expect(visible()).toHaveLength(1);
    visible()[0].querySelector('.toast__action').click();
    await Promise.resolve();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(visible()).toHaveLength(0);
  });

  it('accepts action.fn as an alias for action.onClick', async () => {
    const fn = vi.fn();
    toast('Removed', { action: { label: 'Undo', fn } });
    region().querySelector('.toast__action').click();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('dedupes identical visible toasts and restarts their timer', () => {
    const a = toast('Saved');
    vi.advanceTimersByTime(4000);
    const b = toast('Saved');
    expect(b).toBe(a);
    expect(visible()).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(visible()).toHaveLength(1);
  });

  it('repeating a toast that holds keyboard focus does not steal that focus', () => {
    toast('Card deleted', { action: { label: 'Undo', onClick: () => {} } });
    toast('Something else');
    const undo = region().querySelector('.toast__action');
    undo.focus();
    toast('Card deleted', { action: { label: 'Undo', onClick: () => {} } });
    expect(document.activeElement).toBe(undo);
    expect(visible()).toHaveLength(2);
  });

  it('shows at most three, dropping the oldest non-error first', () => {
    toast('Error one', { kind: 'error' });
    toast('Info one');
    toast('Info two');
    toast('Info three');
    const texts = visible().map((t) => t.querySelector('.toast__message').textContent);
    expect(texts).toEqual(['Error: Error one', 'Info two', 'Info three']);
  });

  it('moves focus somewhere sensible when a focused toast closes', () => {
    toast('Saved', { timeout: 0 });
    const close = visible()[0].querySelector('.toast__close');
    close.focus();
    close.click();
    expect(document.activeElement.tagName).toBe('H1');
  });

  it('returns focus to where it came from rather than jumping to the top', () => {
    toast('Card deleted.', { timeout: 0 });
    document.getElementById('b').focus();
    const close = visible()[0].querySelector('.toast__close');
    close.focus();
    close.click();
    expect(document.activeElement.id).toBe('b');
  });

  it('reports its footprint as scroll padding so focus is never hidden under it (WCAG 2.4.11)', () => {
    const observers = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} });
    try {
      region().getBoundingClientRect = () => ({ top: 64, bottom: 150, height: 86 });
      toast('Couldn’t save your changes.', { kind: 'error' });
      observers.forEach((o) => o.cb());
      const css = document.documentElement.style;
      expect(css.getPropertyValue('--toast-top')).toBe('150px');
      expect(css.getPropertyValue('--toast-bottom')).toBe('0px');
      region().getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0 });
      observers.forEach((o) => o.cb());
      expect(css.getPropertyValue('--toast-top')).toBe('0px');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates the region if the page lacks one and ignores empty messages', () => {
    document.getElementById('toast-region').remove();
    expect(toast('').el).toBeNull();
    toast('Hello');
    expect(document.getElementById('toast-region').getAttribute('aria-label')).toBe('Notifications');
  });
});
