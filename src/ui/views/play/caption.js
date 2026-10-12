// The translation caption: a subtitle strip under the game picture on
// phones (html[data-handheld], see index.js). It always shows the newest
// live capture, whatever the Live translation card is showing, and its
// button opens that card. CSS shows it only in the phone layouts.
//
// It sits in the stage (shown in fullscreen too) but outside the game's
// role=application, so screen readers reach it after the game screen.
// It is not a live region and never announces: the card's announcements
// stay the only ones (no double reading).
//
// WCAG 2.2.2: the text changes only when the game's own text does, which
// mostly follows the player pressing A. Auto-translate (P, the eye button)
// and Pause stop it. With Auto-translate off the game moves on unread, so
// the line from before is not shown under it: the caption says it is
// paused until "Translate now" reads the screen again.
import { html, render } from '../../dom.js';
import { icon } from '../../icons.js';
import { dirFor } from '../../../core/language.js';
import { captionView } from './model.js';

const tagFor = (code) => String(code || '').split('-')[0].toUpperCase();
// (captionView's wording for it: "Auto-translate is off. Use Translate now…")
const AUTO_OFF = Object.freeze({ state: 'paused', message: '' });

/**
 * createCaption(el, { onOpen, target, autoTranslate }) →
 *   { show(capture, { fresh }), setStatus(status), setPhase(phase), setTarget(code), setAutoTranslate(on) }
 * `fresh`: the capture is a new read of the screen (a new line, Translate now).
 */
export function createCaption(el, { onOpen = () => {}, target = '', autoTranslate = true } = {}) {
  render(el, html`<span class="caption__tag" aria-hidden="true" data-caption-tag>${tagFor(target)}</span>
    <p class="caption__text"><span class="visually-hidden" data-caption-prefix>Translation: </span><span data-caption-text></span></p>
    <button type="button" class="caption__open" aria-label="Open Live translation">${icon('chevron-down', { size: 20 })}</button>`);

  const tag = el.querySelector('[data-caption-tag]');
  const prefix = el.querySelector('[data-caption-prefix]');
  const text = el.querySelector('[data-caption-text]');
  let capture = null;
  let status = null;
  let phase = 'idle';
  // the line on show was read before Auto-translate went off
  let stale = !autoTranslate;
  let last = { state: null, text: null, lang: null };

  // Patch only what changed: the scanner updates about every 200 ms, the
  // text changes once per line.
  function update() {
    // (a problem with live translation still shows)
    const st = stale && !(status && status.state === 'error') ? AUTO_OFF : status;
    const v = captionView(stale ? null : capture, { status: st, phase });
    if (v.state === last.state && v.text === last.text && v.lang === last.lang) return;
    if (v.state !== last.state) {
      el.dataset.state = v.state;
      prefix.hidden = v.state !== 'done';
    }
    if (v.text !== last.text) text.textContent = v.text;
    if (v.lang !== last.lang) {
      if (v.lang) {
        text.setAttribute('lang', v.lang);
        text.setAttribute('dir', dirFor(v.lang));
      } else {
        text.removeAttribute('lang');
        text.removeAttribute('dir');
      }
    }
    last = v;
  }

  el.querySelector('.caption__open').addEventListener('click', () => onOpen());
  update();

  return {
    show(c, { fresh = false } = {}) {
      capture = c || null;
      if (fresh) stale = false;
      update();
    },
    setStatus(s) {
      status = s || null;
      update();
    },
    setPhase(p) {
      phase = p;
      update();
    },
    setTarget(code) {
      const t = tagFor(code);
      if (tag.textContent !== t) tag.textContent = t;
    },
    setAutoTranslate(on) {
      stale = !on;
      update();
    }
  };
}
