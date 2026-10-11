// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const env = vi.hoisted(() => ({ settings: { source: null, target: 'en' }, listeners: new Set(), browser: ['en-US'] }));

vi.mock('../../src/core/store.js', () => ({
  store: {
    get: (k) => env.settings[k],
    set: (k, v) => { env.settings[k] = v; env.listeners.forEach((fn) => fn(k, v)); return true; },
    subscribe: (fn) => { env.listeners.add(fn); return () => env.listeners.delete(fn); },
    isDefault: (k) => k === 'target' && env.settings.target === 'en',
  },
}));
vi.mock('../../src/core/language.js', () => {
  const LANGUAGES = [
    { code: 'de', name: 'German', endonym: 'Deutsch', ocr: 'neural', google: 'de' },
    { code: 'en', name: 'English', endonym: 'English', ocr: 'neural', google: 'en' },
    { code: 'ja', name: 'Japanese', endonym: '日本語', script: 'japanese', ocr: 'tesseract', google: 'ja' },
  ];
  const suggestTarget = (exclude) => env.browser.map((t) => t.split('-')[0]).find((c) => c !== exclude && LANGUAGES.some((l) => l.code === c)) || (exclude === 'en' ? 'de' : 'en');
  return { LANGUAGES, suggestTarget, langName: (c) => (LANGUAGES.find((l) => l.code === c) || {}).name || c };
});

const proto = window.HTMLDialogElement.prototype;
proto.showModal = function showModal() { this.setAttribute('open', ''); };
proto.close = function close() { if (this.hasAttribute('open')) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } };
Object.defineProperty(proto, 'open', { configurable: true, get() { return this.hasAttribute('open'); } });

const { initLangChip, openLanguageDialog } = await import('../../src/ui/langdialog.js');
const { store } = await import('../../src/core/store.js');

const dlg = () => document.querySelector('dialog');
const saveBtn = () => Array.from(dlg().querySelectorAll('.dialog__footer button')).find((b) => b.textContent.includes('Save'));
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => {
  env.settings = { source: null, target: 'en' };
  env.browser = ['en-US'];
  env.listeners.clear();
  document.body.innerHTML = '<header><button id="lang-chip" class="lang-chip"></button></header><main><section data-view="play"><h1>Play</h1></section></main><div id="sr-status"></div><div id="sr-alert"></div>';
});

describe('language chip', () => {
  it('prompts for a choice when no game language is set, then shows the pair', () => {
    const chip = document.getElementById('lang-chip');
    initLangChip(chip);
    expect(chip.textContent).toContain('Choose languages');
    expect(chip.hasAttribute('data-empty')).toBe(true);
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    store.set('source', 'de');
    expect(chip.querySelector('.lang-chip__long').textContent.replace(/\s+/g, ' ').trim()).toBe('Languages: German→ to English');
    expect(chip.querySelector('.lang-chip__short').textContent).toBe('DE→EN');
    expect(chip.querySelector('.lang-chip__short').getAttribute('aria-hidden')).toBe('true');
    expect(chip.hasAttribute('data-empty')).toBe(false);
  });

  it('opens the dialog and returns focus to the chip', async () => {
    const chip = document.getElementById('lang-chip');
    initLangChip(chip);
    chip.focus();
    chip.click();
    expect(dlg()).not.toBeNull();
    dlg().querySelector('.dialog__footer button').click();
    await flush();
    expect(document.activeElement).toBe(chip);
  });
});

describe('language dialog', () => {
  it('groups game languages by OCR support and requires a choice', async () => {
    const result = openLanguageDialog();
    const src = dlg().querySelector('#lang-dialog-source');
    expect(Array.from(src.querySelectorAll('optgroup')).map((g) => g.label)).toEqual(['Full support', 'Basic support — expect more misreads']);
    expect(src.value).toBe('');
    saveBtn().click();
    await flush();
    expect(dlg()).not.toBeNull();
    const err = dlg().querySelector('#lang-dialog-source-error');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('Choose the language your game is in.');
    expect(src.getAttribute('aria-invalid')).toBe('true');
    expect(src.getAttribute('aria-describedby')).toContain('lang-dialog-source-error');
    // The message sits right under the field it is about.
    expect(src.closest('.stack-2').contains(err)).toBe(true);
    expect(document.activeElement).toBe(src);
    src.value = 'de';
    src.dispatchEvent(new Event('change', { bubbles: true }));
    expect(err.hidden).toBe(true);
    saveBtn().click();
    expect(await result).toBe(true);
    expect(env.settings.source).toBe('de');
    expect(env.settings.target).toBe('en');
  });

  it('rejects identical source and target languages', async () => {
    env.settings.source = 'de';
    openLanguageDialog();
    const tgt = dlg().querySelector('#lang-dialog-target');
    tgt.value = 'de';
    saveBtn().click();
    await flush();
    expect(dlg().querySelector('#lang-dialog-target-error').textContent).toContain('different language');
    expect(tgt.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(tgt);
    expect(env.settings.target).toBe('en');
  });

  it('warns about basic OCR support for the selected game language', () => {
    env.settings.source = 'de';
    openLanguageDialog();
    const src = dlg().querySelector('#lang-dialog-source');
    const note = dlg().querySelector('[data-lang-note]');
    expect(note.textContent.trim()).toBe('');
    src.value = 'ja';
    src.dispatchEvent(new Event('change', { bubbles: true }));
    expect(note.textContent).toContain('Japanese text is read with a separate reader');
    expect(src.getAttribute('aria-describedby')).toContain(note.id);
  });

  it('suggests the browser language as the target before the first choice', async () => {
    env.browser = ['de-DE', 'en'];
    openLanguageDialog();
    expect(dlg().querySelector('#lang-dialog-target').value).toBe('de');
    dlg().querySelector('.dialog__footer button').click();
    await flush();
    // Once a game language is set, the stored target wins.
    env.settings.source = 'ja';
    openLanguageDialog();
    expect(dlg().querySelector('#lang-dialog-target').value).toBe('en');
  });

  it('announces the saved pair after the dialog closes (not into the removed dialog)', async () => {
    await new Promise((r) => setTimeout(r, 150)); // let earlier tests' announcements land
    vi.useFakeTimers();
    try {
      // A pair no other test saves, so the announcer's dedupe can't swallow it.
      env.settings.source = 'ja';
      env.settings.target = 'de';
      openLanguageDialog();
      saveBtn().click();
      await vi.advanceTimersByTimeAsync(150);
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.getElementById('sr-status').textContent).toBe('Languages saved: Japanese to German.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel leaves settings untouched', async () => {
    env.settings.source = 'de';
    const result = openLanguageDialog();
    dlg().querySelector('#lang-dialog-source').value = 'en';
    dlg().querySelector('.dialog__footer button').click();
    expect(await result).toBe(false);
    expect(env.settings.source).toBe('de');
  });
});
