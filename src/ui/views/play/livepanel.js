// Live translation card. The panel is built once; each capture is rendered
// into it and later updates patch only what changed (a translation landing,
// a retry), so keyboard focus is never lost (A11Y-06, UX-11/12).
//
// WCAG 2.2.2: while focus or the pointer is inside the panel, or a word
// look-up is open, a new line never replaces what the player is reading.
// It waits behind a "New line – Show" button and appears once they leave.
//
// Words of the game text are real buttons in a roving-tabindex group: one
// Tab stop per text, arrows/Home/End move, Enter or Space looks a word up.
import { html, render, uid } from '../../dom.js';
import { icon } from '../../icons.js';
import { announce } from '../../a11y.js';
import { banner, setStatusChip, statusChip, progress, setProgress, emptyState, kbd, setBusy } from '../../components.js';
import { formatRelative, formatCount } from '../../format.js';
import { dirFor, langName } from '../../../core/language.js';
import * as tts from '../../../core/tts.js';
import { wordTokens, rovingTarget, captureParts, diffCapture, isLowConfidence, statusView } from './model.js';

const NOTICE_MS = 4000;

/**
 * createLivePanel(section, opts) → controller
 * opts: {
 *   popover,                         // createWordPopover() instance
 *   onRetryPart(capture, key, mode), // 'live' | 'history'
 *   onStatusRetry(),
 *   onSwitchLanguage(code), onDismissHint(),
 *   onAddToDeck(capture),
 *   onBackToLive(),
 *   onModeChange(mode, capture)
 * }
 */
export function createLivePanel(section, opts = {}) {
  const {
    popover, onRetryPart = () => {}, onStatusRetry = () => {}, onSwitchLanguage = () => {},
    onDismissHint = () => {}, onAddToDeck = () => {}, onBackToLive = () => {}, onModeChange = () => {}
  } = opts;
  const id = uid('live');
  const ids = { title: 'play-live-title', help: `${id}-words-help` };

  let shown = null;        // capture on screen
  let mode = 'live';       // 'live' | 'history'
  let latestLive = null;   // newest capture from the scanner (id of the last 'capture' event)
  let queued = null;       // live capture waiting for the player to finish reading
  let showNextSrc = null;  // the player switched the game language: show its re-read at once
  let announcedQueue = null;
  let phase = 'idle';       // game: 'idle' | 'loading' | 'running' | 'error'
  let hint = null;
  let focusInside = false;
  let hoverInside = false;
  let popoverOpen = false;
  let noticeTimer = 0;
  let addedCount = 0;
  let lastStatus = { state: 'off' };

  section.setAttribute('aria-labelledby', ids.title);
  render(section, html`<div class="live__head">
      <h2 class="card__title live__title" id="${ids.title}">Live translation</h2>
      ${statusChip({ state: 'off' })}
    </div>
    <div class="live__status" data-status-row hidden>
      <p class="live__status-msg" data-status-msg></p>
      <div class="live__status-progress" data-status-progress hidden>${progress({ value: null, label: 'Getting text recognition ready', showValue: true })}</div>
      <div class="live__status-actions" data-status-actions hidden>
        <button type="button" class="btn btn--sm" data-action="status-retry">${icon('refresh-cw', { size: 16 })}<span class="btn__label">Retry</span></button>
        <details class="disclosure live__details" data-status-details hidden>
          <summary class="text-sm">Details</summary>
          <p class="text-sm text-muted live__detail-text" data-status-detail></p>
        </details>
      </div>
    </div>
    <div class="live__notices" data-notices></div>
    <div class="live__content" data-content></div>
    <div class="live__actions" data-actions>
      <div class="live__listen">
        <button type="button" class="btn btn--sm" data-action="listen" aria-disabled="true">${icon('volume-2', { size: 16 })}<span class="btn__label">Listen</span></button>
        <button type="button" class="btn btn--sm" data-action="listen-translation" aria-disabled="true">${icon('languages', { size: 16 })}<span class="btn__label">Listen to translation</span></button>
        <button type="button" class="btn btn--sm btn--ghost" data-action="stop-speaking" hidden>${icon('stop', { size: 16 })}<span class="btn__label">Stop speaking</span></button>
      </div>
      <div class="live__deck">
        <button type="button" class="btn btn--sm btn--primary" data-action="add-card" aria-disabled="true">${icon('plus', { size: 16 })}<span class="btn__label">Add to deck</span></button>
        <a class="live__added" href="#/deck" data-added hidden>${icon('check-circle', { size: 16 })}<span data-added-text></span></a>
      </div>
    </div>
    <p class="visually-hidden" id="${ids.help}">Use the arrow keys to move between words, then press Enter to look one up.</p>`);

  const $ = (sel) => section.querySelector(sel);
  const chip = $('.status-chip');
  const content = $('[data-content]');
  const notices = $('[data-notices]');
  if (!tts.supported()) {
    for (const a of ['listen', 'listen-translation']) $(`[data-action="${a}"]`).hidden = true;
  }

  // ---- status -------------------------------------------------------------------

  function setStatus(status) {
    lastStatus = status || { state: 'off' };
    const v = statusView(lastStatus);
    setStatusChip(chip, { state: v.state, label: v.label });
    const row = $('[data-status-row]');
    const msg = $('[data-status-msg]');
    const prog = $('[data-status-progress]');
    const actions = $('[data-status-actions]');
    const details = $('[data-status-details]');
    msg.textContent = v.message;
    prog.hidden = v.state !== 'setup';
    if (v.state === 'setup') setProgress(prog.querySelector('.progress'), v.progress, v.message || 'Getting text recognition ready');
    actions.hidden = v.state !== 'error';
    details.hidden = !(v.state === 'error' && v.detail);
    $('[data-status-detail]').textContent = v.detail;
    row.hidden = !v.message && v.state !== 'setup';
    // the setup message is the progress label; don't show it twice
    if (v.state === 'setup') msg.textContent = '';
    if (!shown) renderEmpty();
  }

  // ---- notices (hint, history, queued line) -------------------------------------

  function renderNotices() {
    const parts = [];
    if (hint && hint.type === 'language-mismatch' && hint.detected) {
      const name = langName(hint.detected);
      parts.push(banner({
        tone: 'info',
        icon: 'languages',
        body: `This text looks ${name}. Switch the game language to ${name}?`,
        actions: html`<button type="button" class="btn btn--sm btn--primary" data-action="hint-switch" data-lang="${hint.detected}"><span class="btn__label">Switch</span></button>
          <button type="button" class="btn btn--sm btn--ghost" data-action="hint-dismiss"><span class="btn__label">Dismiss</span></button>`
      }));
    }
    if (mode === 'history' && shown) {
      parts.push(html`<div class="live__notice live__notice--history" data-notice="history">
        ${icon('history', { size: 16 })}
        <p class="live__notice-text">Viewing an earlier line<span class="visually-hidden">, </span><span class="live__notice-meta">${formatRelative(shown.time)}</span></p>
        <button type="button" class="btn btn--sm" data-action="back-to-live">${icon('arrow-right', { size: 16 })}<span class="btn__label">Back to live</span></button>
      </div>`);
    } else if (queued) {
      parts.push(html`<div class="live__notice live__notice--queued" data-notice="queued">
        ${icon('sparkles', { size: 16 })}
        <p class="live__notice-text">New line on screen</p>
        <button type="button" class="btn btn--sm btn--primary" data-action="show-queued"><span class="btn__label">Show</span></button>
      </div>`);
    }
    const transient = notices.querySelector('[data-notice="transient"]');
    const hadFocus = notices.contains(document.activeElement) ? document.activeElement.dataset.action : null;
    render(notices, html`${parts}`);
    if (transient) notices.appendChild(transient);
    if (hadFocus) {
      const again = notices.querySelector(`[data-action="${hadFocus}"]`);
      if (again) again.focus();
      else focusContent();
    }
  }

  function flashNotice(text) {
    clearTimeout(noticeTimer);
    let el = notices.querySelector('[data-notice="transient"]');
    if (!el) {
      el = document.createElement('p');
      el.className = 'live__notice live__notice--transient';
      el.dataset.notice = 'transient';
      notices.appendChild(el);
    }
    render(el, html`${icon('info', { size: 16 })}<span>${text}</span>`);
    announce(text);
    noticeTimer = setTimeout(() => el.remove(), NOTICE_MS);
  }

  // ---- capture rendering --------------------------------------------------------

  function wordsHtml(text, lang, label) {
    // Punctuation sticks to its word, so a line never starts with "?" (a
    // button is a line-break opportunity on both sides).
    const items = [];
    let pre = '';
    for (const t of wordTokens(text, lang)) {
      if (t.word) { items.push({ word: t.text, pre, post: '' }); pre = ''; continue; }
      const prev = items[items.length - 1];
      const afterWord = !!prev && typeof prev !== 'string';
      // "?" or ", " goes with the word before it, "¿" or " “" with the next one
      const lead = afterWord ? t.text.match(/^\S*/)[0] : '';
      const tail = lead === t.text ? '' : t.text.match(/\S*$/)[0];
      if (lead) prev.post += lead;
      items.push(t.text.slice(lead.length, t.text.length - tail.length));
      pre = tail;
    }
    if (pre) items.push(pre);
    let first = true;
    return html`<span class="words" role="group" aria-label="${label}" aria-describedby="${ids.help}" data-words>${items.map((it) => {
      if (typeof it === 'string') return it;
      const tab = first ? '0' : '-1';
      first = false;
      const btn = html`<button type="button" class="word" tabindex="${tab}" data-word aria-haspopup="dialog" aria-expanded="false">${it.word}</button>`;
      return it.pre || it.post ? html`<span class="word-glue">${it.pre}${btn}${it.post}</span>` : btn;
    })}</span>`;
  }

  function retryHtml(p, message) {
    return html`<p class="part__trans part__trans--error">
        ${icon('alert-circle', { size: 16 })}<span>${message}</span>
        <button type="button" class="btn btn--sm btn--ghost part__retry" data-action="retry-part" data-part="${p.key}">${icon('refresh-cw', { size: 16 })}<span class="btn__label">Retry</span></button>
      </p>`;
  }

  function transHtml(p, c) {
    if (p.status === 'error') return retryHtml(p, 'Couldn’t translate.');
    if (!p.translation) {
      // Only the live line has a translation on its way. An earlier line
      // left unfinished (or one that came back empty) would otherwise show
      // "Translating…" for ever.
      const waiting = mode === 'live' && (p.status === 'pending' || p.status === 'translating');
      if (!waiting) return retryHtml(p, 'Not translated.');
      return html`<p class="part__trans part__trans--pending"><span class="spinner" aria-hidden="true"></span><span>Translating…</span></p>`;
    }
    const updating = p.status !== 'done';
    return html`<p class="${updating ? 'part__trans part__trans--updating' : 'part__trans'}" lang="${c.tgt}" dir="${dirFor(c.tgt)}">${p.translation}${updating ? html`<span class="part__updating" lang="en" dir="ltr"> · updating…</span>` : ''}</p>`;
  }

  function partHtml(p, c) {
    const label = p.key === 'dialog' ? 'Game text' : p.kind === 'menu' ? 'Menu text' : 'Text on screen';
    return html`<div class="part__orig" lang="${c.src}" dir="${dirFor(c.src)}">${wordsHtml(p.text, c.src, label)}</div>
      <div class="part__trans-slot" data-trans>${transHtml(p, c)}</div>`;
  }

  function otherItem(p, c) {
    return html`<li class="part part--other part--${p.kind}" data-key="${p.key}">${partHtml(p, c)}</li>`;
  }

  function captureHtml(c) {
    const parts = captureParts(c);
    const dialog = parts.find((p) => p.key === 'dialog');
    const others = parts.filter((p) => p.key !== 'dialog');
    return html`<article class="capture" data-capture-id="${c.id}" tabindex="-1" aria-labelledby="${id}-cap-label">
      <h3 class="visually-hidden" id="${id}-cap-label">${mode === 'history' ? 'Earlier line' : 'Current line'}</h3>
      ${dialog ? html`<div class="part part--dialog" data-key="dialog">${partHtml(dialog, c)}</div>` : ''}
      <p class="capture__lowconf" data-lowconf ${{ hidden: !isLowConfidence(c.conf) }}>${icon('info', { size: 16 })}<span>The text may not have been read correctly.</span></p>
      <div class="capture__also" data-also ${{ hidden: !others.length }}>
        <h3 class="capture__also-title">${dialog ? 'Also on screen' : 'On screen'}</h3>
        <ul class="also-list" role="list" data-also-list>${others.map((p) => otherItem(p, c))}</ul>
      </div>
    </article>`;
  }

  const EMPTY = {
    idle: ['Nothing to translate yet', 'Start a game, and the text on screen appears here with its translation.'],
    loading: ['Getting ready', 'Translations start as soon as the game is running.'],
    error: ['Nothing to translate yet', 'The game didn’t start. Try again, or choose another game.'],
    setup: ['Getting ready', 'Text recognition is getting ready. This takes a moment the first time.'],
    running: ['Watching the screen', 'When text appears in the game, it shows up here with its translation.']
  };

  let emptyKey = null;

  function renderEmpty() {
    if (shown) return;
    const key = phase === 'running' && lastStatus.state === 'setup' ? 'setup' : phase;
    $('[data-actions]').hidden = true;
    if (key === emptyKey && content.querySelector('.empty-state')) return;
    emptyKey = key;
    const [title, body] = EMPTY[key] || EMPTY.idle;
    render(content, html`${emptyState({ icon: 'message-square', level: 3, title, body })}
      ${phase === 'running' ? html`<p class="live__empty-hint text-sm text-muted">Select <strong>Translate now</strong>${html`<span class="kbd-hint"> or press ${kbd('T')}</span>`} to read the screen right away.</p>` : ''}`);
  }

  function updateActions() {
    const c = shown;
    const d = c && c.dialog && c.dialog.text ? c.dialog : null;
    const text = d ? d.text : '';
    setDisabled('listen', !text);
    setDisabled('listen-translation', !(d && d.translation));
    setDisabled('add-card', !(d && d.translation));
  }

  function setDisabled(action, off) {
    const b = $(`[data-action="${action}"]`);
    if (!b) return;
    if (off) b.setAttribute('aria-disabled', 'true');
    else b.removeAttribute('aria-disabled');
  }

  // A word look-up anchored in the content that is about to be replaced
  // would float over nothing: close it. → whether it had keyboard focus.
  function closeDetachedPopover() {
    if (!popover || typeof popover.isOpen !== 'function' || !popover.isOpen()) return false;
    const anchor = typeof popover.anchor === 'function' ? popover.anchor() : null;
    if (anchor && !content.contains(anchor)) return false;
    const box = popover.element;
    const hadFocus = !!(box && box.contains(document.activeElement));
    popover.close({ returnFocus: false });
    return hadFocus;
  }

  function renderCapture(c) {
    const refocus = closeDetachedPopover();
    shown = c;
    $('[data-actions]').hidden = false;
    render(content, captureHtml(c));
    updateActions();
    renderNotices();
    if (refocus) focusContent();
  }

  // Patch translations/statuses of parts in place (focus-safe).
  function patch(c, keys) {
    shown = c;
    const parts = captureParts(c);
    for (const key of keys) {
      const p = parts.find((x) => x.key === key);
      const partEl = Array.from(content.querySelectorAll('[data-key]')).find((n) => n.dataset.key === key);
      const el = partEl ? partEl.querySelector('[data-trans]') : null;
      if (!p || !el) continue;
      const hadFocus = el.contains(document.activeElement);
      render(el, transHtml(p, c));
      if (hadFocus) {
        // the Retry button that had focus is gone: keep the player in this part
        const words = el.closest('.part').querySelector('.word[tabindex="0"]');
        (el.querySelector('button') || words || content.querySelector('.capture')).focus({ preventScroll: true });
      }
    }
    const low = content.querySelector('[data-lowconf]');
    if (low) low.hidden = !isLowConfidence(c.conf);
    updateActions();
  }

  // ---- presenting ------------------------------------------------------------------

  // The hover flag is checked against :hover: a pointer that left while the
  // view was hidden (or the panel moved away under it) sends no pointerleave,
  // and a stale flag would hold every new line back.
  function hovered() {
    if (!hoverInside) return false;
    try { return section.matches(':hover'); } catch { return true; }
  }

  const frozen = () => focusInside || hovered() || popoverOpen;

  function apply(c, { force = false } = {}) {
    const d = diffCapture(shown, c);
    if (d.kind === 'none') { shown = c; return; }
    if (d.kind === 'translation') { patch(c, d.changed.length ? d.changed : []); return; }
    // nothing on show yet: there is nothing to keep steady for the reader
    if (frozen() && !force && shown) {
      queued = c;
      renderNotices();
      if (announcedQueue !== c.id) {
        announcedQueue = c.id;
        announce('New line on screen. Select Show to read it.');
      }
      return;
    }
    const hadFocus = section.contains(document.activeElement);
    queued = null;
    renderCapture(c);
    // never pull focus out of the game or the toolbar; only keep it in the panel
    if (hadFocus && !section.contains(document.activeElement)) focusContent();
  }

  // The line on show, else the panel heading (never leave focus on <body>).
  function focusContent() {
    const art = content.querySelector('.capture');
    if (art) { art.focus({ preventScroll: true }); return; }
    const head = section.querySelector(`#${ids.title}`);
    if (head) {
      head.setAttribute('tabindex', '-1');
      head.focus({ preventScroll: true });
    }
  }

  /** A capture or update from the scanner. */
  function showLive(c, { isNew = false, force = false } = {}) {
    if (!c) return;
    if (isNew) latestLive = c;
    else if (latestLive && c.id === latestLive.id) latestLive = c;
    if (mode === 'history') {
      if (shown && c.id === shown.id) apply(c);
      return;
    }
    // an update for an older capture (a late translation) only matters if it is the one on screen
    const isLatest = latestLive && c.id === latestLive.id;
    if (!isLatest && !(shown && c.id === shown.id)) return;
    // the line re-read after "Switch" is what the player asked for: don't
    // hold it back behind "New line on screen" (focus and pointer are here)
    if (isNew && showNextSrc && c.src === showNextSrc) { showNextSrc = null; force = true; }
    if (queued && c.id === queued.id && frozen() && !force) { queued = c; return; }
    apply(c, { force });
  }

  function showHistory(c) {
    if (!c) return;
    popover && popover.close({ returnFocus: false });
    mode = 'history';
    queued = null;
    renderCapture(c);
    onModeChange(mode, c);
    focusContent();
    announce(`Showing a line from ${formatRelative(c.time)}.`);
  }

  function backToLive({ focus = true, quiet = false } = {}) {
    if (mode !== 'history') return;
    const hadFocus = section.contains(document.activeElement);
    mode = 'live';
    popover && popover.close({ returnFocus: false });
    shown = null;
    if (latestLive) renderCapture(latestLive);
    else { render(content, ''); renderEmpty(); updateActions(); renderNotices(); }
    onModeChange(mode, shown);
    // without `focus`, still never drop keyboard focus that was in the panel
    if (focus || (hadFocus && !section.contains(document.activeElement))) focusContent();
    if (!quiet) announce('Back to the live translation.');
  }

  function flushQueued() {
    if (!queued || frozen() || mode !== 'live') return;
    const c = queued;
    queued = null;
    renderCapture(c);
  }

  // ---- events ----------------------------------------------------------------------

  section.addEventListener('focusin', () => { focusInside = true; });
  section.addEventListener('focusout', (e) => {
    if (e.relatedTarget && section.contains(e.relatedTarget)) return;
    focusInside = false;
    // focus moving into the word popover keeps things frozen through popoverOpen
    setTimeout(flushQueued, 0);
  });
  section.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hoverInside = true; });
  section.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    hoverInside = false;
    flushQueued();
  });

  section.addEventListener('keydown', (e) => {
    const word = e.target.closest && e.target.closest('.word');
    if (!word) return;
    const group = word.closest('[data-words]');
    const list = Array.from(group.querySelectorAll('.word'));
    const idx = list.indexOf(word);
    const rtl = word.closest('[dir]') && word.closest('[dir]').getAttribute('dir') === 'rtl';
    const next = rovingTarget(e.key, idx, list.length, { rtl });
    if (next < 0) return;
    e.preventDefault();
    if (next === idx) return;
    word.tabIndex = -1;
    list[next].tabIndex = 0;
    list[next].focus();
  });

  section.addEventListener('click', (e) => {
    const word = e.target.closest('.word');
    if (word && shown) {
      // keep the group's tab stop on the word the player used
      const group = word.closest('[data-words]');
      for (const w of group.querySelectorAll('.word')) w.tabIndex = w === word ? 0 : -1;
      const lang = word.closest('[lang]') ? word.closest('[lang]').getAttribute('lang') : shown.src;
      if (!popover) return;
      // the word says aria-expanded: pressing it again closes its look-up
      if (word.getAttribute('aria-expanded') === 'true' && typeof popover.anchor === 'function' && popover.anchor() === word) popover.close();
      else popover.open(word, { term: word.textContent.trim(), src: lang || shown.src, tgt: shown.tgt });
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
    const c = shown;
    switch (btn.dataset.action) {
      case 'retry-part':
        if (c) {
          // busy (aria-disabled) until the attempt ends: a second press can't
          // start a parallel one, and an earlier line shows it is working
          setBusy(btn, true, { label: 'Retrying…' });
          Promise.resolve(onRetryPart(c, btn.dataset.part, mode))
            .catch(() => {})
            .finally(() => { if (btn.isConnected) setBusy(btn, false); });
        }
        break;
      case 'status-retry':
        onStatusRetry();
        break;
      case 'hint-switch':
        showNextSrc = btn.dataset.lang || null;
        onSwitchLanguage(btn.dataset.lang);
        break;
      case 'hint-dismiss':
        onDismissHint();
        break;
      case 'back-to-live':
        onBackToLive();
        backToLive();
        break;
      case 'show-queued': {
        const q = queued;
        queued = null;
        if (q) renderCapture(q);
        focusContent();
        break;
      }
      case 'listen':
        if (c && c.dialog) tts.speak(c.dialog.text, c.src);
        break;
      case 'listen-translation':
        if (c && c.dialog && c.dialog.translation) tts.speak(c.dialog.translation, c.tgt);
        break;
      case 'add-card':
        if (c) onAddToDeck(c);
        break;
      case 'stop-speaking':
        tts.stop();
        break;
      default:
    }
  });

  renderEmpty();

  return {
    setStatus,
    showLive,
    showHistory,
    // a changed copy of the capture on screen (e.g. a retried history line)
    updateShown(c) {
      if (c && shown && c.id === shown.id) apply(c, { force: true });
    },
    backToLive,
    flashNotice,
    setPhase(next) {
      phase = next;
      if (!shown) renderEmpty();
    },
    setHint(next) {
      const same = (hint && hint.detected) === (next && next.detected) && (hint && hint.type) === (next && next.type);
      hint = next || null;
      if (same) return;
      renderNotices();
      // the banner appears without focus moving: say it once
      if (hint && hint.type === 'language-mismatch' && hint.detected) {
        announce(`This text looks ${langName(hint.detected)}. You can switch the game language in the live translation.`);
      }
    },
    setPopoverOpen(open) {
      popoverOpen = !!open;
      if (!open) setTimeout(flushQueued, 0);
    },
    setSpeaking(on) {
      const b = $('[data-action="stop-speaking"]');
      if (!b) return;
      if (!on && b.contains(document.activeElement)) {
        const listen = $('[data-action="listen"]');
        if (listen && !listen.hidden) listen.focus();
      }
      b.hidden = !on;
    },
    setAdded(n) {
      addedCount = n;
      const a = $('[data-added]');
      a.hidden = !n;
      $('[data-added-text]').textContent = n ? `${formatCount(n, 'sentence')} added to your deck` : '';
    },
    current: () => shown,
    mode: () => mode,
    added: () => addedCount,
    isFrozen: frozen
  };
}
