// @vitest-environment jsdom
// Settings view: accessible names, autosave (debounced for selects, sliders
// and numbers), no toasts, language validation, voices, data actions, the
// backup import flow with a hostile file, and Erase everything.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const env = vi.hoisted(() => ({
  speech: true,
  voices: [],
  speaking: false,
  voiceFns: new Set(),
  speakFns: new Set(),
  cache: 0,
  setVolume: null,
  started: false,
  emuVolume: 0.5,
}));

vi.mock('../../src/core/tts.js', () => ({
  supported: () => env.speech,
  init: () => env.speech,
  listVoices: (lang) => env.voices.filter((v) => v.lang.split('-')[0] === lang),
  onVoicesChanged: (fn) => { env.voiceFns.add(fn); return () => env.voiceFns.delete(fn); },
  onSpeakingChange: (fn) => { env.speakFns.add(fn); return () => env.speakFns.delete(fn); },
  speaking: () => env.speaking,
  speak: vi.fn(() => true),
  stop: vi.fn(),
  sample: (lang) => `sample-${lang}`,
}));

vi.mock('../../src/core/emulator.js', () => ({
  setVolume: (v) => env.setVolume && env.setVolume(v),
  isStarted: () => env.started,
  isMuted: () => false,
  getVolume: () => env.emuVolume,
  pause: vi.fn(),
  flushSaves: vi.fn(async () => true),
}));

vi.mock('../../src/core/translate.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    cacheStats: () => ({ entries: env.cache, chars: env.cache * 20 }),
    cacheSize: () => env.cache,
    clearTranslateCache: () => { env.cache = 0; },
  };
});

vi.mock('../../src/core/backup.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    wipeAll: vi.fn(async () => ({})),
    exportBackup: vi.fn(mod.exportBackup),
    applyBackup: vi.fn(mod.applyBackup),
  };
});

// File.text() is missing from jsdom's Blob
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

// <dialog> in jsdom
const proto = window.HTMLDialogElement.prototype;
proto.showModal = function showModal() { this.setAttribute('open', ''); };
proto.close = function close() { if (this.hasAttribute('open')) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } };
Object.defineProperty(proto, 'open', { configurable: true, get() { return this.hasAttribute('open'); } });

const db = await import('../../src/core/db.js');
const { store } = await import('../../src/core/store.js');
const srs = await import('../../src/core/srs.js');
const tts = await import('../../src/core/tts.js');
const backup = await import('../../src/core/backup.js');
const emulator = await import('../../src/core/emulator.js');
const { registerShortcut } = await import('../../src/ui/a11y.js');
const settingsModule = await import('../../src/ui/views/settings.js');
const view = settingsModule.default;
const { __testing } = settingsModule;

let section;
const $ = (sel) => section.querySelector(sel);
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const settle = () => new Promise((r) => setTimeout(r, 0));
const dlg = () => document.querySelector('dialog');
const dialogButton = (label) => Array.from(dlg().querySelectorAll('.dialog__footer button')).find((b) => b.textContent.trim() === label);
const status = (name) => section.querySelector(`[data-saved-for="${name}"]`).textContent.trim();

function change(el, value) {
  if (value !== undefined) el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function leave(el) {
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

function mountView() {
  document.body.innerHTML = `
    <main id="main"><section data-view="settings"></section></main>
    <section class="toast-region" id="toast-region" aria-label="Notifications"></section>
    <div id="sr-status" role="status"></div><div id="sr-alert" role="alert"></div>`;
  section = document.querySelector('section[data-view="settings"]');
  view.mount(section);
  view.show({});
}

/** Accessible name per the common rules (enough for our markup). */
function accessibleName(el) {
  const byIds = (attr) => (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
  if (el.getAttribute('aria-labelledby')) return byIds('aria-labelledby');
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.textContent.trim();
  }
  const wrap = el.closest('label');
  if (wrap) return wrap.textContent.trim();
  if (['BUTTON', 'A'].includes(el.tagName)) return el.textContent.replace(/\s+/g, ' ').trim();
  return '';
}

beforeAll(async () => {
  await db.initDb();
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

beforeEach(() => {
  __testing.discardPending();
  store.reset({ keep: [] });
  store.set('source', 'de');
  store.set('target', 'en');
  store.set('onboarded', true);
  srs.clearAll();
  env.speech = true;
  env.voices = [];
  env.speaking = false;
  env.cache = 0;
  env.setVolume = vi.fn();
  env.started = false;
  env.emuVolume = 0.5;
  emulator.pause.mockClear();
  emulator.flushSaves.mockClear();
  localStorage.removeItem('ejs-settings');
  tts.speak.mockClear();
  backup.wipeAll.mockClear();
  mountView();
});

afterEach(() => {
  vi.useRealTimers();
  for (const d of document.querySelectorAll('dialog')) d.remove();
});

describe('structure and names', () => {
  it('has one h1, a labelled section per group and a section index', () => {
    expect(section.querySelectorAll('h1')).toHaveLength(1);
    const titles = Array.from(section.querySelectorAll('section[aria-labelledby]')).map((s) => accessibleName(s));
    expect(titles).toEqual(['Languages', 'Reading the screen', 'Learning', 'Speech', 'Emulator', 'Appearance', 'Data & privacy', 'Danger zone', 'About']);
    for (const s of section.querySelectorAll('section[aria-labelledby]')) {
      expect(s.querySelector('h2').id).toBe(s.getAttribute('aria-labelledby'));
      expect(s.querySelector('[role="status"]')).not.toBeNull();
    }
    const links = Array.from(section.querySelectorAll('.settings-toc a')).map((a) => a.getAttribute('href'));
    expect(links[0]).toBe('#/settings?section=languages');
  });

  it('gives every visible control an accessible name and resolvable descriptions', () => {
    const controls = Array.from(section.querySelectorAll('input, select, textarea, button, a[href], [role="group"]'))
      .filter((el) => !el.closest('[hidden]') && !el.hidden);
    expect(controls.length).toBeGreaterThan(30);
    for (const el of controls) {
      expect(accessibleName(el), el.outerHTML.slice(0, 120)).not.toBe('');
      for (const id of (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)) {
        expect(document.getElementById(id), `${el.id} → ${id}`).not.toBeNull();
      }
    }
    const ids = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the shared components: switches, sliders with readable values, described groups', () => {
    const sw = $('#set-wait-typing');
    expect(sw.getAttribute('role')).toBe('switch');
    expect(accessibleName(sw)).toBe('Wait for text to finish typing');
    expect(document.getElementById(sw.getAttribute('aria-describedby')).textContent).toMatch(/stops changing/);
    expect($('#set-rate').getAttribute('aria-valuetext')).toBe('1.0 times');
    expect($('#set-min-word').getAttribute('aria-valuetext')).toBe('3 letters');
    expect($('#set-volume').getAttribute('aria-valuetext')).toBe('50%');
    expect($('#set-scan-speed').getAttribute('aria-describedby')).toBe('set-scan-speed-hint');
    expect(accessibleName($('#set-theme'))).toBe('Theme');
    expect($('#set-source').getAttribute('aria-describedby')).toBe('set-source-hint set-source-note');
  });

  it('shows the version, build, source link and licences', () => {
    const about = $('#settings-about').textContent;
    expect(about).toMatch(/Version \d+\.\d+\.\d+ · build/);
    const link = $('#settings-about a[href^="https://github.com/"]');
    expect(link.getAttribute('href')).toBe('https://github.com/AntonyPerez0/emulingo');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toContain('(opens in a new tab)');
    for (const text of ['EmulatorJS', 'GPL-3.0', 'PaddleOCR', 'Apache-2.0', 'ONNX Runtime', 'Tesseract', 'nspell', 'MPL-2.0']) {
      expect(about).toContain(text);
    }
  });

  it('describes honestly what leaves the device', () => {
    const privacy = $('[data-block="privacy"]').textContent;
    expect(privacy).toContain('Google Translate');
    expect(privacy).toContain('MyMemory');
    expect(privacy).toContain('cdn.emulatorjs.org');
    expect(privacy).toContain('cdn.jsdelivr.net');
    expect(privacy).toMatch(/never uploaded/);
    expect(privacy).toContain('tessdata.projectnaptha.com');
    expect(privacy).toContain('Baidu Cloud');
  });

  it('keeps every status and alert region in the accessibility tree, even while empty', () => {
    const regions = Array.from(section.querySelectorAll('[role="status"], [role="alert"]'));
    expect(regions.length).toBeGreaterThan(9);
    for (const el of regions) expect(el.closest('[hidden]'), el.outerHTML).toBeNull();
  });

  it('states the real first-use download size and uses US spelling', () => {
    expect($('#set-ocr-engine-hint').textContent).toContain('downloads about 27 MB the first time');
    expect($('#settings-about').textContent).toContain('Credits and licenses');
    expect(section.textContent).not.toMatch(/licence/i);
  });

  it('moves focus to a section from the section links without changing the route', () => {
    const before = location.hash;
    // (anchor .click() is stubbed for the download tests)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    $('[data-section-link="danger"]').dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('#settings-danger-title'));
    expect(location.hash).toBe(before);
  });

  it('explains when speech isn’t available', () => {
    env.speech = false;
    mountView();
    expect($('#set-voice-source')).toBeNull();
    expect($('#settings-languages').textContent).toContain('Speech isn’t available in this browser, so voices can’t be chosen.');
    expect($('#set-auto-tts').disabled).toBe(true);
    expect($('[data-action="stop-speaking"]').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('autosave', () => {
  it('saves switches and segmented choices at once, with an inline status and no toasts', () => {
    const switches = Object.entries(__testing.FIELDS).filter(([, f]) => f.kind === 'switch');
    expect(switches.length).toBe(6);
    for (const [id, f] of switches) {
      const before = store.get(f.key);
      $(`#${id}`).click();
      expect(store.get(f.key), id).toBe(!before);
    }
    expect(status('reading')).toBe('Saved');
    expect(status('speech')).toBe('Saved');
    expect(status('appearance')).toBe('Saved');

    const choose = (groupId, value) => $(`#${groupId} [data-value="${value}"]`).click();
    choose('set-scan-speed', 'fast');
    choose('set-auto-add', 'off');
    choose('set-theme', 'light');
    expect(store.get('scanSpeed')).toBe('fast');
    expect(store.get('autoAdd')).toBe('off');
    expect(store.get('theme')).toBe('light');
    expect($('#set-theme [data-value="light"]').getAttribute('aria-pressed')).toBe('true');
    expect(status('learning')).toBe('Saved');
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
  });

  it('commits a select once after arrow-key browsing settles', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const seen = [];
    const off = store.subscribe((key, value) => { if (key === 'source') seen.push(value); });
    const sel = $('#set-source');
    for (const code of ['fr', 'es', 'it']) change(sel, code);
    vi.advanceTimersByTime(500);
    expect(store.get('source')).toBe('de');
    vi.advanceTimersByTime(200);
    expect(store.get('source')).toBe('it');
    expect(seen).toEqual(['it']);
    expect(status('languages')).toBe('Saved');
    off();
  });

  it('commits right away when focus leaves the control', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sel = $('#set-ocr-engine');
    change(sel, 'tesseract');
    expect(store.get('ocrEngine')).toBe('auto');
    leave(sel);
    expect(store.get('ocrEngine')).toBe('tesseract');
  });

  it('saves numbers, sliders and selects in the other sections', () => {
    const set = (id, value) => { const el = $(`#${id}`); change(el, value); leave(el); };
    set('set-new-per-day', '35');
    set('set-min-word', '5');
    set('set-history', '500');
    set('set-rate', '1.5');
    set('set-core', 'gba');
    expect(store.get('newPerDay')).toBe(35);
    expect(store.get('minWordLen')).toBe(5);
    expect(store.get('keepHistory')).toBe(500);
    expect(store.get('rate')).toBe(1.5);
    expect(store.get('core')).toBe('gba');
    expect($('#set-rate').getAttribute('aria-valuetext')).toBe('1.5 times');
    expect($('#set-rate-value').textContent).toBe('1.5 times');
  });

  it('rejects an out-of-range number with a linked error and keeps the old value', () => {
    const el = $('#set-new-per-day');
    change(el, '-3');
    leave(el);
    expect(store.get('newPerDay')).toBe(20);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    const err = document.getElementById('set-new-per-day-error');
    expect(err.textContent).toContain('Enter a whole number from 0 to 500.');
    expect(el.getAttribute('aria-describedby')).toContain('set-new-per-day-error');
    change(el, '10');
    leave(el);
    expect(store.get('newPerDay')).toBe(10);
    expect(el.hasAttribute('aria-invalid')).toBe(false);
    expect(document.getElementById('set-new-per-day-error')).toBeNull();
  });

  it('never saves the same game and target language, and recovers when the clash is resolved', () => {
    const src = $('#set-source');
    const tgt = $('#set-target');
    change(tgt, 'de');
    leave(tgt);
    expect(store.get('target')).toBe('en');
    expect(tgt.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById('set-target-error').textContent).toContain('different from your game language');
    change(src, 'es');
    leave(src);
    expect(store.get('source')).toBe('es');
    expect(store.get('target')).toBe('de');
    expect(tgt.hasAttribute('aria-invalid')).toBe(false);
    expect(document.getElementById('set-target-error')).toBeNull();
  });

  it('writes the volume for EmulatorJS and applies it to a running game', async () => {
    const el = $('#set-volume');
    change(el, '30');
    leave(el);
    await tick();
    await settle();
    expect(JSON.parse(localStorage.getItem('ejs-settings'))).toMatchObject({ volume: 0.3, muted: false });
    expect(env.setVolume).toHaveBeenCalledWith(0.3);
    expect(el.getAttribute('aria-valuetext')).toBe('30%');
    expect(status('emulator')).toBe('Saved');
  });

  it('follows changes made elsewhere (language dialog, another tab)', () => {
    store.set('theme', 'dark');
    expect($('#set-theme').dataset.value).toBe('dark');
    store.set('source', 'ja');
    expect($('#set-source').value).toBe('ja');
    expect($('[data-source-note]').textContent).toContain('Japanese text is read with a separate reader that downloads about 17 MB the first time.');
    expect($('#set-spellcheck-hint').textContent).toContain('Not available for Japanese yet.');
    store.set('source', 'ko');
    expect($('[data-source-note]').textContent).toContain('Korean text is read with the Classic reader. Expect more misreads');
    store.set('source', 'fr');
    expect($('[data-source-note]').textContent).toBe('');
    store.set('waitForTyping', false);
    expect($('#set-wait-typing').checked).toBe(false);
    store.set('keepHistory', 150);
    expect($('#set-history').value).toBe('150');
  });

  it('flushes pending edits when the view is hidden', () => {
    change($('#set-history'), '1000');
    view.hide();
    expect(store.get('keepHistory')).toBe(1000);
  });

  it('saves a typed number when the view is left before the field commits', () => {
    const el = $('#set-new-per-day');
    el.value = '42'; // typed: no change event until blur or Enter
    view.hide();
    expect(store.get('newPerDay')).toBe(42);
    el.value = '-5';
    view.hide();
    expect(store.get('newPerDay')).toBe(42);
    expect(el.hasAttribute('aria-invalid')).toBe(false); // nothing flagged once the view is gone
    view.show({});
    expect(el.value).toBe('42');
  });

  it('saves edits that are still waiting when the tab is hidden', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    change($('#set-history'), '500');
    expect(store.get('keepHistory')).toBe(200);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete document.visibilityState;
    }
    expect(store.get('keepHistory')).toBe(500);
  });

  it('shows “Saved” for a few seconds without moving focus', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sw = $('#set-read-all');
    sw.focus();
    sw.click();
    expect(status('reading')).toBe('Saved');
    vi.advanceTimersByTime(4100);
    expect(status('reading')).toBe('');
    expect(document.activeElement).toBe(sw);
  });

  it('shows the volume of a running game', async () => {
    env.started = true;
    env.emuVolume = 0.8;
    view.show({});
    await vi.waitFor(() => expect($('#set-volume').value).toBe('80'));
    expect($('#set-volume').getAttribute('aria-valuetext')).toBe('80%');
  });
});

describe('voices and speech', () => {
  beforeEach(() => {
    env.voices = [
      { name: 'Anna', lang: 'de-DE', voiceURI: 'anna', localService: true },
      { name: 'Google Deutsch', lang: 'de-DE', voiceURI: 'gde', localService: false },
      { name: 'Samantha', lang: 'en-US', voiceURI: 'sam', localService: true },
    ];
    mountView();
  });

  it('lists voices per language with a system default and saves the choice', () => {
    const sel = $('#set-voice-source');
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(['System default', 'Anna (de-DE)', 'Google Deutsch (de-DE, online)']);
    expect(accessibleName(sel)).toBe('Game language voice');
    change(sel, 'gde');
    leave(sel);
    expect(store.get('voiceByLang')).toEqual({ de: 'gde' });
    change(sel, '');
    leave(sel);
    expect(store.get('voiceByLang')).toEqual({});
    expect(Array.from($('#set-voice-target').options).map((o) => o.value)).toEqual(['', 'sam']);
  });

  it('plays a sample in each language through its own voice', () => {
    const btn = $('[data-action="sample-source"]');
    expect(btn.getAttribute('aria-label')).toBe('Listen to a sample in German');
    btn.click();
    expect(tts.speak).toHaveBeenCalledWith('sample-de', 'de');
    $('[data-action="sample-target"]').click();
    expect(tts.speak).toHaveBeenCalledWith('sample-en', 'en');
  });

  it('refreshes the lists when voices load late', () => {
    env.voices.push({ name: 'Petra', lang: 'de-AT', voiceURI: 'petra', localService: true });
    env.voiceFns.forEach((fn) => fn(env.voices));
    expect(Array.from($('#set-voice-source').options).map((o) => o.value)).toContain('petra');
  });

  it('enables Stop speaking only while speech plays', () => {
    const stop = $('[data-action="stop-speaking"]');
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    env.speakFns.forEach((fn) => fn(true));
    expect(stop.hasAttribute('aria-disabled')).toBe(false);
    stop.click();
    expect(tts.stop).toHaveBeenCalled();
  });
});

describe('data actions', () => {
  it('clears the translation cache in place without losing focus', () => {
    env.cache = 1234;
    view.show({});
    expect($('[data-cache-count]').textContent).toContain('1,234 translations saved');
    const btn = $('[data-action="clear-cache"]');
    btn.focus();
    btn.click();
    expect(env.cache).toBe(0);
    expect($('[data-cache-count]').textContent).toBe('No translations saved yet.');
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(status('cache')).toBe('Translation cache cleared.');
  });

  it('exports a backup and reports the file name inline', async () => {
    const btn = $('[data-action="export"]');
    btn.focus();
    btn.click();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await vi.waitFor(() => expect(status('backup')).toMatch(/^Backup downloaded: emulingo-backup-\d{4}-\d{2}-\d{2}\.json/));
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it('opens the section a deep link names', async () => {
    view.show({ section: 'data' });
    await settle();
    expect(document.activeElement).toBe($('#settings-data-title'));
  });

  it('lists the shortcuts views have registered', () => {
    const off = registerShortcut({ key: 'x', label: 'Swap screens', scope: 'play', handler: () => {} });
    view.show({});
    const text = $('[data-shortcuts]').textContent;
    expect(text).toContain('Swap screens');
    expect(text).not.toContain('Turn auto-translate on or off'); // Play's own list replaces the baseline
    expect(text).toContain('Show answer');
    // the baseline reads like the views' own registrations
    expect(text).toContain('Answer Good');
    expect(text).toContain('Listen to the card');
    off();
  });

  it('reports storage use and keeps data persistent on request, keeping focus', async () => {
    let persisted = false;
    const storage = {
      estimate: vi.fn(async () => ({ usage: 5_000_000, quota: 1_000_000_000 })),
      persisted: vi.fn(async () => persisted),
      persist: vi.fn(async () => { persisted = true; return true; }),
    };
    Object.defineProperty(navigator, 'storage', { configurable: true, value: storage });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      view.show({});
      const btn = $('[data-action="persist"]');
      await vi.waitFor(() => expect(btn.hidden).toBe(false));
      expect($('[data-storage-usage]').textContent).toBe('This site is using 4.8 MB on this device. Your browser allows up to about 954 MB.');
      expect($('[data-storage-persist]').textContent).toMatch(/may clear this data/);
      btn.focus();
      btn.click();
      await vi.waitFor(() => expect(status('storage')).toBe('Your data is now kept persistent.'));
      await vi.waitFor(() => expect(btn.textContent).toContain('Data is kept persistent'));
      expect(btn.getAttribute('aria-disabled')).toBe('true');
      expect(storage.persist).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(btn);
      expect(btn.textContent).toContain('Data is kept persistent');
      expect($('[data-storage-persist]').textContent).toMatch(/won’t clear it/);
      vi.advanceTimersByTime(60_000); // results stay until the next action replaces them
      expect(status('storage')).toBe('Your data is now kept persistent.');
    } finally {
      delete navigator.storage;
    }
  });

  it('flushes a running game’s saves into the backup, and reports a failed export inline', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.started = true;
    env.emuVolume = 0.7;
    view.show({});
    await vi.waitFor(() => expect($('#set-volume').value).toBe('70')); // emulator module loaded
    const btn = $('[data-action="export"]');
    btn.click();
    await vi.waitFor(() => expect(status('backup')).toMatch(/^Backup downloaded/));
    expect(emulator.flushSaves).toHaveBeenCalledTimes(1);
    expect(backup.exportBackup).toHaveBeenLastCalledWith({ includeSaves: true });

    backup.exportBackup.mockRejectedValueOnce(new Error('out of memory'));
    $('#set-backup-saves').click();
    btn.click();
    const err = $('[data-error-for="backup"]');
    await vi.waitFor(() => expect(err.textContent).toContain('The backup couldn’t be created.'));
    expect(status('backup')).toBe(''); // the old result doesn't sit next to the error
    expect(backup.exportBackup).toHaveBeenLastCalledWith({ includeSaves: false });
    expect(emulator.flushSaves).toHaveBeenCalledTimes(1);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    spy.mockRestore();
  });
});

describe('restoring a backup', () => {
  const pick = (contents, name = 'backup.json') => {
    const input = $('#set-backup-file');
    const file = new File([contents], name, { type: 'application/json' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const hostile = () => JSON.stringify({
    app: 'emulingo',
    format: 2,
    exported: '2026-10-01T10:00:00.000Z',
    settings: { rate: '"><img src=x onerror="window.__pwned=1">', theme: 'light', evil: '<script>window.__pwned=1</script>' },
    cards: [
      { id: 'c-ok', text: '<img src=x onerror="window.__pwned=1">Hallo', translation: '<b>Hi</b>', src: 'de', tgt: 'en' },
      { id: 'x"><img src=x onerror="window.__pwned=1">', text: 'Tschüss', src: 'de' },
    ],
    dictionary: '<svg onload="window.__pwned=1">',
    roms: [{ id: 'r', name: '<img src=x>' }],
    extra: true,
  });

  it('validates a hostile file, shows what it holds and merges it as plain text', async () => {
    const btn = $('[data-action="import"]');
    btn.focus();
    pick(hostile());
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    const body = dlg().textContent;
    expect(body).toContain('This backup from October 1, 2026 contains 1 card, plus settings.');
    expect(body).toContain('Some unknown data in the file was ignored.');
    expect(body).toContain('1 damaged item in cards was skipped.');
    expect(body).toContain('Game files aren’t part of backups');
    expect(dlg().querySelectorAll('img, script, svg:not(.icon)')).toHaveLength(0);
    expect(document.activeElement.textContent.trim()).toBe('Cancel');

    dialogButton('Merge').click();
    await vi.waitFor(() => expect(status('backup')).toBe('Backup restored and merged with your data.'));
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(window.__pwned).toBeUndefined();
    const cards = srs.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe('<img src=x onerror="window.__pwned=1">Hallo');
    expect(store.get('theme')).toBe('system'); // merge keeps this device's settings
    expect(store.get('rate')).toBe(1);
    expect(document.activeElement).toBe(btn);
  });

  it('replaces data only after an explicit choice that names what is lost', async () => {
    srs.addCard({ text: 'Alt', translation: 'Old', src: 'de', tgt: 'en' });
    pick(hostile());
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    expect(dlg().textContent).toContain('Deletes the 1 card on this device');
    dialogButton('Replace my data').click();
    await vi.waitFor(() => expect(status('backup')).toBe('Backup restored. Your data was replaced.'));
    expect(srs.cards().map((c) => c.text)).toEqual(['<img src=x onerror="window.__pwned=1">Hallo']);
    expect(store.get('theme')).toBe('light');
    expect($('#set-theme').dataset.value).toBe('light');
    expect(store.get('rate')).toBe(1); // the injected value was dropped
  });

  it('changes nothing when cancelled', async () => {
    srs.addCard({ text: 'Alt', translation: 'Old', src: 'de', tgt: 'en' });
    pick(hostile());
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    dialogButton('Cancel').click();
    await tick();
    expect(dlg()).toBeNull();
    expect(srs.cards().map((c) => c.text)).toEqual(['Alt']);
  });

  it('reports an unreadable file inline and keeps focus on the button', async () => {
    const btn = $('[data-action="import"]');
    btn.focus();
    const err = $('[data-error-for="backup"]');
    expect(err.textContent).toBe('');
    pick('this is not json');
    await vi.waitFor(() => expect(err.textContent).toContain('isn’t an Emulingo backup'));
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.hasAttribute('hidden')).toBe(false);
    expect(dlg()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it('reports an empty backup without opening the dialog', async () => {
    pick(JSON.stringify({ app: 'emulingo', format: 2, cards: [] }));
    const err = $('[data-error-for="backup"]');
    await vi.waitFor(() => expect(err.textContent).toContain('This backup is empty'));
    expect(dlg()).toBeNull();
  });

  it('summarizes a backup that holds only study days', async () => {
    pick(JSON.stringify({ app: 'emulingo', format: 2, activity: [{ id: '2026-10-01', count: 5 }] }));
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    expect(dlg().textContent).toContain('This backup contains study progress only.');
    dialogButton('Cancel').click();
  });

  it('says that Replace also overwrites game saves, and Merge keeps them', async () => {
    pick(JSON.stringify({
      app: 'emulingo',
      format: 2,
      cards: [{ id: 'c1', text: 'Hallo', translation: 'Hello', src: 'de', tgt: 'en' }],
      saves: [{ kind: 'sram', rom: 'Pokemon Rot.gb', suffix: '', data: { $u8: 'AAEC' } }],
    }));
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    const text = dlg().textContent;
    expect(text).toContain('contains 1 card and 1 game save');
    expect(text).toContain('Game saves already on this device are kept.');
    expect(text).toContain('The backup’s game saves also replace the saves of the same games here.');
    dialogButton('Cancel').click();
  });

  it('reports a failed restore without claiming nothing changed, and refreshes', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    backup.applyBackup.mockRejectedValueOnce(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    const onCards = vi.fn();
    window.addEventListener('emulingo:cards-changed', onCards);
    pick(hostile());
    await vi.waitFor(() => expect(dlg()).not.toBeNull());
    dialogButton('Merge').click();
    const err = $('[data-error-for="backup"]');
    await vi.waitFor(() => expect(err.textContent).toContain('couldn’t be restored completely'));
    expect(err.textContent).not.toContain('wasn’t changed');
    expect(onCards).toHaveBeenCalled();
    expect($('[data-action="import"]').hasAttribute('aria-busy')).toBe(false);
    window.removeEventListener('emulingo:cards-changed', onCards);
    spy.mockRestore();
  });
});

describe('danger zone', () => {
  it('erases everything only after typing ERASE, then reloads', async () => {
    const reload = vi.fn();
    __testing.setReload(reload);
    const btn = $('[data-action="erase"]');
    btn.focus();
    btn.click();
    await tick();
    expect(dlg().textContent).toContain('Erase all data?');
    const ok = dialogButton('Erase everything');
    expect(ok.disabled).toBe(true);
    const input = dlg().querySelector('input');
    input.value = 'ERASE';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ok.disabled).toBe(false);
    ok.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(backup.wipeAll).toHaveBeenCalledTimes(1);
  });

  it('does nothing when Erase is cancelled', async () => {
    const reload = vi.fn();
    __testing.setReload(reload);
    $('[data-action="erase"]').click();
    await tick();
    dialogButton('Cancel').click();
    await tick();
    expect(backup.wipeAll).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('resets settings but keeps the language pair', async () => {
    store.set('theme', 'light');
    store.set('newPerDay', 5);
    view.show({});
    const btn = $('[data-action="reset-settings"]');
    btn.focus();
    btn.click();
    await tick();
    dialogButton('Reset settings').click();
    await tick();
    expect(store.get('theme')).toBe('system');
    expect(store.get('newPerDay')).toBe(20);
    expect(store.get('source')).toBe('de');
    expect($('#set-theme').dataset.value).toBe('system');
    expect($('#set-new-per-day').value).toBe('20');
    expect(status('reset')).toBe('Settings reset to their defaults.');
    expect(document.activeElement).toBe(btn);
  });

  it('resets the game volume with the other settings', async () => {
    localStorage.setItem('ejs-settings', JSON.stringify({ volume: 0.2, muted: false }));
    view.show({});
    await vi.waitFor(() => expect($('#set-volume').value).toBe('20'));
    $('[data-action="reset-settings"]').click();
    await tick();
    dialogButton('Reset settings').click();
    await vi.waitFor(() => expect($('#set-volume').value).toBe('50'));
    expect(JSON.parse(localStorage.getItem('ejs-settings'))).toMatchObject({ volume: 0.5, muted: false });
    expect(env.setVolume).toHaveBeenCalledWith(0.5);
  });

  it('pauses a running game before erasing', async () => {
    env.started = true;
    const reload = vi.fn();
    __testing.setReload(reload);
    $('[data-action="erase"]').click();
    await tick();
    const input = dlg().querySelector('input');
    input.value = 'ERASE';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    dialogButton('Erase everything').click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(emulator.pause).toHaveBeenCalledWith('user');
    expect(emulator.pause.mock.invocationCallOrder[0]).toBeLessThan(backup.wipeAll.mock.invocationCallOrder[0]);
  });
});
