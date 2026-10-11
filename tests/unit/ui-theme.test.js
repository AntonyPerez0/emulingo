// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const env = vi.hoisted(() => ({ settings: { theme: 'system' }, listeners: new Set(), mqListeners: new Set(), prefersLight: false }));

vi.mock('../../src/core/store.js', () => ({
  store: {
    get: (k) => env.settings[k],
    set: (k, v) => { env.settings[k] = v; env.listeners.forEach((fn) => fn(k, v)); return true; },
    subscribe: (fn) => { env.listeners.add(fn); return () => env.listeners.delete(fn); },
  },
}));

window.matchMedia = (q) => ({
  media: q,
  get matches() { return env.prefersLight; },
  addEventListener: (_t, fn) => env.mqListeners.add(fn),
  removeEventListener: (_t, fn) => env.mqListeners.delete(fn),
});

const { initTheme, resolveTheme, applyTheme } = await import('../../src/ui/theme.js');
const { store } = await import('../../src/core/store.js');

const metas = () => Array.from(document.querySelectorAll('meta[name="theme-color"]'));

beforeEach(() => {
  env.settings.theme = 'system';
  env.prefersLight = false;
  document.head.innerHTML = '<meta name="theme-color" content="#0b0f17" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f6f7fb" media="(prefers-color-scheme: light)">';
  delete document.documentElement.dataset.theme;
});

describe('theme', () => {
  it('resolves system preference and explicit choices', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('system')).toBe('dark');
    env.prefersLight = true;
    expect(resolveTheme('system')).toBe('light');
  });

  it('applies data-theme from the store and follows store and OS changes', () => {
    expect(initTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    store.set('theme', 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themePref).toBe('light');
    env.prefersLight = false;
    env.mqListeners.forEach((fn) => fn());
    expect(document.documentElement.dataset.theme).toBe('light');
    store.set('theme', 'system');
    env.prefersLight = true;
    env.mqListeners.forEach((fn) => fn());
    expect(document.documentElement.dataset.theme).toBe('light');
    env.prefersLight = false;
    env.mqListeners.forEach((fn) => fn());
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('keeps both theme-color metas in step with a forced theme and restores them for system', () => {
    applyTheme('light');
    expect(metas().map((m) => [m.getAttribute('content'), m.getAttribute('media')])).toEqual([['#f6f7fb', null], ['#f6f7fb', null]]);
    applyTheme('system');
    expect(metas().map((m) => [m.getAttribute('content'), m.getAttribute('media')])).toEqual([
      ['#0b0f17', '(prefers-color-scheme: dark)'],
      ['#f6f7fb', '(prefers-color-scheme: light)'],
    ]);
  });

  it('treats unknown stored values as system', () => {
    env.settings.theme = 'neon';
    expect(applyTheme()).toBe('dark');
    expect(document.documentElement.dataset.themePref).toBe('system');
  });
});
