// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const a11y = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock('../../src/ui/a11y.js', () => ({ announce: a11y.announce }));

const { createCaption } = await import('../../src/ui/views/play/caption.js');

const capture = (over = {}) => ({
  id: 'cap-1',
  src: 'de',
  tgt: 'en',
  dialog: { text: 'Hallo! Willkommen', translation: 'Hello! Welcome', status: 'done' },
  others: [],
  ...over
});

describe('caption', () => {
  let el;
  let opened;
  let caption;

  beforeEach(() => {
    a11y.announce.mockClear();
    document.body.innerHTML = '<div class="caption" data-caption data-state="empty"></div>';
    el = document.querySelector('[data-caption]');
    opened = 0;
    caption = createCaption(el, { onOpen: () => { opened++; }, target: 'en' });
    caption.setPhase('running');
  });

  it('is a plain text strip with one button, not a live region', () => {
    const btn = el.querySelector('button');
    expect(btn.getAttribute('aria-label')).toBe('Open Live translation');
    expect(el.querySelectorAll('button')).toHaveLength(1);
    for (const node of [el, ...el.querySelectorAll('*')]) {
      expect(node.hasAttribute('aria-live')).toBe(false);
      expect(node.hasAttribute('role')).toBe(false);
    }
    expect(el.querySelector('[data-caption-tag]').getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a translation in its language, named as one', () => {
    caption.show(capture());
    const text = el.querySelector('[data-caption-text]');
    expect(text.textContent).toBe('Hello! Welcome');
    expect(text.getAttribute('lang')).toBe('en');
    expect(text.getAttribute('dir')).toBe('ltr');
    expect(el.dataset.state).toBe('done');
    const prefix = el.querySelector('[data-caption-prefix]');
    expect(prefix.hidden).toBe(false);
    expect(prefix.textContent).toBe('Translation: ');
  });

  it('reads status texts as they are, in the app’s language', () => {
    caption.show(capture());
    caption.show(capture({ id: 'cap-2', dialog: { text: 'Neu', translation: '', status: 'pending' } }));
    const text = el.querySelector('[data-caption-text]');
    expect(el.dataset.state).toBe('pending');
    expect(text.textContent).toBe('Translating…');
    expect(text.hasAttribute('lang')).toBe(false);
    expect(text.hasAttribute('dir')).toBe(false);
    expect(el.querySelector('[data-caption-prefix]').hidden).toBe(true);
  });

  it('follows the scanner status while there is no line', () => {
    caption.setStatus({ state: 'setup', progress: 0.3 });
    expect(el.querySelector('[data-caption-text]').textContent).toBe('Getting text recognition ready…');
    expect(el.dataset.state).toBe('empty');
    caption.setStatus({ state: 'paused' });
    expect(el.querySelector('[data-caption-text]').textContent).toBe('Auto-translate is off. Use Translate now to read the screen.');
  });

  it('drops the line on show when Auto-translate goes off: the game moves on unread', () => {
    const text = () => el.querySelector('[data-caption-text]');
    caption.show(capture(), { fresh: true });
    caption.setAutoTranslate(false);
    // (the scanner's own status may still say watching for a moment)
    caption.setStatus({ state: 'watching' });
    expect(el.dataset.state).toBe('empty');
    expect(text().textContent).toBe('Auto-translate is off. Use Translate now to read the screen.');
    expect(text().hasAttribute('lang')).toBe(false);
    caption.setStatus({ state: 'paused', reason: 'user', message: 'Auto-translate is paused' });
    expect(text().textContent).toBe('Auto-translate is off. Use Translate now to read the screen.');
    // a late translation of that line changes nothing
    caption.show(capture({ dialog: { text: 'Hallo! Willkommen', translation: 'Hello! Welcome!', status: 'done' } }));
    expect(el.dataset.state).toBe('empty');
    // Translate now reads the screen again (even when it is the same line)
    caption.show(capture(), { fresh: true });
    expect(el.dataset.state).toBe('done');
    expect(text().textContent).toBe('Hello! Welcome');
    caption.setAutoTranslate(false);
    caption.setStatus({ state: 'error', message: 'Live translation isn’t available right now.' });
    expect(text().textContent).toBe('Live translation isn’t available right now.');
    caption.setAutoTranslate(true);
    caption.setStatus({ state: 'watching' });
    expect(text().textContent).toBe('Hello! Welcome');
  });

  it('starts paused when Auto-translate is off', () => {
    const host = document.createElement('div');
    const c = createCaption(host, { target: 'en', autoTranslate: false });
    c.setPhase('running');
    c.show(capture());
    expect(host.dataset.state).toBe('empty');
    c.show(capture({ id: 'cap-2' }), { fresh: true });
    expect(host.dataset.state).toBe('done');
  });

  it('touches the DOM only when what it shows changes', async () => {
    caption.show(capture());
    let mutations = 0;
    const mo = new MutationObserver((list) => { mutations += list.length; });
    mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    caption.show(capture());
    caption.show({ ...capture(), conf: 0.5 });
    caption.setStatus({ state: 'watching' });
    caption.setPhase('running');
    caption.setTarget('en');
    await new Promise((r) => setTimeout(r, 0));
    expect(mutations).toBe(0);
    caption.show(capture({ dialog: { text: 'Hallo! Willkommen in', translation: 'Hello! Welcome to', status: 'done' } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(mutations).toBeGreaterThan(0);
    mo.disconnect();
  });

  it('opens the Live translation card from its button', () => {
    el.querySelector('.caption__open').click();
    expect(opened).toBe(1);
  });

  it('tags the target language', () => {
    expect(el.querySelector('[data-caption-tag]').textContent).toBe('EN');
    caption.setTarget('zh-Hans');
    expect(el.querySelector('[data-caption-tag]').textContent).toBe('ZH');
  });

  it('never announces (the card does)', () => {
    caption.show(capture());
    caption.show(capture({ id: 'cap-2', dialog: { text: 'x', translation: '', status: 'error' } }));
    caption.setStatus({ state: 'error', message: 'Offline' });
    caption.show(null);
    expect(a11y.announce).not.toHaveBeenCalled();
  });
});
