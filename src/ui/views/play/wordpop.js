// Word look-up popover: a non-modal dialog anchored to the word button (a
// bottom sheet on phones). Shows the word in the game's language and its
// translation, with Listen (the word itself, in the game's language), Add
// word to deck and Close. Escape or Close returns focus to the word; a
// slower earlier look-up never overwrites a newer one (PLAY-19, A11Y-21).
import { html, render, uid } from '../../dom.js';
import { icon } from '../../icons.js';
import { announce } from '../../a11y.js';
import { setBusy } from '../../components.js';
import { dirFor, langName } from '../../../core/language.js';
import { lookupWord } from '../../../core/dictionary.js';
import * as srs from '../../../core/srs.js';
import * as tts from '../../../core/tts.js';

const SHEET_QUERY = '(max-width: 599.98px)';
const GAP = 8;

/**
 * createWordPopover({ host, onChange(open), onCardsChanged }) →
 *   { open(anchor, { term, src, tgt }), close({ returnFocus }), isOpen(), anchor() }
 * host: element the popover lives in (inside the Play view, so it hides with it).
 */
export function createWordPopover({ host, onChange = () => {}, onCardsChanged = () => {} }) {
  const id = uid('wordpop');
  const el = document.createElement('div');
  el.className = 'wordpop';
  el.id = id;
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'false');
  el.setAttribute('aria-labelledby', `${id}-term`);
  host.appendChild(el);

  let current = null; // { anchor, term, src, tgt, translation, state }
  let seq = 0;
  let raf = 0;
  const sheet = typeof matchMedia === 'function' ? matchMedia(SHEET_QUERY) : null;

  function renderBody() {
    const c = current;
    if (!c) return;
    const speakable = tts.supported();
    const body = c.state === 'loading'
      ? html`<p class="wordpop__status" role="status"><span class="spinner" aria-hidden="true"></span><span>Looking up…</span></p>`
      : c.state === 'error'
        ? html`<div class="wordpop__error" role="status">
            <p>${icon('alert-circle', { size: 16 })}<span>Couldn’t look up this word. Check your connection and try again.</span></p>
            <button type="button" class="btn btn--sm" data-action="wp-retry">${icon('refresh-cw', { size: 16 })}<span class="btn__label">Try again</span></button>
          </div>`
        : html`<p class="wordpop__trans" lang="${c.tgt}" dir="${dirFor(c.tgt)}">${c.translation}</p>`;
    render(el, html`<div class="wordpop__head">
        <div class="wordpop__heading">
          <p class="wordpop__eyebrow">${langName(c.src)}</p>
          <h3 class="wordpop__term" id="${id}-term" lang="${c.src}" dir="${dirFor(c.src)}" tabindex="-1">${c.term}</h3>
        </div>
        <button type="button" class="icon-btn icon-btn--sm" data-action="wp-close" aria-label="Close">${icon('x', { size: 16 })}</button>
      </div>
      <div class="wordpop__body">${body}</div>
      <div class="wordpop__actions">
        ${speakable ? html`<button type="button" class="btn btn--sm" data-action="wp-listen">${icon('volume-2', { size: 16 })}<span class="btn__label">Listen</span></button>` : ''}
        <button type="button" class="btn btn--sm btn--primary" data-action="wp-add" ${{ 'aria-disabled': c.state !== 'done' ? 'true' : null }}>${icon('plus', { size: 16 })}<span class="btn__label">Add word to deck</span></button>
      </div>`);
  }

  function place() {
    raf = 0;
    if (!current || el.hidden) return;
    if (sheet && sheet.matches) {
      el.style.left = '';
      el.style.top = '';
      el.classList.add('wordpop--sheet');
      return;
    }
    el.classList.remove('wordpop--sheet');
    const a = current.anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let left = a.left + a.width / 2 - w / 2;
    left = Math.max(GAP, Math.min(vw - w - GAP, left));
    let top = a.bottom + GAP;
    if (top + h > vh - GAP && a.top - h - GAP > GAP) top = a.top - h - GAP;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function schedulePlace() {
    if (!raf) raf = requestAnimationFrame(place);
  }

  // Re-render the body without dropping focus: back onto the same action,
  // else the heading.
  function refresh() {
    const active = document.activeElement;
    const hadFocus = !!active && el.contains(active);
    const action = hadFocus && active.dataset ? active.dataset.action : null;
    renderBody();
    schedulePlace();
    if (!hadFocus) return;
    const target = (action && el.querySelector(`[data-action="${action}"]`)) || el.querySelector(`#${id}-term`);
    if (target) target.focus({ preventScroll: true });
  }

  async function lookUp() {
    const c = current;
    if (!c) return;
    const mySeq = ++seq;
    if (c.state !== 'loading') {
      c.state = 'loading';
      refresh();
    }
    try {
      const res = await lookupWord(c.term, c.src, c.tgt);
      if (mySeq !== seq || current !== c) return; // a newer look-up won
      c.translation = (res && res.translation) || '';
      c.state = c.translation ? 'done' : 'error';
    } catch {
      if (mySeq !== seq || current !== c) return;
      c.state = 'error';
    }
    refresh();
    if (c.state === 'done') announce([{ text: `${c.term}:`, lang: c.src }, { text: c.translation, lang: c.tgt }]);
    else announce('Couldn’t look up this word.');
  }

  function open(anchor, { term, src, tgt }) {
    if (current && current.anchor !== anchor) setExpanded(current.anchor, false);
    current = { anchor, term, src, tgt, translation: '', state: 'loading' };
    setExpanded(anchor, true);
    el.hidden = false;
    renderBody();
    place();
    const head = el.querySelector(`#${id}-term`);
    if (head) head.focus({ preventScroll: true });
    onChange(true);
    lookUp();
  }

  function setExpanded(anchor, on) {
    if (!anchor) return;
    anchor.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) anchor.setAttribute('aria-controls', id);
    else anchor.removeAttribute('aria-controls');
  }

  function close({ returnFocus = true } = {}) {
    if (!current) return;
    const { anchor } = current;
    current = null;
    seq++;
    el.hidden = true;
    render(el, '');
    setExpanded(anchor, false);
    if (returnFocus && anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
    onChange(false);
  }

  async function addCard(btn) {
    const c = current;
    if (!c || c.state !== 'done') return;
    const res = srs.addCard({ text: c.term, translation: c.translation, src: c.src, tgt: c.tgt, origin: 'manual' });
    if (res.status === 'added') {
      announce(`Added “${c.term}” to your deck.`);
      onCardsChanged();
    } else if (res.status === 'duplicate') {
      announce(`“${c.term}” is already in your deck.`);
    } else {
      announce('Couldn’t add this word.', { assertive: true });
      return;
    }
    const label = btn.querySelector('.btn__label');
    if (label) label.textContent = res.status === 'added' ? 'Added to deck' : 'Already in deck';
    btn.setAttribute('aria-disabled', 'true');
    const ic = btn.querySelector('.icon');
    if (ic) ic.outerHTML = String(icon('check', { size: 16 }));
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !current) return;
    switch (btn.dataset.action) {
      case 'wp-close': close(); break;
      case 'wp-listen': tts.speak(current.term, current.src); break;
      case 'wp-add': addCard(btn); break;
      case 'wp-retry': setBusy(btn, true); lookUp(); break;
      default:
    }
  });
  el.addEventListener('keydown', (e) => {
    if (!current) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // The popover lives at the end of the page, but belongs right after its
    // word: tabbing off either end goes back to the word (and on from there),
    // not to whatever follows the whole Play view.
    if (e.key === 'Tab') {
      const stops = Array.from(el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((b) => !b.hidden && !b.disabled);
      const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
      const leaving = !stops.length || document.activeElement === edge || (e.shiftKey && !stops.includes(document.activeElement));
      if (!leaving) return;
      e.preventDefault();
      close();
    }
  });
  // Escape also works from the word that opened it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current || e.defaultPrevented) return;
    if (document.activeElement !== current.anchor) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }, true);
  // Non-modal: moving focus or clicking elsewhere closes it, without pulling focus back.
  el.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (!current || !to || el.contains(to) || to === current.anchor) return;
    close({ returnFocus: false });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!current || el.contains(e.target) || (current.anchor && current.anchor.contains(e.target))) return;
    close({ returnFocus: el.contains(document.activeElement) });
  }, true);
  window.addEventListener('resize', schedulePlace);
  window.addEventListener('scroll', schedulePlace, { passive: true, capture: true });
  if (sheet && sheet.addEventListener) sheet.addEventListener('change', schedulePlace);

  return {
    open,
    close,
    isOpen: () => !!current,
    anchor: () => (current ? current.anchor : null),
    element: el
  };
}
