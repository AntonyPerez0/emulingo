// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
afterAll(() => wait(150));

let store;
let mod;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = await import('../../src/core/db.js');
  await db.initDb();
  ({ store } = await import('../../src/core/store.js'));
  mod = await import('../../src/ui/views/play/onboarding.js');
});

describe('onboarding helpers', () => {
  it('needs onboarding until done and a game language is set', () => {
    const get = (v) => (k) => v[k];
    expect(mod.needsOnboarding(get({ onboarded: false, source: 'de' }))).toBe(true);
    expect(mod.needsOnboarding(get({ onboarded: true, source: null }))).toBe(true);
    expect(mod.needsOnboarding(get({ onboarded: true, source: 'de' }))).toBe(false);
  });

  it('never suggests translating into the game language', () => {
    expect(mod.initialTarget('de', { stored: 'de', untouched: false })).not.toBe('de');
    expect(mod.initialTarget('en', { stored: 'en', untouched: true })).not.toBe('en');
    expect(mod.initialTarget('de', { stored: 'fr', untouched: false })).toBe('fr');
  });
});

describe('onboarding card', () => {
  let box;
  let done;
  let ob;

  beforeEach(() => {
    store.reset({ keep: [] });
    document.body.innerHTML = '<div id="onb" hidden></div><button id="out">x</button><div id="sr-status" role="status"></div><div id="sr-alert" role="alert"></div>';
    box = document.getElementById('onb');
    done = [];
    ob = mod.createOnboarding(box, { onDone: (s, t, info) => done.push([s, t, info]) });
    ob.sync();
  });

  it('asks for the game language with grouped options and quick choices', () => {
    expect(box.hidden).toBe(false);
    const src = box.querySelector('select');
    expect(box.querySelector(`label[for="${src.id}"]`).textContent).toBe('What language is your game in?');
    expect([...src.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Best support', 'Basic support — expect more misreads']);
    expect([...box.querySelectorAll('[data-quick]')].map((b) => b.textContent)).toEqual(['English', 'German', 'French', 'Spanish', 'Italian']);
  });

  it('shows an error when saving without a game language', () => {
    box.querySelector('button[type="submit"]').click();
    const src = box.querySelector('select');
    expect(src.getAttribute('aria-invalid')).toBe('true');
    expect(box.querySelector(`#${src.id}-error`).hidden).toBe(false);
    expect(document.activeElement).toBe(src);
    expect(store.get('onboarded')).toBe(false);
  });

  it('quick choice + save stores both languages and finishes', () => {
    const chip = box.querySelector('[data-quick="de"]');
    chip.click();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(box.querySelector('select').value).toBe('de');
    box.querySelector('button[type="submit"]').click();
    expect(store.get('source')).toBe('de');
    expect(store.get('target')).not.toBe('de');
    expect(store.get('onboarded')).toBe(true);
    expect(box.hidden).toBe(true);
    expect(done).toHaveLength(1);
    // the view moves focus only for a save from the card itself
    expect(done[0][2]).toEqual({ fromSubmit: true });
  });

  it('moves the target away from the game language', () => {
    const [src, tgt] = box.querySelectorAll('select');
    tgt.value = 'fr';
    tgt.dispatchEvent(new Event('change', { bubbles: true }));
    src.value = 'fr';
    src.dispatchEvent(new Event('change', { bubbles: true }));
    expect(tgt.value).not.toBe('fr');
  });

  it('warns about basic support for non-Latin scripts', () => {
    const src = box.querySelector('select');
    src.value = 'ja';
    src.dispatchEvent(new Event('change', { bubbles: true }));
    expect(box.textContent).toContain('basic engine');
  });

  it('commit() from loading a game saves a chosen language quietly', () => {
    expect(ob.commit()).toBe(false); // nothing chosen: no error shown
    expect(box.querySelector('[aria-invalid]')).toBe(null);
    box.querySelector('[data-quick="es"]').click();
    document.getElementById('out').focus();
    expect(ob.commit()).toBe(true);
    expect(store.get('source')).toBe('es');
    expect(store.get('onboarded')).toBe(true);
    expect(done.at(-1)[2]).toEqual({ fromSubmit: false });
  });

  it('starts from the stored languages when it shows again', () => {
    box.querySelector('[data-quick="de"]').click();
    box.querySelector('button[type="submit"]').click();
    expect(box.hidden).toBe(true);
    // e.g. a settings reset brings the card back, after the game language changed elsewhere
    store.set('source', 'fr');
    store.set('onboarded', false);
    ob.sync();
    expect(box.hidden).toBe(false);
    expect(box.querySelector('select').value).toBe('fr');
    expect(box.querySelector('[data-quick="fr"]').getAttribute('aria-pressed')).toBe('true');
    expect(box.querySelectorAll('select')[1].value).not.toBe('fr');
  });

  it('finishes when the languages are set in the header dialog', () => {
    document.getElementById('out').focus();
    store.set('source', 'it');
    expect(store.get('onboarded')).toBe(true);
    expect(box.hidden).toBe(true);
  });
});
