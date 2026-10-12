// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLivePanel } from '../../src/ui/views/play/livepanel.js';
import { ensureBehaviors } from '../../src/ui/components.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function capture(over = {}) {
  return {
    id: 'cap-1',
    time: Date.now(),
    src: 'de',
    tgt: 'en',
    dialog: { text: 'Hallo! Willkommen in der Welt', translation: '', status: 'pending' },
    others: [],
    conf: 0.95,
    ...over
  };
}

function fakePopover() {
  return { open: vi.fn(), close: vi.fn(), isOpen: () => false };
}

describe('live panel', () => {
  let section;
  let panel;
  let popover;
  let calls;

  beforeEach(() => {
    document.body.innerHTML = '<button id="outside">Outside</button><section id="live"></section>';
    section = document.getElementById('live');
    popover = fakePopover();
    calls = { retry: [], add: [], switch: [] };
    panel = createLivePanel(section, {
      popover,
      onRetryPart: (c, key, mode) => calls.retry.push([c.id, key, mode]),
      onAddToDeck: (c) => calls.add.push(c.id),
      onSwitchLanguage: (code) => calls.switch.push(code)
    });
  });

  it('starts with a heading, a status chip and an empty state', () => {
    expect(section.getAttribute('aria-labelledby')).toBe('play-live-title');
    expect(section.querySelector('h2').textContent).toBe('Live translation');
    expect(section.querySelector('.status-chip').dataset.state).toBe('off');
    expect(section.querySelector('.empty-state')).not.toBe(null);
  });

  it('renders the game text as word buttons with lang, one tab stop per text', () => {
    panel.showLive(capture(), { isNew: true });
    const orig = section.querySelector('.part--dialog .part__orig');
    expect(orig.getAttribute('lang')).toBe('de');
    const words = [...orig.querySelectorAll('button.word')];
    expect(words.map((w) => w.textContent)).toEqual(['Hallo', 'Willkommen', 'in', 'der', 'Welt']);
    expect(words.filter((w) => w.tabIndex === 0)).toHaveLength(1);
    expect(orig.querySelector('[role="group"]').getAttribute('aria-label')).toBe('Game text');
    expect(section.querySelector('.part__trans--pending').textContent).toContain('Translating');
  });

  it('keeps punctuation on its word so a line never starts with it', () => {
    panel.showLive(capture({ dialog: { text: '¿Quieres luchar? Sí, “ahora”.', translation: '', status: 'pending' } }), { isNew: true });
    const words = section.querySelector('.part--dialog [data-words]');
    expect(words.textContent).toBe('¿Quieres luchar? Sí, “ahora”.');
    expect([...words.querySelectorAll('.word-glue')].map((g) => g.textContent)).toEqual(['¿Quieres', 'luchar?', 'Sí,', '“ahora”.']);
    expect([...words.querySelectorAll('button.word')].map((w) => w.textContent)).toEqual(['Quieres', 'luchar', 'Sí', 'ahora']);
  });

  it('moves between words with the arrow keys (roving tabindex)', () => {
    panel.showLive(capture(), { isNew: true });
    const words = [...section.querySelectorAll('button.word')];
    words[0].focus();
    words[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(words[1]);
    expect(words[1].tabIndex).toBe(0);
    expect(words[0].tabIndex).toBe(-1);
    words[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(words[4]);
    words[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(words[0]);
  });

  it('opens the word popover on a word with the right languages', () => {
    panel.showLive(capture(), { isNew: true });
    const word = section.querySelectorAll('button.word')[1];
    word.click();
    expect(popover.open).toHaveBeenCalledWith(word, { term: 'Willkommen', src: 'de', tgt: 'en' });
  });

  it('patches a translation in place without moving focus', () => {
    panel.showLive(capture(), { isNew: true });
    const word = section.querySelectorAll('button.word')[2];
    word.focus();
    const before = section.querySelector('.part--dialog .part__orig');
    panel.showLive(capture({ dialog: { text: 'Hallo! Willkommen in der Welt', translation: 'Hello! Welcome to the world', status: 'done' } }));
    expect(section.querySelector('.part--dialog .part__orig')).toBe(before);
    expect(document.activeElement).toBe(word);
    const trans = section.querySelector('.part__trans');
    expect(trans.textContent).toBe('Hello! Welcome to the world');
    expect(trans.getAttribute('lang')).toBe('en');
  });

  it('queues a new line while focus is inside, and shows it on request', async () => {
    panel.showLive(capture(), { isNew: true });
    section.querySelector('button.word').focus();
    panel.showLive(capture({ id: 'cap-2', dialog: { text: 'Möchtest du kämpfen?', translation: '', status: 'pending' } }), { isNew: true });
    // still the old line, plus a "New line" notice
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-1');
    const show = section.querySelector('[data-action="show-queued"]');
    expect(show).not.toBe(null);
    show.click();
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-2');
    expect(section.querySelector('[data-action="show-queued"]')).toBe(null);
    expect(section.contains(document.activeElement)).toBe(true);
  });

  it('shows the queued line once focus leaves the panel', async () => {
    panel.showLive(capture(), { isNew: true });
    section.querySelector('button.word').focus();
    panel.showLive(capture({ id: 'cap-2', dialog: { text: 'Neu', translation: '', status: 'pending' } }), { isNew: true });
    document.getElementById('outside').focus();
    await flush();
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-2');
  });

  it('holds new lines while the word popover is open', async () => {
    panel.showLive(capture(), { isNew: true });
    panel.setPopoverOpen(true);
    panel.showLive(capture({ id: 'cap-2' }), { isNew: true });
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-1');
    panel.setPopoverOpen(false);
    await flush();
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-2');
  });

  it('replaces the line right away when nobody is reading it', () => {
    panel.showLive(capture(), { isNew: true });
    panel.showLive(capture({ id: 'cap-2' }), { isNew: true });
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-2');
  });

  it('ignores late updates for older captures', () => {
    panel.showLive(capture(), { isNew: true });
    panel.showLive(capture({ id: 'cap-2' }), { isNew: true });
    panel.showLive(capture({ dialog: { text: 'Hallo! Willkommen in der Welt', translation: 'late', status: 'done' } }));
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-2');
    expect(section.textContent).not.toContain('late');
  });

  it('offers Retry for a failed part and reports it', () => {
    panel.showLive(capture({ dialog: { text: 'Hallo', translation: '', status: 'error' } }), { isNew: true });
    const retry = section.querySelector('[data-action="retry-part"]');
    expect(section.querySelector('.part__trans--error').textContent).toContain('Couldn’t translate');
    retry.click();
    expect(calls.retry).toEqual([['cap-1', 'dialog', 'live']]);
  });

  it('lists menus and labels under "Also on screen"', () => {
    panel.showLive(capture({ others: [{ key: 'menu:1', kind: 'menu', text: 'JA\nNEIN', translation: 'Yes\nNo', status: 'done' }] }), { isNew: true });
    const also = section.querySelector('[data-also]');
    expect(also.hidden).toBe(false);
    expect(also.querySelector('h3').textContent).toBe('Also on screen');
    expect(also.querySelectorAll('button.word')).toHaveLength(2);
    expect(also.querySelector('.part__trans').textContent).toBe('Yes\nNo');
  });

  it('shows the low-confidence hint only for weak reads', () => {
    panel.showLive(capture({ conf: 0.6 }), { isNew: true });
    expect(section.querySelector('[data-lowconf]').hidden).toBe(false);
    panel.showLive(capture({ id: 'cap-2', conf: 0.9 }), { isNew: true });
    expect(section.querySelector('[data-lowconf]').hidden).toBe(true);
  });

  it('enables Add to deck once the dialog is translated', () => {
    panel.showLive(capture(), { isNew: true });
    const add = section.querySelector('[data-action="add-card"]');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    panel.showLive(capture({ dialog: { text: 'Hallo! Willkommen in der Welt', translation: 'Hello', status: 'done' } }));
    expect(add.hasAttribute('aria-disabled')).toBe(false);
    add.click();
    expect(calls.add).toEqual(['cap-1']);
  });

  it('shows an earlier line with a way back to live', () => {
    panel.showLive(capture(), { isNew: true });
    const old = capture({ id: 'old', time: Date.now() - 5 * 60000, dialog: { text: 'Alt', translation: 'Old', status: 'done' } });
    panel.showHistory(old);
    expect(panel.mode()).toBe('history');
    expect(section.textContent).toContain('Viewing an earlier line');
    // live captures wait while history is shown
    panel.showLive(capture({ id: 'cap-3', dialog: { text: 'Neu', translation: '', status: 'pending' } }), { isNew: true });
    expect(section.querySelector('.capture').dataset.captureId).toBe('old');
    section.querySelector('[data-action="back-to-live"]').click();
    expect(panel.mode()).toBe('live');
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-3');
  });

  it('suggests switching the game language on a mismatch', () => {
    panel.setHint({ type: 'language-mismatch', detected: 'en', expected: 'de' });
    expect(section.textContent).toContain('This text looks English. Switch the game language to English?');
    section.querySelector('[data-action="hint-switch"]').click();
    expect(calls.switch).toEqual(['en']);
    panel.setHint(null);
    expect(section.querySelector('[data-action="hint-switch"]')).toBe(null);
  });

  it('shows the line re-read after Switch at once, though focus is in the panel', () => {
    panel.showLive(capture({ id: 'de-1' }), { isNew: true });
    panel.setHint({ type: 'language-mismatch', detected: 'en', expected: 'de' });
    const sw = section.querySelector('[data-action="hint-switch"]');
    sw.focus();
    sw.click();
    panel.setHint(null);
    expect(section.contains(document.activeElement)).toBe(true);
    panel.showLive(capture({ id: 'en-1', src: 'en', dialog: { text: 'Hello there!', translation: '', status: 'pending' } }), { isNew: true });
    expect(section.querySelector('.capture').dataset.captureId).toBe('en-1');
    expect(section.querySelector('[data-action="show-queued"]')).toBe(null);
    // later lines wait as usual while focus stays in the panel
    panel.showLive(capture({ id: 'en-2', src: 'en', dialog: { text: 'Next line', translation: '', status: 'pending' } }), { isNew: true });
    expect(section.querySelector('.capture').dataset.captureId).toBe('en-1');
    expect(section.querySelector('[data-action="show-queued"]')).not.toBe(null);
  });

  it('maps scanner statuses onto the chip, with progress while setting up', () => {
    panel.setStatus({ state: 'setup', message: 'Downloading text recognition data — 2.0 of 13.0 MB', progress: 0.42 });
    const chip = section.querySelector('.status-chip');
    expect(chip.dataset.state).toBe('setup');
    expect(chip.textContent).toContain('Setting up 42%');
    const prog = section.querySelector('[data-status-progress]');
    expect(prog.hidden).toBe(false);
    expect(prog.querySelector('progress').value).toBe(42);
    panel.setStatus({ state: 'watching', message: 'Watching for text' });
    expect(chip.textContent).toContain('Watching');
    expect(section.querySelector('[data-status-row]').hidden).toBe(true);
    panel.setStatus({ state: 'error', message: 'Couldn’t read the screen. Trying again…', detail: 'worker died' });
    expect(section.querySelector('[data-status-actions]').hidden).toBe(false);
    expect(section.querySelector('[data-status-detail]').textContent).toBe('worker died');
  });

  it('counts sentences added to the deck', () => {
    panel.setAdded(3);
    const link = section.querySelector('[data-added]');
    expect(link.hidden).toBe(false);
    expect(link.textContent).toContain('3 sentences added to your deck');
  });

  it('shows the first line right away even while focus is in the panel', () => {
    panel.setStatus({ state: 'error', message: 'Couldn’t read the screen.' });
    section.querySelector('[data-action="status-retry"]').focus();
    panel.showLive(capture(), { isNew: true });
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-1');
    expect(section.querySelector('[data-action="show-queued"]')).toBe(null);
  });

  it('does not hold lines back for a pointer that left without a pointerleave', () => {
    panel.showLive(capture(), { isNew: true });
    section.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }));
    // jsdom never matches :hover, like a browser once the pointer is gone
    panel.showLive(capture({ id: 'cap-2' }), { isNew: true });
    expect(section.querySelector('.capture').dataset.captureId).toBe('cap-2');
  });

  it('offers Retry instead of an endless spinner for an earlier line without a translation', () => {
    panel.showHistory(capture({ id: 'old', dialog: { text: 'Alt', translation: '', status: 'pending' } }));
    expect(section.querySelector('.part__trans--pending')).toBe(null);
    const retry = section.querySelector('[data-action="retry-part"]');
    expect(retry).not.toBe(null);
    expect(section.querySelector('.part__trans--error').textContent).toContain('Not translated');
    retry.click();
    expect(calls.retry).toEqual([['old', 'dialog', 'history']]);
  });

  it('marks Retry busy while an attempt runs, so a second press starts nothing', async () => {
    ensureBehaviors(); // the app installs the aria-disabled click guard at boot
    let finish = null;
    const modes = [];
    const own = createLivePanel(section, {
      popover,
      onRetryPart: (c, key, mode) => { modes.push(mode); return new Promise((r) => { finish = r; }); }
    });
    own.showHistory(capture({ id: 'old', dialog: { text: 'Alt', translation: '', status: 'pending' } }));
    const retry = section.querySelector('[data-action="retry-part"]');
    retry.click();
    expect(retry.getAttribute('aria-busy')).toBe('true');
    retry.click();
    expect(modes).toEqual(['history']);
    finish(false);
    await flush();
    await flush();
    expect(retry.hasAttribute('aria-busy')).toBe(false);
    expect(retry.hasAttribute('aria-disabled')).toBe(false);
  });

  it('offers Retry for a live part that came back empty', () => {
    panel.showLive(capture({ dialog: { text: 'Hallo', translation: '', status: 'done' } }), { isNew: true });
    expect(section.querySelector('.part__trans--pending')).toBe(null);
    expect(section.querySelector('[data-action="retry-part"]')).not.toBe(null);
  });

  it('closes the look-up of a word when the word is pressed again', () => {
    let open = null;
    popover.open = vi.fn((anchor) => { open = anchor; anchor.setAttribute('aria-expanded', 'true'); });
    popover.close = vi.fn(() => { if (open) open.setAttribute('aria-expanded', 'false'); open = null; });
    popover.isOpen = () => !!open;
    popover.anchor = () => open;
    panel.showLive(capture(), { isNew: true });
    const word = section.querySelectorAll('button.word')[1];
    word.click();
    expect(popover.open).toHaveBeenCalledTimes(1);
    word.click();
    expect(popover.close).toHaveBeenCalledTimes(1);
    expect(popover.open).toHaveBeenCalledTimes(1);
  });

  it('closes a look-up whose word is replaced, keeping focus in the panel', () => {
    const box = document.createElement('div');
    box.innerHTML = '<button id="in-pop">Listen</button>';
    document.body.appendChild(box);
    let open = null;
    popover.element = box;
    popover.isOpen = () => !!open;
    popover.anchor = () => open;
    popover.close = vi.fn(() => { open = null; });
    panel.showLive(capture(), { isNew: true });
    open = section.querySelector('button.word');
    box.querySelector('#in-pop').focus();
    panel.showLive(capture({ id: 'cap-2', dialog: { text: 'Neu', translation: '', status: 'pending' } }), { isNew: true, force: true });
    expect(popover.close).toHaveBeenCalledWith({ returnFocus: false });
    expect(document.activeElement).toBe(section.querySelector('.capture'));
  });

  it('keeps keyboard focus in the panel when it goes back to live without asking for focus', () => {
    panel.showLive(capture(), { isNew: true });
    panel.showHistory(capture({ id: 'old', dialog: { text: 'Alt', translation: 'Old', status: 'done' } }));
    section.querySelector('button.word').focus();
    panel.backToLive({ focus: false });
    expect(section.contains(document.activeElement)).toBe(true);
  });

  it('falls back to the panel heading when there is no line to focus', () => {
    panel.showHistory(capture({ id: 'old', dialog: { text: 'Alt', translation: 'Old', status: 'done' } }));
    section.querySelector('[data-action="back-to-live"]').click();
    const head = section.querySelector('#play-live-title');
    expect(document.activeElement).toBe(head);
    expect(head.getAttribute('tabindex')).toBe('-1');
  });

  it('announces a language mismatch once', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="sr-status"></div>');
    panel.setHint({ type: 'language-mismatch', detected: 'fr', expected: 'de' });
    panel.setHint({ type: 'language-mismatch', detected: 'fr', expected: 'de' });
    await new Promise((r) => setTimeout(r, 150));
    const text = document.getElementById('sr-status').textContent;
    expect(text).toContain('This text looks French');
    expect(text.match(/looks French/g)).toHaveLength(1);
  });

  it('knows the newest live line while one is held back or history is on show', () => {
    panel.showLive(capture(), { isNew: true });
    section.querySelector('button.word').focus();
    const next = capture({ id: 'cap-2', dialog: { text: 'Neu', translation: '', status: 'pending' } });
    panel.showLive(next, { isNew: true });
    expect(section.querySelector('[data-action="show-queued"]')).not.toBe(null);
    expect(panel.latest()).toBe(next);
    // its translation lands while it waits
    const done = { ...next, dialog: { ...next.dialog, translation: 'New', status: 'done' } };
    panel.showLive(done);
    expect(panel.latest()).toBe(done);
    panel.showHistory(capture({ id: 'old', dialog: { text: 'Alt', translation: 'Old', status: 'done' } }));
    const third = capture({ id: 'cap-3', dialog: { text: 'Drei', translation: '', status: 'pending' } });
    panel.showLive(third, { isNew: true });
    expect(panel.current().id).toBe('old');
    expect(panel.latest()).toBe(third);
  });

  it('shows the newest live line on request: back from history, or the line held back', () => {
    panel.showLive(capture(), { isNew: true });
    section.querySelector('button.word').focus();
    const next = capture({ id: 'cap-2', dialog: { text: 'Neu', translation: 'New', status: 'done' } });
    panel.showLive(next, { isNew: true });
    expect(panel.current().id).toBe('cap-1');
    panel.showLatest();
    expect(panel.current().id).toBe('cap-2');
    expect(section.querySelector('[data-action="show-queued"]')).toBe(null);
    panel.showHistory(capture({ id: 'old', dialog: { text: 'Alt', translation: 'Old', status: 'done' } }));
    expect(panel.mode()).toBe('history');
    panel.showLatest();
    expect(panel.mode()).toBe('live');
    expect(panel.current().id).toBe('cap-2');
    // already on the newest line: nothing changes
    panel.showLatest();
    expect(panel.current().id).toBe('cap-2');
  });

  it('focuses the line on show, else the heading', () => {
    panel.focusCurrent();
    expect(document.activeElement.id).toBe('play-live-title');
    panel.showLive(capture(), { isNew: true });
    panel.focusCurrent();
    expect(document.activeElement.classList.contains('capture')).toBe(true);
  });

  it('escapes game text (no markup injection)', () => {
    panel.showLive(capture({ dialog: { text: '<img src=x onerror=alert(1)> Hallo', translation: '<b>x</b>', status: 'done' } }), { isNew: true });
    expect(section.querySelector('img')).toBe(null);
    expect(section.querySelector('.part__trans b')).toBe(null);
  });
});
