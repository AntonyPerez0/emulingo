// First-run setup on the Play screen (UX-01): which language the game is in
// (grouped by how well it can be read) and which language to translate
// into (from the browser's languages, never the game's own). Nothing is
// saved while the player browses the lists; "Save languages" (or loading a
// game with a language chosen) saves both and marks onboarding done. The
// header language chip changes them later.
import { html, render, uid } from '../../dom.js';
import { icon } from '../../icons.js';
import { announce } from '../../a11y.js';
import { banner, langLabel } from '../../components.js';
import { store } from '../../../core/store.js';
import { LANGUAGES, langInfo, langName, suggestTarget } from '../../../core/language.js';

export const QUICK_LANGS = ['en', 'de', 'fr', 'es', 'it'];

/** Whether the Play screen should ask for the languages. */
export function needsOnboarding(get = (k) => store.get(k)) {
  return !get('onboarded') || !get('source');
}

/** Translate-into default: the stored choice unless untouched, never the game language. */
export function initialTarget(source, { stored = store.get('target'), untouched = store.isDefault('target') } = {}) {
  const pick = !untouched && stored ? stored : suggestTarget(source || null);
  return pick && pick !== source ? pick : suggestTarget(source || null);
}

function sourceOptions(selected) {
  const groups = [
    ['neural', 'Best support'],
    ['tesseract', 'Basic support — expect more misreads']
  ];
  return html`<option ${{ value: '', disabled: true, selected: !selected }}>Choose a language</option>
    ${groups.map(([level, title]) => {
      const items = LANGUAGES.filter((l) => l.ocr === level);
      return items.length ? html`<optgroup label="${title}">${items.map((l) => html`<option ${{ value: l.code, selected: l.code === selected }}>${langLabel(l)}</option>`)}</optgroup>` : '';
    })}`;
}

function targetOptions(selected) {
  return LANGUAGES.filter((l) => l.google).map((l) => html`<option ${{ value: l.code, selected: l.code === selected }}>${langLabel(l)}</option>`);
}

/**
 * createOnboarding(container, { onDone(source, target) }) →
 *   { visible(), sync(), commit() → bool, element }
 */
export function createOnboarding(container, { onDone = () => {} } = {}) {
  const id = uid('onb');
  const ids = { title: `${id}-title`, source: `${id}-source`, target: `${id}-target` };
  const draft = { source: store.get('source') || '', target: '' };
  draft.target = initialTarget(draft.source || null);
  let shown = false;

  function note(code) {
    const l = langInfo(code);
    if (!l || l.ocr !== 'tesseract') return '';
    // (same wording as Settings and the language dialog)
    const how = l.script === 'japanese' || l.script === 'han' ? 'a separate reader that downloads the first time' : 'the Classic reader';
    return banner({ tone: 'warning', body: `${l.name} text is read with ${how}, so expect more misreads than with languages written in the Latin alphabet.` });
  }

  function draw() {
    render(container, html`<section class="card onboarding" aria-labelledby="${ids.title}">
      <div class="onboarding__intro">
        <div class="onboarding__icon" aria-hidden="true">${icon('languages', { size: 24 })}</div>
        <div>
          <h2 class="onboarding__title" id="${ids.title}">Set up your languages</h2>
          <p class="onboarding__lead">Emulingo reads the text in your game, translates it as you play and turns new sentences into flashcards.</p>
        </div>
      </div>
      <form class="onboarding__form" novalidate data-onb-form>
        <div class="onboarding__step">
          <span class="onboarding__num" aria-hidden="true">1</span>
          <div class="field onboarding__field">
            <label class="field__label" for="${ids.source}">What language is your game in?</label>
            <p class="field__hint" id="${ids.source}-hint">The language of the text in the game, not your own.</p>
            <div class="onboarding__chips" role="group" aria-label="Common game languages">
              ${QUICK_LANGS.map((code) => html`<button type="button" class="chip" data-quick="${code}" aria-pressed="${draft.source === code ? 'true' : 'false'}">${langName(code)}</button>`)}
            </div>
            <select class="select" id="${ids.source}" aria-describedby="${ids.source}-hint ${ids.source}-note">${sourceOptions(draft.source)}</select>
            <div id="${ids.source}-note" data-onb-note>${note(draft.source)}</div>
            <p class="field__error" id="${ids.source}-error" hidden></p>
          </div>
        </div>
        <div class="onboarding__step">
          <span class="onboarding__num" aria-hidden="true">2</span>
          <div class="field onboarding__field">
            <label class="field__label" for="${ids.target}">Translate into</label>
            <p class="field__hint" id="${ids.target}-hint">Your own language. Translations and flashcards use it.</p>
            <select class="select" id="${ids.target}" aria-describedby="${ids.target}-hint">${targetOptions(draft.target)}</select>
            <p class="field__error" id="${ids.target}-error" hidden></p>
          </div>
        </div>
        <div class="onboarding__footer">
          <button type="submit" class="btn btn--primary">${icon('check', { size: 18 })}<span class="btn__label">Save languages</span></button>
          <p class="text-sm text-muted">Then load a game below. You can change languages any time with the language button at the top.</p>
        </div>
      </form>
    </section>`);
    const form = container.querySelector('[data-onb-form]');
    form.addEventListener('submit', (e) => { e.preventDefault(); commit({ fromSubmit: true }); });
    form.addEventListener('change', onChange);
    form.addEventListener('click', onClick);
  }

  const sourceSel = () => container.querySelector(`#${ids.source}`);
  const targetSel = () => container.querySelector(`#${ids.target}`);

  function setSource(code) {
    draft.source = code;
    const sel = sourceSel();
    if (sel && sel.value !== code) sel.value = code;
    for (const b of container.querySelectorAll('[data-quick]')) b.setAttribute('aria-pressed', String(b.dataset.quick === code));
    render(container.querySelector('[data-onb-note]'), note(code));
    // never translate a language into itself
    if (draft.target === code) {
      draft.target = suggestTarget(code);
      const t = targetSel();
      if (t) t.value = draft.target;
    }
    clearErrors();
  }

  function onChange(e) {
    if (e.target.id === ids.source) setSource(e.target.value);
    else if (e.target.id === ids.target) { draft.target = e.target.value; clearErrors(); }
  }

  function onClick(e) {
    const chip = e.target.closest('[data-quick]');
    if (chip) setSource(chip.dataset.quick);
  }

  function clearErrors() {
    for (const sel of container.querySelectorAll('select')) {
      sel.removeAttribute('aria-invalid');
      const err = container.querySelector(`#${sel.id}-error`);
      if (err) { err.hidden = true; render(err, ''); }
      const base = sel.id === ids.source ? `${ids.source}-hint ${ids.source}-note` : `${ids.target}-hint`;
      sel.setAttribute('aria-describedby', base);
    }
  }

  function showError(sel, message) {
    const err = container.querySelector(`#${sel.id}-error`);
    render(err, html`${icon('alert-circle', { size: 16 })}<span>${message}</span>`);
    err.hidden = false;
    sel.setAttribute('aria-invalid', 'true');
    sel.setAttribute('aria-describedby', `${sel.getAttribute('aria-describedby')} ${err.id}`);
    sel.focus();
  }

  /**
   * Save the chosen pair. With fromSubmit, a missing game language is an
   * error the player sees; otherwise (loading a game) it quietly returns false.
   */
  function commit({ fromSubmit = false } = {}) {
    if (!shown) return !needsOnboarding();
    const src = draft.source;
    const tgt = draft.target;
    if (!src) {
      if (fromSubmit) showError(sourceSel(), 'Choose the language your game is in.');
      return false;
    }
    if (!tgt || tgt === src) {
      if (fromSubmit) showError(targetSel(), 'Choose a different language to translate into.');
      return false;
    }
    store.set('source', src);
    store.set('target', tgt);
    store.set('onboarded', true);
    announce(`Languages saved: ${langName(src)} to ${langName(tgt)}.`);
    hide();
    onDone(src, tgt, { fromSubmit });
    return true;
  }

  function show() {
    if (shown) return;
    shown = true;
    // the card can come back (settings reset): start from what is stored now
    draft.source = store.get('source') || '';
    draft.target = initialTarget(draft.source || null);
    container.hidden = false;
    draw();
  }

  function hide() {
    shown = false;
    container.hidden = true;
    render(container, '');
  }

  function sync() {
    if (needsOnboarding()) show();
    else hide();
  }

  // The pair can also be set with the header language dialog while this
  // card is open: that counts as done. (Our own commit sets the source with
  // focus inside the card and finishes itself.)
  store.subscribe((key) => {
    if (!shown) return;
    if (key === 'onboarded' && !needsOnboarding()) hide();
    else if (key === 'source' && store.get('source') && !container.contains(document.activeElement)) {
      store.set('onboarded', true);
      hide();
    }
  });

  return { sync, commit, visible: () => shown, hasDraft: () => !!draft.source };
}
