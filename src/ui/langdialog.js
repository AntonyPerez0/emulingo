// Header language-pair chip ("German → English") and the dialog that changes
// the pair mid-game. Game languages are grouped by how well OCR reads them.
import { store } from '../core/store.js';
import { LANGUAGES, langName, suggestTarget } from '../core/language.js';
import { html, render } from './dom.js';
import { icon } from './icons.js';
import { openDialog } from './dialog.js';
import { selectField, langSelectOptions, banner } from './components.js';
import { announce } from './a11y.js';

const SOURCE_ID = 'lang-dialog-source';
const TARGET_ID = 'lang-dialog-target';

function findLang(code) {
  return (Array.isArray(LANGUAGES) ? LANGUAGES : []).find((l) => l.code === code) || null;
}

function nameOf(code) {
  try { return langName(code) || code; } catch { return code; }
}

/** Default "Translate into": the browser's first supported language other than the game's, else English. */
export function defaultTarget(exclude = null) {
  return suggestTarget(exclude);
}

// Before the first choice, suggest the browser's language rather than the built-in default.
function initialTarget(src) {
  const untouched = !src && typeof store.isDefault === 'function' && store.isDefault('target');
  return (untouched ? null : store.get('target')) || defaultTarget(src || null);
}

function renderChip(chip) {
  const src = store.get('source');
  const tgt = store.get('target') || defaultTarget();
  if (!src) {
    chip.setAttribute('data-empty', '');
    render(chip, html`${icon('languages', { size: 18 })}<span class="lang-chip__pair">Choose languages</span>`);
    return;
  }
  chip.removeAttribute('data-empty');
  render(chip, html`${icon('languages', { size: 18 })}<span class="lang-chip__pair">
      <span class="visually-hidden">Languages: </span><span>${nameOf(src)}</span><span class="lang-chip__arrow" aria-hidden="true">→</span><span class="visually-hidden"> to </span><span>${nameOf(tgt)}</span>
    </span>${icon('chevron-down', { size: 16 })}`);
}

/** Wire the header chip (#lang-chip). Returns an unsubscribe function. */
export function initLangChip(chip = document.getElementById('lang-chip')) {
  if (!chip) return () => {};
  chip.setAttribute('aria-haspopup', 'dialog');
  renderChip(chip);
  chip.addEventListener('click', () => openLanguageDialog({ returnFocus: chip }));
  return store.subscribe((key) => {
    if (key === 'source' || key === 'target') renderChip(chip);
  });
}

function sourceNote(code) {
  const l = findLang(code);
  if (!l || l.ocr !== 'tesseract') return '';
  return banner({
    tone: 'warning',
    body: `${l.name} text is read with a basic engine, so expect more misreads than with Latin-script languages.`,
  });
}

/**
 * Open the language dialog. Resolves to true when the pair was saved.
 * Selects don't save on every arrow key; changes apply on Save.
 */
export function openLanguageDialog({ returnFocus } = {}) {
  const src = store.get('source') || '';
  const tgt = initialTarget(src);
  const noteId = `${SOURCE_ID}-note`;

  // Each select has its own error slot right under it (shown by showError).
  const content = html`<form class="stack-4" novalidate data-lang-form>
    <div class="stack-2">
      ${selectField({
        id: SOURCE_ID,
        label: 'Game language',
        hint: 'The language of the text in your game.',
        options: langSelectOptions(src, { group: 'ocr', placeholder: src ? undefined : 'Choose a language' }),
        attrs: { 'aria-describedby': `${SOURCE_ID}-hint ${noteId}` },
      })}
      <p class="field__error" id="${SOURCE_ID}-error" data-lang-error hidden></p>
    </div>
    <div id="${noteId}" data-lang-note>${sourceNote(src)}</div>
    <div class="stack-2">
      ${selectField({
        id: TARGET_ID,
        label: 'Translate into',
        hint: 'Translations, word lookups and flashcards use this language.',
        options: langSelectOptions(tgt, { filter: (l) => l.google !== null && l.google !== false }),
      })}
      <p class="field__error" id="${TARGET_ID}-error" data-lang-error hidden></p>
    </div>
  </form>`;

  const dlg = openDialog({
    title: 'Languages',
    content,
    returnFocus,
    actions: [
      { label: 'Cancel', kind: 'secondary', value: false },
      { label: 'Save', kind: 'primary', value: true, onClick: () => save(dlg) },
    ],
  });

  const form = dlg.el.querySelector('[data-lang-form]');
  const srcSel = dlg.el.querySelector(`#${SOURCE_ID}`);
  const note = dlg.el.querySelector('[data-lang-note]');
  form.addEventListener('submit', (e) => { e.preventDefault(); save(dlg) !== false && dlg.close(true); });
  srcSel.addEventListener('change', () => {
    render(note, sourceNote(srcSel.value));
    clearError(dlg.el);
  });
  dlg.el.querySelector(`#${TARGET_ID}`).addEventListener('change', () => clearError(dlg.el));
  return dlg.closed.then((v) => v === true);
}

function clearError(root) {
  for (const err of root.querySelectorAll('[data-lang-error]')) {
    err.hidden = true;
    err.textContent = '';
  }
  for (const s of root.querySelectorAll('select')) s.removeAttribute('aria-invalid');
}

function showError(root, select, message) {
  const err = root.querySelector(`#${select.id}-error`);
  render(err, html`${icon('alert-circle', { size: 16 })}<span>${message}</span>`);
  err.hidden = false;
  select.setAttribute('aria-invalid', 'true');
  const described = (select.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
  if (!described.includes(err.id)) select.setAttribute('aria-describedby', [...described, err.id].join(' '));
  select.focus();
}

function save(dlg) {
  const root = dlg.el;
  const srcSel = root.querySelector(`#${SOURCE_ID}`);
  const tgtSel = root.querySelector(`#${TARGET_ID}`);
  const src = srcSel.value;
  const tgt = tgtSel.value;
  clearError(root);
  if (!src) {
    showError(root, srcSel, 'Choose the language your game is in.');
    return false;
  }
  if (src === tgt) {
    showError(root, tgtSel, 'Choose a different language to translate into.');
    return false;
  }
  if (store.get('source') !== src) store.set('source', src);
  if (store.get('target') !== tgt) store.set('target', tgt);
  announce(`Languages saved: ${nameOf(src)} to ${nameOf(tgt)}.`);
  return true;
}
