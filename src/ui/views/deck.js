// Deck: stats, the 7-day review chart and the searchable, paged card list.
// Rows offer Listen (the front, in its own language), inline editing of the
// translation, and Delete with Undo. Nothing here reschedules a card.
import '../../styles/views/deck.css';
import { html, render, $ } from '../dom.js';
import { announce, focusHeading } from '../a11y.js';
import { toast } from '../toast.js';
import { confirmDialog } from '../dialog.js';
import { emptyState, badge, button } from '../components.js';
import { formatCount } from '../format.js';
import * as srs from '../../core/srs.js';
import * as tts from '../../core/tts.js';
import { translate } from '../../core/translate.js';
import { langName } from '../../core/language.js';
import { store } from '../../core/store.js';
import { onChange } from '../../core/db.js';
import { downloadBlob } from '../../core/utils.js';
import {
  statsStrip, listToolbar, listBody, listRow, termLines, editForm, rowAction,
  editIcon, quoteTerm, untilText, createListController, undoToast, undoShortcut,
} from './listview.js';

const DAY = 86_400_000;
const MATURE_MS = 21 * DAY; // same threshold as srs.matureCount()

export const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'due', label: 'To review' },
  { value: 'new', label: 'New' },
  { value: 'learning', label: 'Learning' },
  { value: 'mature', label: 'Mature' },
];

// ---- Pure helpers (exported for tests) ----------------------------------------

export const isNewCard = (c) => !c.seen;
export const isMature = (c) => !isNewCard(c) && c.interval >= MATURE_MS;

/** 'new' | 'learning' | 'mature' */
export function stageOf(c) {
  if (isNewCard(c)) return 'new';
  return isMature(c) ? 'mature' : 'learning';
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Filter + search over cards (accent- and case-insensitive, front and back). */
export function filterCards(list, { q = '', filter = 'all', dueIds = null, now = Date.now() } = {}) {
  const needle = fold(q.trim());
  const due = dueIds || new Set();
  const out = list.filter((c) => {
    if (filter === 'due' && !due.has(c.id)) return false;
    if (filter === 'new' && !isNewCard(c)) return false;
    if (filter === 'learning' && stageOf(c) !== 'learning') return false;
    if (filter === 'mature' && !isMature(c)) return false;
    return !needle || fold(`${c.text}\n${c.translation}`).includes(needle);
  });
  // Due cards: the ones waiting longest first; everything else newest first.
  if (filter === 'due') out.sort((a, b) => (isNewCard(a) - isNewCard(b)) || a.due - b.due);
  return out;
}

/** "Next review in 3 days", "Next review tomorrow", "Due now". */
export function dueLabel(c, now = Date.now()) {
  if (isNewCard(c)) return null;
  if (c.due <= now) return 'Due now';
  return `Next review ${untilText(c.due, now)}`;
}

export function exportFileName(ext, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `spritespeak-deck-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${ext}`;
}

// ---- View state -----------------------------------------------------------------

let section = null;
let el = {};
let list = null;
let bodyState = null; // 'empty' | 'list'
let dueIds = new Set();
let pairCount = 1;
let visible = false;

const speechOk = () => {
  try { return tts.supported(); } catch { return false; }
};

function cardsChanged() {
  window.dispatchEvent(new Event('spritespeak:cards-changed'));
}

// ---- Markup -----------------------------------------------------------------------

function pageMarkup() {
  return html`<div class="page deck">
    <div class="page-header">
      <div class="page-header__text">
        <h1 tabindex="-1">Deck</h1>
        <p class="page-header__subtitle">Your flashcards and how you’re doing.</p>
      </div>
      <div class="page-header__actions" data-deck-actions></div>
    </div>
    <div data-deck-body></div>
  </div>`;
}

function populatedMarkup() {
  return html`<div class="deck__overview">
      <section class="deck__stats" aria-labelledby="deck-stats-title">
        <h2 class="visually-hidden" id="deck-stats-title">Overview</h2>
        <div data-deck-stats></div>
      </section>
      <section class="card card--compact deck-week" aria-labelledby="deck-week-title" data-deck-week></section>
    </div>
    <section class="deck__cards lv" aria-labelledby="deck-cards-title" data-deck-list>
      <h2 class="lv__title" id="deck-cards-title">Cards</h2>
      ${listToolbar({
        id: 'deck',
        searchLabel: 'Search cards',
        placeholder: 'Search cards',
        filterLabel: 'Show',
        filters: FILTERS,
        filter: 'all',
        menuLabel: 'Deck actions',
        menuItems: [
          { action: 'export-csv', label: 'Export as CSV', icon: 'download' },
          { action: 'export-tsv', label: 'Export for Anki (TSV)', icon: 'download' },
          'separator',
          { action: 'clear', label: 'Delete all cards…', icon: 'trash-2', danger: true },
        ],
      })}
      <div class="card card--flush lv__panel">${listBody({ id: 'deck', label: 'Cards' })}</div>
    </section>`;
}

function emptyMarkup() {
  return html`<div class="card">${emptyState({
    icon: 'layers',
    title: 'No cards yet',
    body: store.get('autoAdd') === 'off'
      ? 'Add sentences while you play, or add words from your Dictionary.'
      : 'Sentences you meet while playing are added automatically. You can also add any word from your Dictionary.',
    action: [
      { label: 'Go to Play', href: '#/play', icon: 'gamepad', kind: 'primary' },
      { label: 'Open Dictionary', href: '#/dictionary', icon: 'book-open', kind: 'secondary' },
    ],
  })}</div>`;
}

function statsMarkup() {
  const days = srs.streak();
  return statsStrip({
    label: 'Deck overview',
    tiles: [
      { label: 'To review', value: dueIds.size.toLocaleString('en'), tone: dueIds.size ? 'accent' : null, icon: 'clock' },
      { label: 'Cards', value: srs.totalCards().toLocaleString('en'), icon: 'layers' },
      { label: 'Mature', value: srs.matureCount().toLocaleString('en'), icon: 'star' },
      { label: 'Day streak', value: days.toLocaleString('en'), icon: 'flame', tone: days ? 'warning' : null },
    ],
  });
}

function weekMarkup() {
  const week = srs.weekStats();
  const totalWeek = week.reduce((n, d) => n + d.count, 0);
  const best = week.reduce((b, d) => (d.count > (b ? b.count : 0) ? d : b), null);
  const summary = totalWeek
    ? `${formatCount(totalWeek, 'review')} this week${best ? ` · most on ${best.today ? 'today' : best.label}` : ''}`
    : 'No reviews this week yet';
  return html`<div class="deck-week__head">
      <h2 class="card__title" id="deck-week-title">Last 7 days</h2>
      <p class="deck-week__summary">${summary}</p>
    </div>
    <div class="week-chart" aria-hidden="true">
      ${week.map((d) => html`<div class="${d.today ? 'week-chart__col week-chart__col--today' : 'week-chart__col'}">
        <span class="week-chart__value">${d.count ? d.count.toLocaleString('en') : ''}</span>
        <span class="week-chart__track"><span class="week-chart__bar" data-count="${d.count}"></span></span>
        <span class="week-chart__day">${d.today ? 'Today' : d.label}</span>
      </div>`)}
    </div>
    <div class="visually-hidden"><table>
      <caption>Cards reviewed per day, last 7 days</caption>
      <thead><tr><th scope="col">Day</th><th scope="col">Reviews</th></tr></thead>
      <tbody>${week.map((d) => html`<tr><th scope="row">${d.today ? `Today, ${d.long}` : d.long}</th><td>${d.count}</td></tr>`)}</tbody>
    </table></div>`;
}

// Bar heights are set from script (no inline style attributes, CSP friendly).
function sizeBars(root) {
  const bars = Array.from(root.querySelectorAll('.week-chart__bar'));
  const max = Math.max(1, ...bars.map((b) => Number(b.dataset.count) || 0));
  for (const b of bars) {
    const n = Number(b.dataset.count) || 0;
    b.style.height = n ? `${Math.max(6, Math.round((n / max) * 100))}%` : '0';
    b.hidden = n === 0;
  }
}

function rowMarkup(c, { editing } = {}) {
  const now = Date.now();
  const stage = stageOf(c);
  const due = dueLabel(c, now);
  const name = quoteTerm(c.text);
  const meta = [
    stage === 'new' ? badge('New', 'info') : stage === 'mature' ? badge('Mature', 'success') : badge('Learning'),
    due === 'Due now' ? badge('Due now', 'accent', { icon: 'clock' }) : '',
    due && due !== 'Due now' ? html`<span class="lv-meta">${due}</span>` : '',
    pairCount > 1 ? html`<span class="lv-meta">${langName(c.src)} → ${langName(c.tgt)}</span>` : '',
  ];
  const actions = [
    speechOk() ? rowAction({ action: 'listen', label: `Listen to ${name}`, icon: 'volume-2' }) : '',
    rowAction({ action: 'edit', label: `Edit translation of ${name}`, iconMarkup: editIcon(18), attrs: { 'aria-expanded': editing ? 'true' : 'false' } }),
    rowAction({ action: 'delete', label: `Delete ${name}`, icon: 'trash-2', danger: true }),
  ];
  const body = termLines({
    text: c.text, src: c.src, translation: c.translation, tgt: c.tgt,
    editor: editing ? editForm({ key: c.id, term: c.text, value: c.translation, tgt: c.tgt }) : null,
  });
  return listRow({ key: c.id, body, meta, actions, className: editing ? 'lv-row--editing' : '' });
}

// ---- Rendering ------------------------------------------------------------------------

function refreshDerived() {
  dueIds = new Set(srs.dueCards().map((c) => c.id));
  pairCount = new Set(srs.cards().map((c) => `${c.src}>${c.tgt}`)).size;
}

function renderHeaderActions() {
  const n = dueIds.size;
  render(el.actions, n
    ? button({ label: `Review ${formatCount(n, 'card')}`, href: '#/review', kind: 'primary', icon: 'graduation-cap' })
    : '');
}

function renderOverview() {
  render($('[data-deck-stats]', el.body), statsMarkup());
  const week = $('[data-deck-week]', el.body);
  render(week, weekMarkup());
  sizeBars(week);
}

function buildList() {
  if (list) list.destroy();
  list = createListController($('[data-deck-list]', el.body), {
    noun: ['card', 'cards'],
    params: { filter: 'all' },
    overall: () => srs.totalCards(),
    query: ({ q, filter, limit }) => {
      const all = filterCards(srs.cards(), { q, filter, dueIds });
      return { items: all.slice(0, limit), total: all.length };
    },
    keyOf: (c) => c.id,
    renderRow: rowMarkup,
    noMatch: ({ q }) => (q.trim() ? `No cards match ${quoteTerm(q, 60)}.` : 'No cards in this group yet.'),
    onAction,
    onMenu,
    onSave: saveTranslation,
    onRetranslate: (key) => {
      const c = srs.getCard(key);
      return c ? translate(c.text, c.src, c.tgt, { refresh: true }).catch((err) => { toast(errorText(err), { kind: 'error' }); return null; }) : null;
    },
  });
}

function renderBody({ force = false } = {}) {
  refreshDerived();
  renderHeaderActions();
  const next = srs.totalCards() ? 'list' : 'empty';
  if (next !== bodyState || force) {
    const hadFocus = el.body.contains(document.activeElement);
    bodyState = next;
    if (next === 'empty') {
      if (list) { list.destroy(); list = null; }
      render(el.body, emptyMarkup());
    } else {
      render(el.body, populatedMarkup());
      buildList();
    }
    if (hadFocus) focusHeading(section);
  }
  if (bodyState === 'list') {
    renderOverview();
    list.refresh();
  }
}

// ---- Actions --------------------------------------------------------------------------

function errorText(err) {
  return (err && err.name === 'TranslateError' && err.message) || 'Couldn’t translate this card. Check your connection and try again.';
}

function saveTranslation(key, value) {
  const updated = srs.updateCard(key, { translation: value });
  if (!updated) {
    toast('Couldn’t save the translation.', { kind: 'error' });
    return false;
  }
  announce(updated.translation ? 'Translation saved.' : 'Translation removed.');
  return updated;
}

function deleteCard(key) {
  const card = srs.getCard(key);
  if (!card) return;
  const removed = srs.removeCard(key);
  if (!removed) return;
  cardsChanged();
  if (!srs.totalCards()) {
    renderBody();
    focusHeading(section);
  } else {
    refreshDerived();
    renderHeaderActions();
    renderOverview();
    list.removed(key);
  }
  undoToast(`Deleted ${quoteTerm(card.text)}.`, () => {
    const restored = srs.restoreCard(removed);
    if (!restored) {
      toast('Couldn’t restore the card — it’s already in your deck.', { kind: 'warning' });
      return;
    }
    cardsChanged();
    renderBody();
    announce(`Restored ${quoteTerm(restored.text)}.`);
    // Undo can be pressed after leaving the Deck: only move focus while it's on screen.
    if (visible && !(list && list.focusRow(restored.id))) focusHeading(section);
  }, { scope: 'deck' });
}

function onAction(action, { key, item }) {
  if (action === 'listen') {
    if (!tts.speak(item.text, item.src)) toast('Speech isn’t available in this browser.', { kind: 'warning' });
  } else if (action === 'delete') {
    deleteCard(key);
  }
}

async function onMenu(action) {
  if (action === 'export-csv' || action === 'export-tsv') {
    const csv = action === 'export-csv';
    const text = csv ? srs.exportCsv() : srs.exportTsv();
    const type = csv ? 'text/csv;charset=utf-8' : 'text/tab-separated-values;charset=utf-8';
    downloadBlob(new Blob([text], { type }), exportFileName(csv ? 'csv' : 'txt'));
    toast(`Exported ${formatCount(srs.totalCards(), 'card')}.`, { kind: 'success' });
  } else if (action === 'clear') {
    const n = srs.totalCards();
    const ok = await confirmDialog({
      title: 'Delete all cards?',
      body: `This deletes ${formatCount(n, 'card')} and their review history. Your Dictionary isn’t affected. This can’t be undone.`,
      confirmLabel: 'Delete all cards',
      danger: true,
    });
    if (!ok) return;
    srs.clearAll();
    cardsChanged();
    renderBody();
    focusHeading(section);
    toast(`Deleted ${formatCount(n, 'card')}.`, { kind: 'success' });
  }
}

// ---- View contract ----------------------------------------------------------------------

export default {
  id: 'deck',
  title: 'Deck',
  icon: 'layers',
  mount(sectionEl) {
    section = sectionEl;
    render(section, pageMarkup());
    el = { actions: $('[data-deck-actions]', section), body: $('[data-deck-body]', section) };
    bodyState = null;
    undoShortcut('deck');
    // Another tab changed the deck: refresh while we're on screen.
    onChange(({ collections, remote }) => {
      if (visible && remote && (collections.includes('cards') || collections.includes('activity'))) renderBody();
    });
    renderBody();
  },
  show(params = {}) {
    visible = true;
    renderBody();
    // Deep links such as #/deck?q=Hallo or #/deck?filter=due
    if (list && params) list.applyParams(params);
  },
  hide() {
    visible = false;
    if (list && list.editingKey) list.cancelEdit({ focus: false });
  },
};
