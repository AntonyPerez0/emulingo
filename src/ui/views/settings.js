// Settings: every preference in one centred column, grouped into sections
// (DESIGN §6, UX-21). Changes save automatically and each section confirms
// them in its own polite "Saved" status instead of toasts (A11Y-09, A11Y-M4).
// Selects, sliders and number fields commit after a short pause or when focus
// leaves them, so browsing a select with the arrow keys doesn't rewrite
// settings (and restart OCR) on every step. Actions update in place, so focus
// stays on the control that was used.
import '../../styles/views/settings.css';
import { html, render, on, toElement } from '../dom.js';
import { icon } from '../icons.js';
import {
  selectField, switchField, rangeField, segmented, setSegmented, syncRange,
  inputField, button, langSelectOptions, setBusy,
} from '../components.js';
import { announce, showShortcutHelp, listShortcuts, keyLabelParts } from '../a11y.js';
import { confirmDialog, openDialog } from '../dialog.js';
import { formatBytes, formatCount } from '../format.js';
import { store } from '../../core/store.js';
import { langName, langInfo } from '../../core/language.js';
import * as tts from '../../core/tts.js';
import { cacheStats, clearTranslateCache } from '../../core/translate.js';
import { storageEstimate, requestPersistence } from '../../core/db.js';
import { exportBackup, parseBackup, applyBackup, describeCounts, backupFileName, wipeAll } from '../../core/backup.js';
import { totalCards } from '../../core/srs.js';
import { stats as dictStats } from '../../core/dictionary.js';
import { DICTS, hasDictionary } from '../../core/ocr/correct.js';
import { coreSettingOptions, listRoms } from '../../core/rom.js';
import { downloadBlob } from '../../core/utils.js';
import { version as APP_VERSION } from '../../../package.json';

const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
const REPO_URL = 'https://github.com/AntonyPerez0/emulingo';
const SELECT_COMMIT_MS = 600; // arrow-key browsing settles before anything is saved
const SLIDER_COMMIT_MS = 350;
const SAVED_MS = 4000;
const KEEP = null; // results that carry information stay until the next action replaces them
const HISTORY_SIZES = [50, 100, 200, 500, 1000];
// EmulatorJS keeps the volume in its own localStorage entry and applies it when a game starts.
const EJS_SETTINGS_KEY = 'ejs-settings';
const DEFAULT_VOLUME = 0.5; // EmulatorJS's own default
// First-use downloads, matching the totals the Play view's progress shows
// (ocr/engine.js: detection + Latin models + ONNX runtime; the extra
// Japanese/Chinese recogniser).
const NEURAL_DOWNLOAD = 'about 27 MB';
const CJK_DOWNLOAD = 'about 17 MB';

const SECTIONS = [
  { id: 'languages', title: 'Languages', icon: 'languages' },
  { id: 'reading', title: 'Reading the screen', icon: 'scan-text' },
  { id: 'learning', title: 'Learning', icon: 'graduation-cap' },
  { id: 'speech', title: 'Speech', icon: 'volume-2' },
  { id: 'emulator', title: 'Emulator', icon: 'gamepad' },
  { id: 'appearance', title: 'Appearance', icon: 'monitor' },
  { id: 'data', title: 'Data & privacy', icon: 'shield' },
  { id: 'danger', title: 'Danger zone', icon: 'alert-triangle' },
  { id: 'about', title: 'About', icon: 'info' },
];

// Control id → what it edits. kind decides how and when it commits.
const FIELDS = {
  'set-source': { key: 'source', section: 'languages', kind: 'language' },
  'set-target': { key: 'target', section: 'languages', kind: 'language' },
  'set-voice-source': { section: 'languages', kind: 'voice' },
  'set-voice-target': { section: 'languages', kind: 'voice' },
  'set-ocr-engine': { key: 'ocrEngine', section: 'reading', kind: 'select' },
  'set-wait-typing': { key: 'waitForTyping', section: 'reading', kind: 'switch' },
  'set-read-all': { key: 'readAllText', section: 'reading', kind: 'switch' },
  'set-scan-speed': { key: 'scanSpeed', section: 'reading', kind: 'segmented' },
  'set-spellcheck': { key: 'spellCheck', section: 'reading', kind: 'switch' },
  'set-announce': { key: 'announceLines', section: 'reading', kind: 'switch' },
  'set-auto-add': { key: 'autoAdd', section: 'learning', kind: 'segmented' },
  'set-new-per-day': { key: 'newPerDay', section: 'learning', kind: 'number', min: 0, max: 500 },
  'set-min-word': { key: 'minWordLen', section: 'learning', kind: 'range', min: 3, max: 8 },
  'set-history': { key: 'keepHistory', section: 'learning', kind: 'select', parse: Number },
  'set-auto-tts': { key: 'autoTts', section: 'speech', kind: 'switch' },
  'set-rate': { key: 'rate', section: 'speech', kind: 'range', min: 0.5, max: 2 },
  'set-core': { key: 'core', section: 'emulator', kind: 'select' },
  'set-volume': { section: 'emulator', kind: 'volume' },
  'set-theme': { key: 'theme', section: 'appearance', kind: 'segmented' },
  'set-shortcuts': { key: 'shortcuts', section: 'appearance', kind: 'switch' },
};
const ID_FOR_KEY = Object.fromEntries(Object.entries(FIELDS).filter(([, f]) => f.key).map(([id, f]) => [f.key, id]));

const OCR_ENGINES = [
  { value: 'auto', label: 'Automatic (recommended)' },
  { value: 'neural', label: 'Neural reader' },
  { value: 'tesseract', label: 'Classic reader (Tesseract)' },
];

// Shown in About until a view registers its own shortcuts (views mount lazily).
// Labels match the views' own registrations, so the list reads the same before and after.
const BASELINE_SHORTCUTS = [
  { scope: 'global', key: '?', label: 'Show keyboard shortcuts' },
  { scope: 'global', key: 'Escape', label: 'Stop speaking' },
  { scope: 'play', key: 't', label: 'Translate now' },
  { scope: 'play', key: 'p', label: 'Turn auto-translate on or off' },
  { scope: 'play', key: 'g', label: 'Return to the game' },
  { scope: 'review', key: 'Space', label: 'Show answer' },
  { scope: 'review', key: '1', label: 'Answer Again' },
  { scope: 'review', key: '2', label: 'Answer Hard' },
  { scope: 'review', key: '3', label: 'Answer Good' },
  { scope: 'review', key: '4', label: 'Answer Easy' },
  { scope: 'review', key: 's', label: 'Listen to the card' },
];
const SCOPE_ORDER = ['global', 'play', 'review', 'dictionary', 'deck', 'settings'];
const SCOPE_TITLES = { global: 'Everywhere', play: 'Play', review: 'Review', dictionary: 'Dictionary', deck: 'Deck', settings: 'Settings' };

// UI copy is US English (licenses, not licences).
const CREDITS = [
  { name: 'EmulatorJS 4.2.3', use: 'Runs the games. Its RetroArch cores have their own open-source licenses.', license: 'GPL-3.0' },
  { name: 'PaddleOCR PP-OCRv5 models', use: 'Read the text on the game screen.', license: 'Apache-2.0' },
  { name: 'ONNX Runtime Web', use: 'Runs the text-recognition models in your browser.', license: 'MIT' },
  { name: 'Tesseract.js and Tesseract data', use: 'Classic text recognition.', license: 'Apache-2.0' },
  { name: 'nspell', use: 'Spell checking for misread words.', license: 'MIT' },
  {
    name: 'Hunspell dictionaries (wooorm/dictionaries)',
    use: 'Word lists for fixing misreads.',
    parts: ['English: MIT and BSD', 'French: MPL-2.0', 'German: GPL-2.0 or GPL-3.0', 'Italian: GPL-3.0', 'Spanish: GPL-3.0, LGPL-3.0 or MPL-1.1'],
    license: 'Per language',
  },
  { name: 'Lucide and Feather icons', use: 'Icons, adapted for Emulingo.', license: 'ISC and MIT' },
];

// ---- Module state (one Settings view per page) ----------------------------------

let root = null;
const pending = new Map(); // control id → timer of a commit that hasn't run yet
const savedTimers = new Map();
let emulatorModule = null;
// After Erase, start over on Play, where a fresh install begins (onboarding).
let reloadPage = () => {
  try { history.replaceState(null, '', '#/play'); } catch { /* keep the current URL */ }
  location.reload();
};

const byId = (id) => (root ? root.querySelector(`#${id}`) : null);

// ---- Small helpers ------------------------------------------------------------

function nameOf(code) {
  return code ? langName(code) : '';
}

function sameValue(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function clampNum(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function formatRate(v) {
  return `${Number(v).toFixed(1)} times`;
}

function dictionaryLanguages() {
  const names = Object.keys(DICTS).map((c) => langName(c)).filter(Boolean).sort();
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}

async function getEmulator() {
  if (!emulatorModule) emulatorModule = await import('../../core/emulator.js');
  return emulatorModule;
}

function readEjsSettings() {
  try {
    const raw = localStorage.getItem(EJS_SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function storedVolume() {
  const s = readEjsSettings();
  if (typeof s.volume !== 'number' || !Number.isFinite(s.volume)) return DEFAULT_VOLUME;
  return s.muted === true ? 0 : clampNum(s.volume, 0, 1);
}

function writeStoredVolume(v) {
  try {
    localStorage.setItem(EJS_SETTINGS_KEY, JSON.stringify({ ...readEjsSettings(), volume: v, muted: v === 0 }));
  } catch { /* storage blocked: the change still applies to a running game */ }
}

// ---- Status and errors --------------------------------------------------------

/**
 * Show (and announce, via role=status) a confirmation in a section's header or
 * an action's block. It fades after `ms`; KEEP leaves it until replaced.
 */
function markSaved(sectionId, message = 'Saved', ms = SAVED_MS) {
  const el = root && root.querySelector(`[data-saved-for="${sectionId}"]`);
  if (!el) return;
  clearTimeout(savedTimers.get(sectionId));
  savedTimers.delete(sectionId);
  // Same text while still visible: leave the DOM alone so it isn't re-announced.
  if (el.dataset.message !== message) {
    render(el, html`${icon('check-circle', { size: 16 })}<span>${message}</span>`);
    el.dataset.message = message;
  }
  if (ms) savedTimers.set(sectionId, setTimeout(() => clearStatus(sectionId), ms));
}

function clearStatus(sectionId) {
  const el = root && root.querySelector(`[data-saved-for="${sectionId}"]`);
  clearTimeout(savedTimers.get(sectionId));
  savedTimers.delete(sectionId);
  if (!el) return;
  render(el, '');
  delete el.dataset.message;
}

function describedIds(el) {
  return (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
}

/** Inline field error: linked with aria-describedby and aria-invalid, removed when message is null. */
function setFieldError(control, message) {
  if (!control) return;
  const errId = `${control.id}-error`;
  let err = root.querySelector(`#${errId}`);
  if (!message) {
    if (err) err.remove();
    control.removeAttribute('aria-invalid');
    const rest = describedIds(control).filter((id) => id !== errId);
    if (rest.length) control.setAttribute('aria-describedby', rest.join(' '));
    else control.removeAttribute('aria-describedby');
    return;
  }
  if (!err) {
    err = toElement(html`<p class="field__error" id="${errId}">${icon('alert-circle', { size: 16 })}<span></span></p>`);
    (control.closest('.field') || control.parentElement).append(err);
  }
  err.querySelector('span').textContent = message;
  control.setAttribute('aria-invalid', 'true');
  const ids = describedIds(control);
  if (!ids.includes(errId)) control.setAttribute('aria-describedby', [...ids, errId].join(' '));
}

/**
 * Persistent inline error for an action. The role=alert region is never
 * hidden (CSS collapses it while empty): screen readers announce text added
 * to a live region they already know, not one that appears with its text.
 */
function showActionError(name, message) {
  const el = root.querySelector(`[data-error-for="${name}"]`);
  if (!el) return;
  render(el, message ? html`${icon('alert-circle', { size: 16 })}<span>${message}</span>` : '');
}

// ---- Commit machinery ---------------------------------------------------------

function schedule(id, ms) {
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(() => flush(id), ms));
}

function flush(id) {
  if (!pending.has(id)) return;
  clearTimeout(pending.get(id));
  pending.delete(id);
  commit(id);
}

function flushAll() {
  for (const id of [...pending.keys()]) flush(id);
  // A number typed but not yet committed (no change event until blur or
  // Enter) would be lost when the view is left with Back or the tab hides.
  for (const [id, f] of Object.entries(FIELDS)) {
    const el = f.kind === 'number' ? byId(id) : null;
    if (el && el.value !== String(store.get(f.key))) commitNumber(f, el, { quiet: true });
  }
}

function discardPending() {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

function save(field, value) {
  if (sameValue(store.get(field.key), value)) return false;
  if (!store.set(field.key, value)) return false;
  markSaved(field.section);
  return true;
}

function commit(id) {
  const f = FIELDS[id];
  const el = byId(id);
  if (!f || !el) return;
  switch (f.kind) {
    case 'switch': save(f, el.checked); break;
    case 'segmented': save(f, el.dataset.value); break;
    case 'select': save(f, f.parse ? f.parse(el.value) : el.value); break;
    case 'range': save(f, clampNum(Number(el.value), f.min, f.max)); break;
    case 'number': commitNumber(f, el); break;
    case 'language': commitLanguage(f, el); break;
    case 'voice': commitVoice(el); break;
    case 'volume': commitVolume(el); break;
    default: break;
  }
}

function commitNumber(f, el, { quiet = false } = {}) {
  const raw = String(el.value).trim();
  const n = Number(raw);
  if (raw === '' || !Number.isInteger(n) || n < f.min || n > f.max) {
    // Leaving the view: keep the stored value and say nothing (show() resyncs the field).
    if (quiet) return;
    const message = `Enter a whole number from ${f.min} to ${f.max}.`;
    setFieldError(el, message);
    // Focus has usually moved on by now, so the linked error alone would go unheard.
    announce(`${el.labels?.[0]?.textContent || 'This field'}: ${message}`);
    return;
  }
  setFieldError(el, null);
  save(f, n);
}

const LANGUAGE_CLASH = {
  source: 'Choose a game language that’s different from “Translate into”.',
  target: 'Choose a language that’s different from your game language.',
};

function commitLanguage(f, el) {
  const value = el.value;
  if (!value) return;
  const otherKey = f.key === 'source' ? 'target' : 'source';
  if (value === store.get(otherKey)) {
    setFieldError(el, LANGUAGE_CLASH[f.key]);
    announce(LANGUAGE_CLASH[f.key]);
    return;
  }
  setFieldError(byId('set-source'), null);
  setFieldError(byId('set-target'), null);
  save(f, value);
  // A choice that clashed before may be valid now that this one changed.
  const other = byId(ID_FOR_KEY[otherKey]);
  if (other && other.value && other.value !== value && other.value !== store.get(otherKey)) {
    save(FIELDS[other.id], other.value);
  }
}

function commitVoice(el) {
  const lang = el.dataset.lang;
  if (!lang) return;
  const current = store.get('voiceByLang') || {};
  const next = { ...current };
  if (el.value) next[lang] = el.value;
  else delete next[lang];
  save({ key: 'voiceByLang', section: 'languages' }, next);
}

async function commitVolume(el) {
  const v = clampNum(Math.round(Number(el.value)), 0, 100) / 100;
  if (Math.abs(storedVolume() - v) < 0.001) return;
  writeStoredVolume(v);
  markSaved('emulator');
  try {
    const emu = await getEmulator();
    emu.setVolume(v);
  } catch { /* emulator unavailable: applied at the next start */ }
}

// ---- Markup: shared pieces ---------------------------------------------------------

function sectionCard({ id, title, icon: iconName }, body, { danger = false } = {}) {
  return html`<section ${{
    class: danger ? 'settings-section card card--danger' : 'settings-section card',
    id: `settings-${id}`,
    'data-section': id,
    'aria-labelledby': `settings-${id}-title`,
  }}>
    <div class="settings-section__head">
      <h2 class="settings-section__title" id="settings-${id}-title"><span class="settings-section__icon" aria-hidden="true">${icon(iconName)}</span><span>${title}</span></h2>
      <p class="settings-saved" role="status" data-saved-for="${id}"></p>
    </div>
    <div class="settings-section__body">${body}</div>
  </section>`;
}

/** A segmented control laid out like an inline field (the group is described by its hint). */
function choiceField({ id, label, hint, options, value }) {
  return html`<div class="settings-choice">${segmented({ id, label, hint, options, value })}</div>`;
}

function subhead(text) {
  return html`<h3 class="settings-subhead">${text}</h3>`;
}

// ---- Markup: sections ----------------------------------------------------------

// Languages outside the Latin reader (language.js ocr: 'tesseract'). Japanese
// and Chinese get their own neural reader (ocr/engine.js routeFor), the rest
// the Classic engine.
function sourceNote(code) {
  const l = langInfo(code);
  if (!l || l.ocr !== 'tesseract') return '';
  const cjk = l.script === 'japanese' || l.script === 'han';
  const how = cjk
    ? `${l.name} text is read with a separate reader that downloads ${CJK_DOWNLOAD} the first time.`
    : `${l.name} text is read with the Classic reader.`;
  return html`<p class="settings-note settings-note--warning">${icon('alert-triangle', { size: 16 })}<span>${how} Expect more misreads than with languages written in the Latin alphabet.</span></p>`;
}

function voiceLabel(v) {
  const online = v.localService === false ? ', online' : '';
  return `${v.name} (${v.lang}${online})`;
}

function voiceState(which) {
  const lang = store.get(which) || '';
  // While a language choice is pending, list voices for what's shown in its select.
  const shown = byId(`set-${which}`);
  const code = (shown && shown.value) || lang;
  const voices = code && tts.supported() ? tts.listVoices(code) : [];
  const seen = new Set();
  const unique = voices.filter((v) => (seen.has(v.voiceURI) ? false : seen.add(v.voiceURI)));
  const chosen = (store.get('voiceByLang') || {})[code] || '';
  const value = unique.some((v) => v.voiceURI === chosen) ? chosen : '';
  const name = nameOf(code);
  let hint;
  if (!code) hint = which === 'source' ? 'Choose a game language first.' : 'Choose a language to translate into first.';
  else if (!unique.length) hint = `No ${name} voices on this device. Your browser’s default voice is used.`;
  else hint = which === 'source' ? `Reads ${name} game text and words aloud.` : `Reads ${name} translations aloud.`;
  return { code, name, voices: unique, value, hint };
}

function voiceOptions(state) {
  return html`<option ${{ value: '', selected: state.value === '' }}>System default</option>${state.voices.map((v) => html`<option ${{ value: v.voiceURI, selected: v.voiceURI === state.value }}>${voiceLabel(v)}</option>`)}`;
}

function voiceRow(which) {
  const id = `set-voice-${which}`;
  const state = voiceState(which);
  return html`<div class="settings-voice" data-voice="${which}">
    ${selectField({
      id,
      label: which === 'source' ? 'Game language voice' : 'Translation voice',
      hint: state.hint,
      options: voiceOptions(state),
      inline: true,
      attrs: { 'data-lang': state.code || '' },
    })}
    <div class="settings-row-actions">
      ${button({
        label: 'Listen to a sample',
        icon: 'play',
        kind: 'ghost',
        size: 'sm',
        action: `sample-${which}`,
        attrs: {
          'aria-label': state.code ? `Listen to a sample in ${state.name}` : null,
          'aria-disabled': state.code ? null : 'true',
        },
      })}
    </div>
  </div>`;
}

function languagesSection(s) {
  const speech = tts.supported();
  return sectionCard(SECTIONS[0], html`
    ${selectField({
      id: 'set-source',
      label: 'Game language',
      hint: 'The language of the text in your games.',
      options: langSelectOptions(s.source || '', { group: 'ocr', placeholder: s.source ? undefined : 'Choose a language' }),
      inline: true,
      attrs: { 'aria-describedby': 'set-source-hint set-source-note' },
    })}
    <div id="set-source-note" class="settings-note-slot" data-source-note>${sourceNote(s.source)}</div>
    ${selectField({
      id: 'set-target',
      label: 'Translate into',
      hint: 'Translations, word lookups and flashcards use this language.',
      options: langSelectOptions(s.target),
      inline: true,
    })}
    ${subhead('Voices')}
    ${speech
      ? html`${voiceRow('source')}${voiceRow('target')}`
      : html`<p class="settings-note">${icon('info', { size: 16 })}<span>Speech isn’t available in this browser, so voices can’t be chosen.</span></p>`}
  `);
}

function spellHint(source) {
  const base = `Checks uncertain words against a dictionary. Available for ${dictionaryLanguages()}; downloads about 1 MB the first time.`;
  return source && !hasDictionary(source) ? `${base} Not available for ${nameOf(source)} yet.` : base;
}

function readingSection(s) {
  return sectionCard(SECTIONS[1], html`
    ${selectField({
      id: 'set-ocr-engine',
      label: 'Text recognition',
      hint: `Automatic uses the neural reader and switches to the Classic reader if it can’t run on this device. The neural reader downloads ${NEURAL_DOWNLOAD} the first time.`,
      options: OCR_ENGINES,
      value: s.ocrEngine,
      inline: true,
    })}
    ${choiceField({
      id: 'set-scan-speed',
      label: 'Scan speed',
      hint: 'How often Emulingo looks for new text. Relaxed saves battery; Fast notices text sooner.',
      options: [{ value: 'relaxed', label: 'Relaxed' }, { value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Fast' }],
      value: s.scanSpeed,
    })}
    ${switchField({
      id: 'set-wait-typing',
      label: 'Wait for text to finish typing',
      hint: 'Reads a text box once it stops changing, so you get whole sentences. Turn off for quicker, sometimes partial reads.',
      checked: s.waitForTyping,
    })}
    ${switchField({
      id: 'set-read-all',
      label: 'Read text outside text boxes',
      hint: 'Also reads signs, title screens and games without framed text boxes.',
      checked: s.readAllText,
    })}
    ${switchField({ id: 'set-spellcheck', label: 'Fix common misreads', hint: spellHint(s.source), checked: s.spellCheck })}
    ${switchField({
      id: 'set-announce',
      label: 'Announce new lines to screen readers',
      hint: 'Screen readers read out each new line and its translation as it appears.',
      checked: s.announceLines,
    })}
  `);
}

function historyOptions(value) {
  const sizes = HISTORY_SIZES.includes(value) ? HISTORY_SIZES : [...HISTORY_SIZES, value].sort((a, b) => a - b);
  return sizes.map((n) => ({ value: String(n), label: `${n} lines` }));
}

function learningSection(s) {
  return sectionCard(SECTIONS[2], html`
    ${choiceField({
      id: 'set-auto-add',
      label: 'Add flashcards automatically',
      hint: 'Adds each complete sentence from the game’s dialog to your deck. You can always add cards yourself.',
      options: [{ value: 'sentences', label: 'Complete sentences' }, { value: 'off', label: 'Off' }],
      value: s.autoAdd,
    })}
    ${inputField({
      id: 'set-new-per-day',
      label: 'New cards per day',
      hint: 'How many new cards Review introduces each day. Set to 0 to review only cards you’ve already seen.',
      type: 'number',
      value: String(s.newPerDay),
      inline: true,
      attrs: { min: 0, max: 500, step: 1, inputmode: 'numeric', class: 'input settings-number' },
    })}
    ${rangeField({
      id: 'set-min-word',
      label: 'Shortest word to collect',
      hint: 'Shorter words aren’t added to your dictionary.',
      min: 3,
      max: 8,
      step: 1,
      value: clampNum(Number(s.minWordLen) || 3, 3, 8),
      format: (v) => `${v} letters`,
    })}
    ${selectField({
      id: 'set-history',
      label: 'History size',
      hint: 'How many recent lines the Play page keeps.',
      options: historyOptions(s.keepHistory),
      value: String(s.keepHistory),
      inline: true,
    })}
  `);
}

function speechSection(s) {
  const speech = tts.supported();
  return sectionCard(SECTIONS[3], html`
    ${speech ? '' : html`<p class="settings-note">${icon('info', { size: 16 })}<span>Speech isn’t available in this browser.</span></p>`}
    ${switchField({
      id: 'set-auto-tts',
      label: 'Speak game text automatically',
      hint: 'Reads each new line aloud as it appears. With a screen reader, “Announce new lines to screen readers” may suit you better.',
      checked: s.autoTts,
      disabled: !speech,
    })}
    ${rangeField({
      id: 'set-rate',
      label: 'Speech rate',
      hint: 'How fast voices speak, for game text, samples and reviews.',
      min: 0.5,
      max: 2,
      step: 0.1,
      value: clampNum(Number(s.rate) || 1, 0.5, 2),
      format: formatRate,
    })}
    <div class="settings-row-actions settings-row-actions--start">
      ${button({
        label: 'Stop speaking',
        icon: 'stop',
        action: 'stop-speaking',
        attrs: { 'aria-disabled': speech && tts.speaking() ? null : 'true' },
      })}
    </div>
  `);
}

function emulatorSection(s) {
  return sectionCard(SECTIONS[4], html`
    ${selectField({
      id: 'set-core',
      label: 'System',
      hint: 'Automatic picks the system from each game file. Choose one only if a game won’t start — it applies to every game the next time you start one.',
      options: coreSettingOptions(),
      value: s.core,
      inline: true,
    })}
    ${rangeField({
      id: 'set-volume',
      label: 'Volume',
      hint: 'Game sound. Kept for next time.',
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(storedVolume() * 100),
      format: (v) => `${Math.round(v)}%`,
    })}
  `);
}

function appearanceSection(s) {
  return sectionCard(SECTIONS[5], html`
    ${choiceField({
      id: 'set-theme',
      label: 'Theme',
      hint: 'System follows your device’s light or dark setting.',
      options: [
        { value: 'system', label: 'System', icon: 'monitor' },
        { value: 'dark', label: 'Dark', icon: 'moon' },
        { value: 'light', label: 'Light', icon: 'sun' },
      ],
      value: s.theme,
    })}
    ${switchField({
      id: 'set-shortcuts',
      label: 'Keyboard shortcuts',
      hint: 'Single keys such as T and ? run actions. Turn them off if they clash with your screen reader or speech input.',
      checked: s.shortcuts,
    })}
    <div class="settings-row-actions settings-row-actions--start">
      ${button({ label: 'View shortcuts', icon: 'keyboard', action: 'view-shortcuts', attrs: { 'aria-haspopup': 'dialog' } })}
    </div>
  `);
}

function dataSection() {
  return sectionCard(SECTIONS[6], html`
    <div class="settings-block" data-block="storage">
      ${subhead('Storage')}
      <p class="settings-text" data-storage-usage>Checking storage…</p>
      <p class="settings-text settings-text--muted" data-storage-persist></p>
      <div class="settings-row-actions settings-row-actions--start">
        ${button({ label: 'Keep data persistent', icon: 'shield', action: 'persist', attrs: { hidden: true } })}
      </div>
      <p class="settings-status" role="status" data-saved-for="storage"></p>
    </div>
    <div class="settings-block" data-block="backup">
      ${subhead('Backup')}
      <p class="settings-text settings-text--muted">A backup holds your flashcards, dictionary, history, study progress and settings. Games aren’t included — add them again on the new device and their saves are restored.</p>
      ${switchField({
        id: 'set-backup-saves',
        label: 'Include game saves',
        hint: 'Save states and in-game progress. Makes the file larger.',
        checked: true,
      })}
      <div class="settings-row-actions settings-row-actions--start">
        ${button({ label: 'Export backup', icon: 'download', action: 'export' })}
        ${button({ label: 'Choose backup file', icon: 'upload', action: 'import', attrs: { 'aria-describedby': 'set-import-hint' } })}
      </div>
      <p class="settings-text settings-text--muted settings-text--sm" id="set-import-hint">Restoring asks whether to merge the backup with your data or replace it.</p>
      <input type="file" id="set-backup-file" accept=".json,application/json" hidden tabindex="-1" aria-label="Backup file">
      <p class="settings-status" role="status" data-saved-for="backup"></p>
      <p class="settings-error" role="alert" data-error-for="backup"></p>
    </div>
    <div class="settings-block" data-block="cache">
      ${subhead('Translation cache')}
      <p class="settings-text" data-cache-count></p>
      <div class="settings-row-actions settings-row-actions--start">
        ${button({ label: 'Clear translation cache', icon: 'trash-2', action: 'clear-cache' })}
      </div>
      <p class="settings-status" role="status" data-saved-for="cache"></p>
    </div>
    <div class="settings-block" data-block="privacy">
      ${subhead('Privacy')}
      <ul class="settings-privacy" role="list">
        <li><strong>Stays on this device:</strong> your games, saves, flashcards, dictionary, history and settings. Games are never uploaded, and there’s no account or tracking.</li>
        <li><strong>Sent for translation:</strong> the text Emulingo reads from the game screen, and words you look up, go to Google Translate — or to MyMemory if Google doesn’t respond. These free services aren’t run by Emulingo and have their own privacy policies. Translations are kept on this device, so a line is sent only once.</li>
        <li><strong>Downloaded when needed:</strong> the emulator from cdn.emulatorjs.org, spelling dictionaries from cdn.jsdelivr.net, Classic text-recognition data from tessdata.projectnaptha.com, and the Japanese and Chinese reader from PaddleOCR’s model server (Baidu Cloud). Like any website, these servers see your IP address.</li>
        <li><strong>Speech:</strong> voices marked “online” come from your browser’s speech service and may send the text there.</li>
      </ul>
    </div>
  `);
}

function dangerSection() {
  return sectionCard(SECTIONS[7], html`
    <div class="settings-action-row">
      <div class="settings-action-row__text">
        <p class="settings-action-row__title" id="set-reset-title">Reset settings</p>
        <p class="settings-text settings-text--muted" id="set-reset-desc">Puts every setting back to its default. Your languages, flashcards, dictionary and games are kept.</p>
        <p class="settings-status" role="status" data-saved-for="reset"></p>
      </div>
      ${button({ label: 'Reset settings…', icon: 'rotate-ccw', action: 'reset-settings', attrs: { 'aria-describedby': 'set-reset-desc', 'aria-haspopup': 'dialog' } })}
    </div>
    <div class="settings-action-row">
      <div class="settings-action-row__text">
        <p class="settings-action-row__title">Erase all data</p>
        <p class="settings-text settings-text--muted" id="set-erase-desc">Deletes your games, game saves, flashcards, dictionary, history, settings and downloaded files from this device. This can’t be undone, so export a backup first if you want to keep anything.</p>
      </div>
      ${button({ label: 'Erase all data…', icon: 'trash-2', kind: 'danger', action: 'erase', attrs: { 'aria-describedby': 'set-erase-desc', 'aria-haspopup': 'dialog' } })}
    </div>
  `, { danger: true });
}

function shortcutGroups() {
  const registered = listShortcuts().filter((s) => !s.hidden && s.label);
  const scopes = new Set(registered.map((s) => s.scope));
  // A view's own registrations replace the baseline for that view.
  const merged = [...BASELINE_SHORTCUTS.filter((s) => !scopes.has(s.scope)), ...registered];
  const latest = new Map();
  for (const s of merged) latest.set(`${s.scope}|${String(s.key).toLowerCase()}`, s);
  const list = [...latest.values()];
  const order = [...SCOPE_ORDER, ...new Set(list.map((s) => s.scope))].filter((v, i, a) => a.indexOf(v) === i);
  return order
    .map((scope) => ({ scope, title: SCOPE_TITLES[scope] || scope.charAt(0).toUpperCase() + scope.slice(1), items: list.filter((s) => s.scope === scope) }))
    .filter((g) => g.items.length);
}

function shortcutsMarkup() {
  const off = store.get('shortcuts') === false;
  return html`
    ${off ? html`<p class="settings-note">${icon('info', { size: 16 })}<span>Single-key shortcuts are turned off. Turn them on under Appearance.</span></p>` : ''}
    <div class="settings-shortcuts">
      ${shortcutGroups().map((g) => html`<div class="shortcut-group">
        <h4 class="shortcut-group__title">${g.title}</h4>
        <dl class="shortcut-list">${g.items.map((s) => html`<div>
          <dt><span class="kbd-combo">${keyLabelParts(s.key).map((k) => html`<kbd>${k}</kbd>`)}</span></dt>
          <dd>${s.label}</dd>
        </div>`)}</dl>
      </div>`)}
    </div>
    <p class="settings-text settings-text--muted settings-text--sm settings-shortcuts__note">Shortcuts don’t apply while you type in a field. While the game has focus, press <kbd>Esc</kbd> or <kbd>Tab</kbd> to return to the app.</p>`;
}

function aboutSection() {
  return sectionCard(SECTIONS[8], html`
    <div class="settings-about">
      <p class="settings-about__name">Emulingo</p>
      <p class="settings-text settings-text--muted">Version ${APP_VERSION} · build <code>${BUILD}</code></p>
      <p class="settings-text">Play games you own and learn a language as you go.</p>
      <p><a class="settings-link" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${icon('external-link', { size: 16 })}<span>Source code on GitHub</span><span class="visually-hidden"> (opens in a new tab)</span></a></p>
    </div>
    <div class="settings-block">
      ${subhead('Keyboard shortcuts')}
      <div data-shortcuts>${shortcutsMarkup()}</div>
    </div>
    <div class="settings-block">
      ${subhead('Credits and licenses')}
      <ul class="settings-credits" role="list">
        ${CREDITS.map((c) => html`<li class="settings-credit">
          <div class="settings-credit__text">
            <span class="settings-credit__name">${c.name}</span>
            <span class="settings-credit__use">${c.use}</span>
            ${c.parts ? html`<span class="settings-credit__parts">${c.parts.map((part, i) => html`${i ? ' · ' : ''}<span class="nowrap">${part}</span>`)}</span>` : ''}
          </div>
          <span class="badge badge--neutral settings-credit__license">${c.license}</span>
        </li>`)}
      </ul>
      <p class="settings-text settings-text--muted settings-text--sm">Translations come from Google Translate and MyMemory, which are third-party services.</p>
    </div>
  `);
}

function pageMarkup() {
  const s = store.all();
  return html`<div class="page page--narrow settings">
    <div class="page-header">
      <div class="page-header__text">
        <h1 tabindex="-1">Settings</h1>
        <p class="page-header__subtitle">Changes are saved automatically.</p>
      </div>
    </div>
    <nav class="settings-toc" aria-label="Settings sections">
      <ul class="settings-toc__list" role="list">
        ${SECTIONS.map((sec) => html`<li><a class="settings-toc__link" href="#/settings?section=${sec.id}" data-section-link="${sec.id}">${sec.title}</a></li>`)}
      </ul>
    </nav>
    <div class="settings-sections">
      ${languagesSection(s)}
      ${readingSection(s)}
      ${learningSection(s)}
      ${speechSection(s)}
      ${emulatorSection(s)}
      ${appearanceSection(s)}
      ${dataSection()}
      ${dangerSection()}
      ${aboutSection()}
    </div>
  </div>`;
}

// ---- Updates in place ------------------------------------------------------------

function refreshSourceDependents() {
  const sel = byId('set-source');
  const code = sel ? sel.value : store.get('source');
  const note = root.querySelector('[data-source-note]');
  if (note) render(note, sourceNote(code));
  const spell = root.querySelector('#set-spellcheck-hint');
  if (spell) spell.textContent = spellHint(code);
  refreshVoice('source');
}

function refreshVoice(which) {
  const sel = byId(`set-voice-${which}`);
  if (!sel) return;
  const state = voiceState(which);
  // Rebuild the options only when the list changed (keeps a screen reader's
  // place), and leave a choice the user is still making alone.
  const sig = `${state.code}|${state.voices.map((v) => v.voiceURI).join('|')}`;
  if (sel.dataset.sig !== sig) {
    render(sel, voiceOptions(state));
    sel.dataset.sig = sig;
    sel.value = state.value;
  } else if (!pending.has(sel.id)) {
    sel.value = state.value;
  }
  sel.dataset.lang = state.code || '';
  const hint = root.querySelector(`#set-voice-${which}-hint`);
  if (hint) hint.textContent = state.hint;
  const btn = root.querySelector(`[data-action="sample-${which}"]`);
  if (btn) {
    if (state.code) {
      btn.setAttribute('aria-label', `Listen to a sample in ${state.name}`);
      btn.removeAttribute('aria-disabled');
    } else {
      btn.removeAttribute('aria-label');
      btn.setAttribute('aria-disabled', 'true');
    }
  }
}

function setSelectValue(sel, value) {
  const v = value == null ? '' : String(value);
  if (!Array.from(sel.options).some((o) => o.value === v)) {
    // Options that depend on the value: a custom history size, or a game
    // language cleared by restoring a backup (needs the placeholder back).
    if (sel.id === 'set-history') render(sel, html`${historyOptions(Number(v)).map((o) => html`<option ${{ value: o.value }}>${o.label}</option>`)}`);
    else if (sel.id === 'set-source' && v === '') render(sel, langSelectOptions('', { group: 'ocr', placeholder: 'Choose a language' }));
    else return;
  }
  sel.value = v;
}

/** Bring one control in line with the stored value (unless the user is mid-edit). */
function syncKey(key) {
  if (!root) return;
  if (key === 'voiceByLang') { refreshVoice('source'); refreshVoice('target'); return; }
  const id = ID_FOR_KEY[key];
  const el = id && byId(id);
  if (!el || pending.has(id)) return;
  const f = FIELDS[id];
  const value = store.get(key);
  switch (f.kind) {
    case 'switch': el.checked = !!value; break;
    case 'segmented': setSegmented(el, value); break;
    case 'range': el.value = String(clampNum(Number(value), f.min, f.max)); syncRange(el); break;
    case 'number': el.value = String(value); setFieldError(el, null); break;
    case 'language':
      setSelectValue(el, value);
      setFieldError(byId('set-source'), null);
      setFieldError(byId('set-target'), null);
      break;
    default: setSelectValue(el, value);
  }
  if (key === 'source') refreshSourceDependents();
  if (key === 'target') refreshVoice('target');
  if (key === 'shortcuts') refreshShortcuts();
}

function syncAll() {
  for (const key of Object.keys(ID_FOR_KEY)) syncKey(key);
  refreshVoice('source');
  refreshVoice('target');
}

function refreshShortcuts() {
  const box = root && root.querySelector('[data-shortcuts]');
  if (box) render(box, shortcutsMarkup());
}

function refreshCache() {
  const { entries } = cacheStats();
  const text = root.querySelector('[data-cache-count]');
  if (text) {
    text.textContent = entries
      ? `${formatCount(entries, 'translation')} saved on this device. Lines you’ve seen before translate instantly, even offline.`
      : 'No translations saved yet.';
  }
  const btn = root.querySelector('[data-action="clear-cache"]');
  if (btn) {
    if (entries) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
  }
}

async function refreshStorage() {
  const usageEl = root.querySelector('[data-storage-usage]');
  const persistEl = root.querySelector('[data-storage-persist]');
  const btn = root.querySelector('[data-action="persist"]');
  const [est, roms] = await Promise.all([
    storageEstimate().catch(() => null),
    listRoms().catch(() => []),
  ]);
  if (!root) return;
  const games = Array.isArray(roms) ? roms.length : 0;
  const gameBytes = games ? roms.reduce((n, r) => n + (Number(r.size) || 0), 0) : 0;
  const gamesText = games ? `${formatCount(games, 'game')} (${formatBytes(gameBytes)})` : '';
  if (est) {
    const quota = est.quota ? ` Your browser allows up to about ${formatBytes(est.quota)}.` : '';
    usageEl.textContent = `This site is using ${formatBytes(est.usage)} on this device${gamesText ? `, including ${gamesText}` : ''}.${quota}`;
  } else {
    usageEl.textContent = `Your browser doesn’t report how much space is used.${gamesText ? ` You have ${gamesText} stored.` : ''}`;
  }
  const canPersist = !!(est && globalThis.navigator?.storage?.persist);
  if (est && est.persisted) {
    persistEl.textContent = 'Your data is kept persistent: the browser won’t clear it to free up space.';
  } else if (canPersist) {
    persistEl.textContent = 'Your browser may clear this data when space runs low (Safari also does after a week without a visit). Keep it persistent, and export a backup now and then.';
  } else {
    persistEl.textContent = 'Export a backup now and then: browsers can clear site data when space runs low.';
  }
  if (!btn) return;
  const focused = btn.ownerDocument.activeElement === btn;
  if (est && est.persisted) {
    if (focused) {
      // Keep focus where it is: the button stays, but there's nothing left to do.
      btn.setAttribute('aria-disabled', 'true');
      btn.querySelector('.btn__label').textContent = 'Data is kept persistent';
    } else btn.hidden = true;
  } else {
    btn.hidden = !canPersist;
  }
}

async function refreshVolume() {
  // A running game's volume (e.g. muted from the Play toolbar) beats the stored one.
  const emu = await getEmulator().catch(() => null);
  const el = byId('set-volume');
  if (!el || pending.has(el.id) || document.activeElement === el) return;
  let v = storedVolume();
  if (emu && emu.isStarted && emu.isStarted()) v = emu.isMuted() ? 0 : emu.getVolume();
  el.value = String(Math.round(v * 100));
  syncRange(el);
}

function refreshSpeaking(on) {
  const btn = root && root.querySelector('[data-action="stop-speaking"]');
  if (!btn) return;
  if (on) btn.removeAttribute('aria-disabled');
  else btn.setAttribute('aria-disabled', 'true');
}

// ---- Actions ---------------------------------------------------------------------

function playSample(which) {
  flush(`set-voice-${which}`);
  flush('set-rate');
  const code = byId(`set-voice-${which}`)?.dataset.lang || store.get(which);
  if (!code) return;
  const ok = tts.speak(tts.sample(code), code);
  if (!ok) announce('This sample couldn’t be played.');
}

async function exportData(btn) {
  showActionError('backup', null);
  clearStatus('backup');
  setBusy(btn, true, { label: 'Preparing backup…' });
  try {
    const includeSaves = !!byId('set-backup-saves')?.checked;
    // A running game's latest in-game save goes into the backup too.
    if (includeSaves && emulatorModule?.isStarted?.() && emulatorModule.flushSaves) {
      await emulatorModule.flushSaves().catch(() => false);
    }
    const blob = await exportBackup({ includeSaves });
    const name = backupFileName();
    downloadBlob(blob, name);
    markSaved('backup', `Backup downloaded: ${name} (${formatBytes(blob.size)}).`, KEEP);
  } catch (err) {
    console.error('[settings] export failed', err);
    showActionError('backup', 'The backup couldn’t be created. Try again, or turn off “Include game saves” if the problem continues.');
  } finally {
    setBusy(btn, false);
  }
}

function importSummaryText(counts, exported) {
  let what = describeCounts(counts);
  // describeCounts leaves out study days and settings
  const extras = [counts.activity ? 'study progress' : '', counts.settings ? 'settings' : ''].filter(Boolean).join(' and ');
  if (what === 'no data') what = extras ? `${extras} only` : 'nothing to restore';
  else if (extras) what += `, plus ${extras}`;
  let date = '';
  if (exported) {
    const d = new Date(exported);
    if (!Number.isNaN(d.getTime())) date = d.toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  return date ? `This backup from ${date} contains ${what}.` : `This backup contains ${what}.`;
}

function replaceText(counts) {
  let cards = 0;
  let entries = 0;
  try { cards = totalCards(); } catch { /* data not ready */ }
  try { entries = dictStats().total; } catch { /* data not ready */ }
  const parts = [];
  if (cards) parts.push(formatCount(cards, 'card'));
  if (entries) parts.push(formatCount(entries, ['dictionary entry', 'dictionary entries']));
  const what = parts.length
    ? `the ${parts.join(' and ')} on this device, along with your history and study progress,`
    : 'your flashcards, dictionary, history and study progress on this device,';
  // applyBackup 'replace' overwrites saves of the same games (an older Pokémon save included).
  const saves = counts.saves ? ' The backup’s game saves also replace the saves of the same games here.' : '';
  return `Deletes ${what} and uses the backup’s settings.${saves} This can’t be undone.`;
}

/** Ask how to restore: resolves 'merge', 'replace' or null (cancelled). */
function chooseImportMode(summary, returnFocus) {
  const { counts, warnings = [], exported } = summary;
  const content = html`
    <p class="dialog__text" id="set-import-summary">${importSummaryText(counts, exported)}</p>
    ${warnings.length ? html`<div class="settings-import-warnings" role="note">
      <p class="settings-import-warnings__title">${icon('alert-triangle', { size: 16 })}<span>Some data will be skipped</span></p>
      <ul>${warnings.map((w) => html`<li>${w}</li>`)}</ul>
    </div>` : ''}
    <dl class="settings-import-modes">
      <div><dt>Merge</dt><dd>Adds the backup to what’s on this device and keeps your current settings.${counts.saves ? ' Game saves already on this device are kept.' : ''}</dd></div>
      <div><dt>Replace</dt><dd>${replaceText(counts)}</dd></div>
    </dl>`;
  const dlg = openDialog({
    title: 'Restore backup?',
    content,
    returnFocus,
    describedBy: 'set-import-summary',
    actions: [
      { label: 'Cancel', kind: 'secondary', value: null, autofocus: true },
      { label: 'Replace my data', kind: 'danger', value: 'replace' },
      { label: 'Merge', kind: 'primary', value: 'merge' },
    ],
  });
  return dlg.closed.then((v) => (v === 'merge' || v === 'replace' ? v : null));
}

async function importFile(file, btn) {
  showActionError('backup', null);
  clearStatus('backup');
  setBusy(btn, true, { label: 'Reading backup…' });
  let summary;
  try {
    summary = await parseBackup(file);
  } catch (err) {
    showActionError('backup', err && err.name === 'BackupError' ? err.message : 'This file couldn’t be read. Choose an Emulingo backup file.');
    return;
  } finally {
    setBusy(btn, false);
  }
  const c = summary.counts || {};
  if (!c.cards && !c.dictionary && !c.history && !c.activity && !c.saves && !c.settings) {
    showActionError('backup', 'This backup is empty, so there’s nothing to restore.');
    return;
  }
  const mode = await chooseImportMode(summary, btn);
  if (!mode) return;
  setBusy(btn, true, { label: 'Restoring…' });
  // Commit edits still waiting now, so a late timer can't overwrite restored settings.
  flushAll();
  try {
    const result = await applyBackup(summary, { mode });
    const waiting = result && result.saves && result.saves.waiting
      ? ` ${formatCount(result.saves.waiting, 'game save')} will be restored when you add ${result.saves.waiting === 1 ? 'its game' : 'their games'}.`
      : '';
    markSaved('backup', `${mode === 'replace' ? 'Backup restored. Your data was replaced.' : 'Backup restored and merged with your data.'}${waiting}`, KEEP);
  } catch (err) {
    console.error('[settings] restore failed', err);
    // Part of the backup may already be in place (applyBackup isn't atomic), so don't claim otherwise.
    showActionError('backup', err && err.name === 'BackupError'
      ? err.message
      : 'The backup couldn’t be restored completely, possibly because this device is out of space. Free up some space, then restore it again.');
  } finally {
    setBusy(btn, false);
    syncAll();
    window.dispatchEvent(new Event('emulingo:cards-changed'));
    refreshCache();
    refreshStorage();
  }
}

async function persistData(btn) {
  setBusy(btn, true, { label: 'Asking your browser…' });
  const granted = await requestPersistence().catch(() => false);
  setBusy(btn, false);
  if (granted) markSaved('storage', 'Your data is now kept persistent.', KEEP);
  else markSaved('storage', 'Your browser didn’t allow it. Installing Emulingo as an app, or visiting more often, usually helps.', KEEP);
  await refreshStorage();
}

function clearCache() {
  const { entries } = cacheStats();
  if (!entries) return;
  clearTranslateCache();
  refreshCache();
  markSaved('cache', 'Translation cache cleared.');
}

async function resetSettings() {
  const ok = await confirmDialog({
    title: 'Reset settings?',
    body: 'Every setting goes back to its default. Your languages, flashcards, dictionary and games are kept.',
    confirmLabel: 'Reset settings',
  });
  if (!ok) return;
  discardPending();
  store.reset();
  // The volume is shown here too, though EmulatorJS keeps it.
  writeStoredVolume(DEFAULT_VOLUME);
  try { (await getEmulator()).setVolume(DEFAULT_VOLUME); } catch { /* no game: applied at the next start */ }
  syncAll();
  await refreshVolume();
  markSaved('reset', 'Settings reset to their defaults.');
}

async function eraseEverything(btn) {
  const ok = await confirmDialog({
    title: 'Erase all data?',
    body: 'This deletes your games, game saves, flashcards, dictionary, history, settings and downloaded files from this device. It can’t be undone.',
    confirmLabel: 'Erase everything',
    danger: true,
    requireText: 'ERASE',
  });
  if (!ok) return;
  discardPending();
  setBusy(btn, true, { label: 'Erasing…' });
  announce('Erasing all data…');
  try {
    // A running game would keep writing saves while the databases are deleted.
    const emu = emulatorModule || (await getEmulator().catch(() => null));
    if (emu && emu.isStarted && emu.isStarted()) emu.pause('user');
  } catch { /* nothing running */ }
  try {
    await wipeAll();
  } catch (err) {
    console.error('[settings] erase failed', err);
  }
  reloadPage();
}

function focusSection(id) {
  const heading = root && root.querySelector(`#settings-${id}-title`);
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  heading.focus({ preventScroll: true });
  if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

// ---- Wiring ------------------------------------------------------------------------

function onControlChange(e, el) {
  const f = FIELDS[el.id];
  if (!f) return;
  if (f.kind === 'switch' || f.kind === 'segmented') {
    clearTimeout(pending.get(el.id));
    pending.delete(el.id);
    commit(el.id);
    return;
  }
  // Cheap, side-effect-free previews follow the selection at once; saving waits.
  if (el.id === 'set-source') refreshSourceDependents();
  if (el.id === 'set-target') refreshVoice('target');
  schedule(el.id, f.kind === 'range' || f.kind === 'volume' ? SLIDER_COMMIT_MS : SELECT_COMMIT_MS);
}

function onAction(e, btn) {
  if (btn.getAttribute('aria-disabled') === 'true') return;
  switch (btn.dataset.action) {
    case 'sample-source': playSample('source'); break;
    case 'sample-target': playSample('target'); break;
    case 'stop-speaking': tts.stop(); break;
    case 'view-shortcuts': showShortcutHelp(); break;
    case 'persist': persistData(btn); break;
    case 'export': exportData(btn); break;
    case 'import': {
      const input = byId('set-backup-file');
      if (input) { input.value = ''; input.click(); }
      break;
    }
    case 'clear-cache': clearCache(); break;
    case 'reset-settings': resetSettings(); break;
    case 'erase': eraseEverything(btn); break;
    default: break;
  }
}

function wire(section) {
  on(section, 'change', '[id^="set-"]', (e, el) => {
    if (el.id === 'set-backup-file') {
      const file = el.files && el.files[0];
      const btn = section.querySelector('[data-action="import"]');
      if (file) importFile(file, btn);
      return;
    }
    onControlChange(e, el);
  });
  // Leaving a control saves what it shows straight away.
  on(section, 'focusout', '[id^="set-"]', (e, el) => flush(el.id));
  on(section, 'click', '[data-action]', onAction);
  on(section, 'click', '[data-section-link]', (e, link) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    focusSection(link.dataset.sectionLink);
  });
  store.subscribe((key) => syncKey(key));
  if (tts.supported()) {
    tts.init();
    tts.onVoicesChanged(() => { refreshVoice('source'); refreshVoice('target'); });
    tts.onSpeakingChange(refreshSpeaking);
  }
  // Mobile browsers may discard a hidden tab without a pagehide.
  window.addEventListener('pagehide', () => flushAll());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
}

export default {
  id: 'settings',
  title: 'Settings',
  icon: 'settings',
  mount(section) {
    root = section;
    render(section, pageMarkup());
    wire(section);
    refreshCache(); // show() follows and refreshes the rest
  },
  show(params = {}) {
    if (!root) return;
    syncAll();
    refreshCache();
    refreshShortcuts();
    refreshStorage();
    refreshVolume();
    const target = params && params.section;
    // The router focuses the h1 after show(); move on to the section afterwards.
    if (target && SECTIONS.some((s) => s.id === target)) setTimeout(() => focusSection(target), 0);
  },
  hide() {
    flushAll();
  },
};

/** Test hooks. */
export const __testing = {
  setReload(fn) { reloadPage = fn; },
  flushAll,
  discardPending,
  FIELDS,
};
