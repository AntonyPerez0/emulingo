// Review: a flashcard session over the cards that are due. The card shell is
// rendered once and only its parts change, so keyboard focus is never lost:
// after "Show answer" focus moves to Good, after grading to the next card's
// "Show answer". Space/Enter reveal, 1–4 grade, S speaks the front. A card
// answered Again comes back a few cards later in the same session. The
// session survives switching views; "Study ahead" only moves a card's
// schedule when it is answered Again (srs.grade with { ahead: true }).
import '../../styles/views/review.css';
import { html, render, $, $$ } from '../dom.js';
import { icon } from '../icons.js';
import { announce, registerShortcut, shortcutsEnabled, focusHeading } from '../a11y.js';
import { toast } from '../toast.js';
import { emptyState, badge, button, setBusy } from '../components.js';
import { formatInterval, formatCount } from '../format.js';
import * as srs from '../../core/srs.js';
import * as tts from '../../core/tts.js';
import { translate } from '../../core/translate.js';
import { langName, dirFor } from '../../core/language.js';
import { store } from '../../core/store.js';
import { onChange } from '../../core/db.js';
import { editIcon, untilText } from './listview.js';

export const AGAIN_GAP = 3; // a failed card returns after this many others
export const AHEAD_MAX = 20;
const SECONDS_PER_CARD = 8; // for the "about 2 min" estimate

export const GRADES = Object.freeze([
  { q: 0, key: '1', label: 'Again', tone: 'again' },
  { q: 1, key: '2', label: 'Hard', tone: 'hard' },
  { q: 2, key: '3', label: 'Good', tone: 'good' },
  { q: 3, key: '4', label: 'Easy', tone: 'easy' },
]);

// ---- Pure helpers (exported for tests) ----------------------------------------

/** Queue with `id` re-inserted `gap` places later (or at the end). */
export function requeue(queue, id, gap = AGAIN_GAP) {
  const out = queue.filter((x) => x !== id);
  out.splice(Math.min(Math.max(0, gap), out.length), 0, id);
  return out;
}

/** Cards for "Study ahead": already-studied cards that aren't due yet, soonest first. */
export function studyAheadCards(cards, now = Date.now(), max = AHEAD_MAX) {
  return cards.filter((c) => c.seen > 0 && c.due > now).sort((a, b) => a.due - b.due).slice(0, max);
}

/** Visual size class for the front: short words big, long lines smaller. */
export function frontSize(text) {
  const n = [...String(text ?? '')].length;
  if (n <= 18) return 'xl';
  if (n <= 60) return 'lg';
  return 'md';
}

export function estimateText(n) {
  const min = Math.round((n * SECONDS_PER_CARD) / 60);
  return min < 1 ? 'under a minute' : `about ${min} min`;
}

// ---- State ------------------------------------------------------------------------

let section = null;
let el = {};
let phase = 'start'; // 'start' | 'session' | 'done'
let session = null; // { mode, queue, done, counts, reviewed, ids, startedAt }
let revealed = false;
let editing = false;
let visible = false;
let wakeTimer = 0;
let translating = null; // id of the card whose translation is being fetched
const held = new Set(); // Enter/Space currently held down
let guard = new Set(); // keys held during the last transition

const speechOk = () => {
  try { return tts.supported(); } catch { return false; }
};

function cardsChanged() {
  window.dispatchEvent(new Event('emulingo:cards-changed'));
}

const currentCard = () => (session && session.queue.length ? srs.getCard(session.queue[0]) : null);

// A held Enter repeats key presses: without this guard, the press that
// revealed the answer would go on to activate the newly focused Good button.
function armGuard() { guard = new Set(held); }
function guarded() {
  for (const k of guard) if (held.has(k)) return true;
  return false;
}

// ---- Markup -------------------------------------------------------------------------

const hint = (k) => html`<span class="kbd-hint review-kbd" aria-hidden="true"><kbd>${k}</kbd></span>`;

function pageMarkup() {
  return html`<div class="page page--narrow review" data-review>
    <div class="page-header">
      <div class="page-header__text">
        <h1 tabindex="-1">Review</h1>
        <p class="page-header__subtitle">Practice the words and sentences you’ve met in your games.</p>
      </div>
    </div>

    <div data-r="start"></div>

    <section class="card review-card" data-r="session" aria-labelledby="review-pos" hidden>
      <div class="review-progress">
        <div class="review-progress__head">
          <p class="review-progress__label" id="review-pos" data-r="pos"></p>
          <p class="review-progress__mode" data-r="mode" hidden>${icon('zap', { size: 16 })}<span>Practice — only Again changes your schedule</span></p>
          <button type="button" class="btn btn--ghost btn--sm review-end" data-action="end">${icon('x', { size: 16 })}<span class="btn__label">End session</span></button>
        </div>
        <div class="review-progress__track" role="progressbar" aria-label="Session progress" aria-valuemin="0" data-r="bar">
          <span class="review-progress__fill" data-r="fill"></span>
        </div>
      </div>

      <div class="review-card__side">
        <div class="review-card__lang"><span data-r="src-lang"></span><span data-r="chips"></span></div>
        <p class="review-card__front" data-r="front"></p>
        <div class="review-card__tools">
          <button type="button" class="btn btn--ghost btn--sm" data-action="listen" data-shortcut="S" data-r="listen">${icon('volume-2', { size: 16 })}<span class="btn__label">Listen</span>${hint('S')}</button>
        </div>
      </div>

      <div class="review-card__side review-card__side--back" data-r="answer" hidden>
        <div class="review-card__lang"><span data-r="tgt-lang"></span></div>
        <p class="review-card__back" data-r="back"></p>
        <form class="review-edit" id="review-edit" data-r="edit" hidden novalidate>
          <label class="field__label" for="review-edit-input">Translation</label>
          <input class="input" id="review-edit-input" name="translation" type="text" autocomplete="off" enterkeyhint="done">
          <div class="review-edit__actions">
            <button type="submit" class="btn btn--sm btn--primary">${icon('check', { size: 16 })}<span class="btn__label">Save</span></button>
            <button type="button" class="btn btn--sm btn--ghost" data-action="edit-cancel">Cancel</button>
          </div>
        </form>
        <div class="review-card__tools" data-r="back-tools">
          <button type="button" class="btn btn--ghost btn--sm" data-action="listen-back" data-r="listen-back" aria-label="Listen to translation">${icon('volume-2', { size: 16 })}<span class="btn__label">Listen</span></button>
          <button type="button" class="btn btn--ghost btn--sm" data-action="edit" data-r="edit-btn" aria-expanded="false" aria-controls="review-edit">${editIcon(16)}<span class="btn__label">Edit</span></button>
          <button type="button" class="btn btn--sm" data-action="translate" data-r="translate" hidden>${icon('languages', { size: 16 })}<span class="btn__label">Translate</span></button>
        </div>
      </div>

      <div class="review-card__footer">
        <button type="button" class="btn btn--primary btn--lg review-reveal" data-action="reveal" data-shortcut="Space Enter" data-r="reveal"><span class="btn__label">Show answer</span>${hint('Space')}</button>
        <div class="review-grades" data-r="grades" role="group" aria-labelledby="review-grades-label" hidden>
          <p class="review-grades__prompt" id="review-grades-label">How well did you remember it?</p>
          <div class="review-grades__buttons">
            ${GRADES.map((g) => html`<button type="button" class="grade grade--${g.tone}" data-action="grade" data-q="${g.q}" data-shortcut="${g.key}">
              <span class="grade__label">${g.label}</span>
              <span class="grade__interval" data-r="iv${g.q}"></span>
              ${hint(g.key)}
            </button>`)}
          </div>
        </div>
      </div>
    </section>

    <div data-r="done" hidden></div>
  </div>`;
}

function startMarkup() {
  const total = srs.totalCards();
  if (!total) {
    return html`<div class="card">${emptyState({
      icon: 'layers',
      title: 'Your deck is empty',
      body: store.get('autoAdd') === 'off'
        ? 'Add sentences while you play, or add words from your Dictionary.'
        : 'Sentences you meet while playing are added to your deck automatically. You can also add any word from your Dictionary.',
      action: { label: 'Go to Play', href: '#/play', icon: 'gamepad' },
    })}</div>`;
  }
  const b = srs.dueBreakdown();
  const days = srs.streak();
  const today = srs.reviewsOn(srs.todayKey());
  const streakLine = days || today
    ? html`<p class="review-start__streak">${icon('flame', { size: 16 })}<span>${days ? `${days}-day streak` : ''}${days && today ? ' · ' : ''}${today ? `${formatCount(today, 'review')} today` : ''}</span></p>`
    : '';
  if (b.total) {
    const parts = [
      b.reviews ? formatCount(b.reviews, 'review') : '',
      b.fresh ? `${b.fresh.toLocaleString('en')} new` : '',
      estimateText(b.total),
    ].filter(Boolean);
    return html`<div class="card review-start">
      <div class="review-start__icon" aria-hidden="true">${icon('graduation-cap', { size: 28 })}</div>
      <h2 class="review-start__title">${formatCount(b.total, 'card')} to review</h2>
      <p class="review-start__detail">${parts.join(' · ')}</p>
      <div class="review-start__actions">
        <button type="button" class="btn btn--primary btn--lg" data-action="start" data-shortcut="Enter">${icon('play', { size: 20 })}<span class="btn__label">Start review</span>${hint('Enter')}</button>
      </div>
      ${streakLine}
    </div>`;
  }
  const now = Date.now();
  const all = srs.cards();
  const next = srs.nextDueAt({ now });
  const ahead = studyAheadCards(all, now);
  // With "New cards per day" at 0, new cards never come due: say why.
  const waiting = store.get('newPerDay') === 0 ? all.filter((c) => !c.seen).length : 0;
  const body = [
    next ? `Your next review is ${untilText(next, now)}.` : waiting ? '' : 'Play to collect more words and sentences.',
    waiting ? `${formatCount(waiting, 'new card')} ${waiting === 1 ? 'is' : 'are'} waiting, but “New cards per day” is set to 0 in Settings.` : '',
    ahead.length ? 'You can study ahead — only Again changes your schedule.' : '',
  ].filter(Boolean).join(' ');
  const actions = [
    ahead.length ? { label: 'Study ahead', action: 'ahead', icon: 'zap', kind: 'primary' } : null,
    { label: 'Back to Play', href: '#/play', icon: 'gamepad', kind: ahead.length ? 'secondary' : 'primary' },
  ].filter(Boolean);
  return html`<div class="card review-caught-up">
    ${emptyState({ icon: 'check-circle', title: 'All caught up', body, action: actions })}
    ${streakLine}
  </div>`;
}

function doneMarkup() {
  const s = session;
  const n = s ? s.reviewed.size : 0;
  const mins = s ? Math.round((Date.now() - s.startedAt) / 60000) : 0;
  const time = mins < 1 ? 'in under a minute' : `in ${formatCount(mins, 'minute')}`;
  const moved = s ? s.moved.size : 0;
  const scheduleNote = moved ? `${formatCount(moved, 'card')} ${moved === 1 ? 'was' : 'were'} rescheduled.` : 'Your schedule didn’t change.';
  const summary = s && s.mode === 'ahead'
    ? `You practiced ${formatCount(n, 'card')} ${time}. ${scheduleNote}`
    : `You reviewed ${formatCount(n, 'card')} ${time}.`;
  const due = srs.dueCount();
  const again = due
    ? { label: `Review ${due.toLocaleString('en')} more`, action: 'start', icon: 'play', kind: 'primary' }
    : { label: 'Review again', action: 'again', icon: 'rotate-ccw', kind: 'primary' };
  return html`<div class="card review-done">
    <div class="review-done__icon" aria-hidden="true">${icon('check-circle', { size: 28 })}</div>
    <h2 class="review-done__title" tabindex="-1" data-r="done-title">Session complete</h2>
    <p class="review-done__summary">${summary}</p>
    <dl class="review-done__counts" aria-label="Your answers">
      ${GRADES.map((g) => html`<div class="review-done__count review-done__count--${g.tone}"><dt>${g.label}</dt><dd>${s ? s.counts[g.q] : 0}</dd></div>`)}
    </dl>
    <div class="review-done__actions">
      ${button(again)}
      ${button({ label: 'Back to Play', href: '#/play', icon: 'gamepad', kind: 'secondary' })}
    </div>
  </div>`;
}

// ---- Rendering --------------------------------------------------------------------

function setPhase(next) {
  phase = next;
  el.start.hidden = next !== 'start';
  el.session.hidden = next !== 'session';
  el.done.hidden = next !== 'done';
}

function renderStart() {
  clearTimeout(wakeTimer);
  // Keep focus on the same control when the screen is redrawn in place.
  const a = el.start.contains(document.activeElement) ? document.activeElement : null;
  const same = a && (a.dataset.action ? `[data-action="${a.dataset.action}"]` : a.matches('a[href^="#/"]') ? `a[href="${a.getAttribute('href')}"]` : null);
  render(el.start, startMarkup());
  setPhase('start');
  syncShortcutHints();
  if (a) {
    const btn = (same && $(same, el.start)) || $('button, a[href]', el.start);
    if (btn) btn.focus();
    else focusHeading(section);
  }
  // Refresh by itself when the next card falls due soon (e.g. an Again card).
  const next = srs.totalCards() && !srs.dueCount() ? srs.nextDueAt() : null;
  if (next && next - Date.now() < 3_600_000) {
    wakeTimer = setTimeout(() => {
      if (!visible || phase !== 'start') return;
      renderStart();
      const n = srs.dueCount();
      if (n) announce(`${formatCount(n, 'card')} ready to review.`);
    }, Math.max(1000, next - Date.now() + 500));
  }
}

function renderProgress() {
  const total = session.done + session.queue.length;
  const pos = Math.min(session.done + 1, total);
  el.pos.textContent = `Card ${pos.toLocaleString('en')} of ${total.toLocaleString('en')}`;
  el.bar.setAttribute('aria-valuemax', String(total));
  el.bar.setAttribute('aria-valuenow', String(session.done));
  el.bar.setAttribute('aria-valuetext', `${session.done.toLocaleString('en')} of ${formatCount(total, 'card')} done`);
  el.fill.style.width = `${total ? (session.done / total) * 100 : 0}%`;
  el.mode.hidden = session.mode !== 'ahead';
}

function renderIntervals(card) {
  const iv = srs.previewIntervals(card);
  // Studying ahead keeps the schedule of a card that isn't due (except Again).
  const frozen = session.mode === 'ahead' && card.due > Date.now();
  for (const g of GRADES) {
    el[`iv${g.q}`].textContent = frozen && g.q !== 0 ? 'No change' : formatInterval(iv[g.q]);
  }
}

function renderBack(card) {
  el.tgtLang.textContent = langName(card.tgt);
  if (card.translation) {
    el.back.textContent = card.translation;
    el.back.lang = card.tgt;
    el.back.dir = dirFor(card.tgt);
    el.back.classList.remove('review-card__back--empty');
  } else {
    el.back.textContent = 'Not translated yet';
    el.back.removeAttribute('lang');
    el.back.removeAttribute('dir');
    el.back.classList.add('review-card__back--empty');
  }
  el.translate.hidden = !!card.translation;
  // The button is shared by every card: only busy for the card being translated.
  setBusy(el.translate, translating === card.id, { label: 'Translating…' });
  el.listenBack.hidden = !card.translation || !speechOk();
  el.editLabel.textContent = card.translation ? 'Edit' : 'Add translation';
}

function renderCard({ focus = true, announceIt = true, prefix = '' } = {}) {
  const card = currentCard();
  if (!card) return;
  revealed = false;
  closeEdit({ focus: false });
  el.front.textContent = card.text;
  el.front.lang = card.src;
  el.front.dir = dirFor(card.src);
  el.front.dataset.size = frontSize(card.text);
  el.srcLang.textContent = langName(card.src);
  render(el.chips, card.seen ? '' : badge('New card', 'info'));
  el.listen.hidden = !speechOk();
  renderBack(card);
  renderIntervals(card);
  renderProgress();
  el.answer.hidden = true;
  el.grades.hidden = true;
  el.reveal.hidden = false;
  if (focus) el.reveal.focus();
  if (announceIt) announce([`${prefix}${el.pos.textContent}:`, { text: card.text, lang: card.src }]);
}

function renderDone() {
  render(el.done, doneMarkup());
  setPhase('done');
  syncShortcutHints();
}

// Single-key shortcuts can be turned off in Settings (WCAG 2.1.4): hide the hints too.
function syncShortcutHints() {
  if (!section) return;
  const on = shortcutsEnabled();
  el.root.toggleAttribute('data-no-shortcuts', !on);
  for (const b of $$('[data-shortcut]', section)) {
    if (on) b.setAttribute('aria-keyshortcuts', b.dataset.shortcut);
    else b.removeAttribute('aria-keyshortcuts');
  }
}

// ---- Session flow ---------------------------------------------------------------------

function startSession(mode = 'due', ids = null) {
  const now = Date.now();
  let list;
  if (ids) list = ids.map((id) => srs.getCard(id)).filter(Boolean);
  else if (mode === 'ahead') list = studyAheadCards(srs.cards(), now);
  else list = srs.dueCards({ now });
  if (!list.length) {
    renderStart();
    focusHeading(section);
    return;
  }
  session = {
    mode,
    queue: list.map((c) => c.id),
    ids: list.map((c) => c.id),
    done: 0,
    counts: [0, 0, 0, 0],
    reviewed: new Set(),
    moved: new Set(), // cards whose due date changed (study ahead: Again, or already due)
    startedAt: now,
  };
  setPhase('session');
  armGuard();
  renderCard();
}

function reveal() {
  if (phase !== 'session' || revealed || guarded()) return;
  const card = currentCard();
  if (!card) return;
  revealed = true;
  armGuard();
  el.answer.hidden = false;
  el.reveal.hidden = true;
  el.grades.hidden = false;
  $('[data-q="2"]', el.grades).focus();
  announce(card.translation ? ['Answer:', { text: card.translation, lang: card.tgt }] : 'Answer: no translation yet');
}

function grade(q) {
  if (phase !== 'session' || !revealed || guarded()) return;
  const id = session.queue[0];
  const before = srs.getCard(id);
  const updated = srs.grade(id, q, { ahead: session.mode === 'ahead' });
  session.queue.shift();
  if (updated) {
    session.done++;
    session.counts[q]++;
    session.reviewed.add(id);
    if (before && updated.due !== before.due) session.moved.add(id);
    if (q === 0) session.queue = requeue(session.queue, id);
    cardsChanged();
  }
  armGuard();
  if (!dropMissing()) {
    finish();
    return;
  }
  renderCard({ prefix: q === 0 && updated ? 'You’ll see that card again soon. ' : '' });
}

// Cards deleted elsewhere (Deck, another tab) leave the queue quietly.
function dropMissing() {
  if (!session) return false;
  session.queue = session.queue.filter((id) => srs.getCard(id));
  return session.queue.length > 0;
}

function finish() {
  if (!session || !session.done) {
    session = null;
    renderStart();
    focusHeading(section);
    return;
  }
  renderDone();
  const title = $('[data-r="done-title"]', el.done);
  if (title) title.focus();
  announce(`Session complete. ${$('.review-done__summary', el.done).textContent}`);
}

function listen(back = false) {
  const card = currentCard();
  if (!card) return false;
  const ok = back ? tts.speak(card.translation, card.tgt) : tts.speak(card.text, card.src);
  if (!ok) toast('Speech isn’t available in this browser.', { kind: 'warning' });
  return true;
}

// ---- Editing the translation ------------------------------------------------------------

function openEdit() {
  const card = currentCard();
  if (!card || editing) return;
  editing = true;
  el.input.value = card.translation;
  el.input.lang = card.tgt;
  el.input.dir = dirFor(card.tgt);
  el.edit.hidden = false;
  el.back.hidden = true;
  el.backTools.hidden = true;
  el.editBtn.setAttribute('aria-expanded', 'true');
  el.input.focus();
  el.input.select();
}

function closeEdit({ focus = true } = {}) {
  if (!editing) return;
  editing = false;
  el.edit.hidden = true;
  el.back.hidden = false;
  el.backTools.hidden = false;
  el.editBtn.setAttribute('aria-expanded', 'false');
  if (focus) el.editBtn.focus();
}

function saveEdit() {
  const card = currentCard();
  if (!card) return;
  const updated = srs.updateCard(card.id, { translation: el.input.value });
  if (!updated) {
    toast('Couldn’t save the translation.', { kind: 'error' });
    el.input.focus();
    return;
  }
  renderBack(updated);
  closeEdit();
  announce(updated.translation ? 'Translation saved.' : 'Translation removed.');
}

async function translateCard() {
  const card = currentCard();
  if (!card || translating === card.id) return;
  translating = card.id;
  setBusy(el.translate, true, { label: 'Translating…' });
  try {
    const text = await translate(card.text, card.src, card.tgt);
    const updated = srs.updateCard(card.id, { translation: text });
    if (updated && phase === 'session' && currentCard()?.id === updated.id) {
      // The Translate button hides: follow with focus unless the learner moved on.
      const a = document.activeElement;
      const follow = visible && (a === el.translate || !a || a === document.body);
      if (translating === card.id) translating = null;
      renderBack(updated);
      if (follow) el.editBtn.focus();
      announce(['Translation:', { text: updated.translation, lang: updated.tgt || card.tgt }]);
    }
  } catch (err) {
    toast((err && err.name === 'TranslateError' && err.message) || 'Couldn’t translate this card. Check your connection and try again.', { kind: 'error' });
  } finally {
    if (translating === card.id) translating = null;
    const shown = currentCard();
    if (shown) setBusy(el.translate, translating === shown.id, { label: 'Translating…' });
  }
}

// ---- Events ---------------------------------------------------------------------------------

function onClick(e) {
  const t = e.target instanceof Element ? e.target.closest('[data-action]') : null;
  if (!t || !section.contains(t)) return;
  switch (t.dataset.action) {
    case 'start': startSession('due'); break;
    case 'ahead': startSession('ahead'); break;
    case 'again': startSession('ahead', session ? session.ids : null); break;
    case 'reveal': reveal(); break;
    case 'grade': grade(Number(t.dataset.q)); break;
    case 'listen': listen(false); break;
    case 'listen-back': listen(true); break;
    case 'edit': if (editing) closeEdit(); else openEdit(); break;
    case 'edit-cancel': closeEdit(); break;
    case 'translate': translateCard(); break;
    case 'end': finish(); break;
    default: return;
  }
}

function registerShortcuts() {
  const revealKey = () => {
    if (phase === 'session' && !revealed) { reveal(); return true; }
    if (phase === 'start' && $('[data-action="start"]', el.start)) { startSession('due'); return true; }
    return false;
  };
  registerShortcut({ key: 'Space', label: 'Show answer', scope: 'review', handler: revealKey });
  registerShortcut({ key: 'Enter', label: 'Show answer', scope: 'review', handler: revealKey, hidden: true });
  for (const g of GRADES) {
    registerShortcut({
      key: g.key,
      label: `Answer ${g.label}`,
      scope: 'review',
      handler: () => {
        if (phase !== 'session' || !revealed || editing) return false;
        grade(g.q);
        return true;
      },
    });
  }
  registerShortcut({
    key: 's',
    label: 'Listen to the card',
    scope: 'review',
    handler: () => (phase === 'session' && speechOk() ? listen(false) : false),
  });
}

function trackKeys() {
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') held.add(e.key); }, true);
  document.addEventListener('keyup', (e) => {
    // Buttons act on Space when it is RELEASED. A Space that just revealed the
    // answer (or started the session) and is still held would otherwise press
    // the newly focused button on release (Chromium after auto-repeat, Firefox
    // always), by which time `held` no longer guards it.
    if (e.key === ' ' && guard.has(' ') && section && section.contains(e.target)) e.preventDefault();
    held.delete(e.key);
    if (!held.size) guard.clear();
  }, true);
  window.addEventListener('blur', () => { held.clear(); guard.clear(); });
}

// ---- View contract ----------------------------------------------------------------------------

export default {
  id: 'review',
  title: 'Review',
  icon: 'graduation-cap',
  mount(sectionEl) {
    section = sectionEl;
    render(section, pageMarkup());
    const r = (name) => $(`[data-r="${name}"]`, section);
    el = {
      root: $('[data-review]', section),
      start: r('start'),
      session: r('session'),
      done: r('done'),
      pos: r('pos'),
      mode: r('mode'),
      bar: r('bar'),
      fill: r('fill'),
      srcLang: r('src-lang'),
      tgtLang: r('tgt-lang'),
      chips: r('chips'),
      front: r('front'),
      listen: r('listen'),
      answer: r('answer'),
      back: r('back'),
      backTools: r('back-tools'),
      listenBack: r('listen-back'),
      editBtn: r('edit-btn'),
      editLabel: $('[data-r="edit-btn"] .btn__label', section),
      translate: r('translate'),
      edit: r('edit'),
      input: $('#review-edit-input', section),
      reveal: r('reveal'),
      grades: r('grades'),
    };
    for (const g of GRADES) el[`iv${g.q}`] = r(`iv${g.q}`);

    section.addEventListener('click', onClick);
    el.edit.addEventListener('submit', (e) => {
      e.preventDefault();
      saveEdit();
    });
    el.edit.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeEdit();
      }
    });
    trackKeys();
    registerShortcuts();
    store.subscribe((key) => { if (key === 'shortcuts') syncShortcutHints(); });
    // Another tab reviewed or added cards: keep the start screen current.
    onChange(({ collections, remote }) => {
      if (remote && visible && phase === 'start' && collections.includes('cards')) renderStart();
    });
    // show() (which the router calls right after mount) renders the content.
    setPhase(session ? 'session' : 'start');
    syncShortcutHints();
  },
  show() {
    visible = true;
    if (phase === 'session') {
      // Resume where the learner left off; the card may have changed meanwhile.
      if (!dropMissing()) {
        finish();
        return;
      }
      setPhase('session');
      const wasRevealed = revealed;
      renderCard({ focus: false, announceIt: false });
      if (wasRevealed) {
        revealed = true;
        el.answer.hidden = false;
        el.reveal.hidden = true;
        el.grades.hidden = false;
      }
      return;
    }
    // Coming back after a finished session starts fresh.
    renderStart();
  },
  hide() {
    visible = false;
    clearTimeout(wakeTimer);
    closeEdit({ focus: false });
  },
};

// Test hook: reset module state between tests.
export function _resetForTests() {
  session = null;
  revealed = false;
  editing = false;
  translating = null;
  phase = 'start';
  held.clear();
  guard.clear();
}
