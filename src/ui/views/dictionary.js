// Dictionary: every word and line met in games, with its translation in the
// current target language. Pending rows have a visible Translate button, and
// "Translate new words" works through them in a batch with progress, a Stop
// button and a summary that reports failures honestly.
import '../../styles/views/dictionary.css';
import { html, render, $ } from '../dom.js';
import { announce, focusHeading } from '../a11y.js';
import { toast } from '../toast.js';
import { confirmDialog } from '../dialog.js';
import { emptyState, badge, button, setBusy } from '../components.js';
import { formatCount, formatRelative } from '../format.js';
import * as dict from '../../core/dictionary.js';
import * as srs from '../../core/srs.js';
import * as tts from '../../core/tts.js';
import { translate } from '../../core/translate.js';
import { langName } from '../../core/language.js';
import { store } from '../../core/store.js';
import { onChange } from '../../core/db.js';
import { downloadBlob } from '../../core/utils.js';
import {
  statsStrip, listToolbar, listBody, listRow, termLines, editForm, rowAction, rowTextAction,
  editIcon, quoteTerm, createListController, undoToast, undoShortcut,
} from './listview.js';

export const BATCH_MAX = 50;
const BATCH_GAP_MS = 150; // be gentle with the free translation endpoints
const ENTRY = ['entry', 'entries'];

export const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'word', label: 'Words' },
  { value: 'line', label: 'Sentences' },
  { value: 'pending', label: 'Not translated' },
];

const SORTS = [
  { value: 'recent', label: 'Recently seen' },
  { value: 'count', label: 'Most seen' },
  { value: 'alpha', label: 'A–Z' },
];

// ---- Pure helpers (exported for tests) ----------------------------------------

/** Segmented filter value → dictionary.search() options. */
export function searchOptions(filter) {
  return {
    kind: filter === 'word' || filter === 'line' ? filter : 'all',
    filter: filter === 'pending' ? 'pending' : 'all',
  };
}

const isoDay = (ts) => {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** CSV of every entry (translation in `tgt`), formula-safe via srs.csvCell. */
export function entriesCsv(list, tgt) {
  const header = ['Text', 'Type', 'Translation', 'Game language', 'Translation language', 'Times seen', 'First seen', 'Last seen'];
  const rows = list.map((e) => [
    e.text, e.kind === 'word' ? 'word' : 'sentence', e.translations?.[tgt] || e.translation || '', e.src, tgt,
    e.count, isoDay(e.firstSeen), isoDay(e.lastSeen),
  ]);
  return '\uFEFF' + [header, ...rows].map((r) => r.map(srs.csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Anki-friendly "front<TAB>back" lines for translated entries only. */
export function entriesTsv(list, tgt) {
  const field = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return list
    .map((e) => [e.text, e.translations?.[tgt] || e.translation || ''])
    .filter(([, back]) => back)
    .map(([front, back]) => `${field(front)}\t${field(back)}`)
    .join('\n') + '\n';
}

export function exportFileName(ext, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `emulingo-dictionary-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${ext}`;
}

/** The summary shown after a batch: { message, kind }. */
export function batchSummary({ done, failed, total, stopped = false, error = null }) {
  const translated = `Translated ${done === total ? formatCount(done, ENTRY) : `${done.toLocaleString('en')} of ${formatCount(total, ENTRY)}`}.`;
  if (error) {
    const msg = error.message || 'Translation stopped.';
    return { message: done ? `${msg} ${translated}` : msg, kind: done ? 'warning' : 'error' };
  }
  if (stopped) return { message: `Stopped. ${translated}`, kind: 'info' };
  if (failed) {
    const rest = `${formatCount(failed, ENTRY)} couldn’t be translated — try again later.`;
    return { message: done ? `${translated} ${rest}` : `Couldn’t translate ${failed === 1 ? 'this entry' : 'these entries'}. Check your connection and try again.`, kind: done ? 'warning' : 'error' };
  }
  return { message: translated, kind: 'success' };
}

// ---- View state -------------------------------------------------------------------

let section = null;
let el = {};
let list = null;
let bodyState = null;
let visible = false;
let batch = null; // { stop, done, failed, total }

const target = () => store.get('target') || 'en';
const speechOk = () => {
  try { return tts.supported(); } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cardsChanged() {
  window.dispatchEvent(new Event('emulingo:cards-changed'));
}

function errorText(err) {
  return (err && err.name === 'TranslateError' && err.message) || 'Couldn’t translate this. Check your connection and try again.';
}

// ---- Markup -------------------------------------------------------------------------

function pageMarkup() {
  return html`<div class="page dictionary">
    <div class="page-header">
      <div class="page-header__text">
        <h1 tabindex="-1">Dictionary</h1>
        <p class="page-header__subtitle" data-dict-subtitle></p>
      </div>
      <div class="page-header__actions" data-dict-actions></div>
    </div>
    <div data-dict-body></div>
  </div>`;
}

function populatedMarkup() {
  return html`<section class="dictionary__stats" aria-labelledby="dict-stats-title">
      <h2 class="visually-hidden" id="dict-stats-title">Overview</h2>
      <div data-dict-stats></div>
    </section>
    <section class="dictionary__list lv" aria-labelledby="dict-list-title" data-dict-list>
      <h2 class="lv__title" id="dict-list-title">Words and sentences</h2>
      ${listToolbar({
        id: 'dict',
        searchLabel: 'Search the dictionary',
        placeholder: 'Search words and translations',
        filterLabel: 'Show',
        filters: FILTERS,
        filter: 'all',
        extra: html`<div class="lv-sort">
          <label class="lv-sort__label" for="dict-sort">Sort</label>
          <select class="select lv-sort__select" id="dict-sort" data-dict-sort>
            ${SORTS.map((s) => html`<option ${{ value: s.value, selected: s.value === 'recent' }}>${s.label}</option>`)}
          </select>
        </div>`,
        menuLabel: 'Dictionary actions',
        menuItems: [
          { action: 'export-csv', label: 'Export as CSV', icon: 'download' },
          { action: 'export-tsv', label: 'Export for Anki (TSV)', icon: 'download' },
          'separator',
          { action: 'clear', label: 'Delete all entries…', icon: 'trash-2', danger: true },
        ],
      })}
      <div class="card card--flush lv__panel">${listBody({ id: 'dict', label: 'Dictionary entries' })}</div>
    </section>`;
}

function emptyMarkup() {
  return html`<div class="card">${emptyState({
    icon: 'book-open',
    title: 'Your dictionary is empty',
    body: 'Words and sentences from the games you play are collected here automatically, with their translations.',
    action: { label: 'Go to Play', href: '#/play', icon: 'gamepad' },
  })}</div>`;
}

function statsMarkup(s) {
  return statsStrip({
    label: 'Dictionary overview',
    tiles: [
      { label: 'Words', value: s.words.toLocaleString('en'), icon: 'type' },
      { label: 'Sentences', value: s.lines.toLocaleString('en'), icon: 'message-square' },
      { label: 'Not translated yet', value: s.pending.toLocaleString('en'), icon: 'languages', tone: s.pending ? 'warning' : null },
    ],
  });
}

function rowMarkup(e, { editing } = {}) {
  const name = quoteTerm(e.text);
  const inDeck = !!srs.findCard(e.text, e.src, e.tgt);
  const meta = [
    e.kind === 'word' ? badge('Word', 'info') : badge('Sentence'),
    inDeck ? badge('In deck', 'success', { icon: 'check' }) : '',
    html`<span class="lv-meta">Seen ${e.count.toLocaleString('en')}×</span>`,
    html`<span class="lv-meta">${formatRelative(e.lastSeen)}</span>`,
  ];
  const actions = [
    speechOk() ? rowAction({ action: 'listen', label: `Listen to ${name}`, icon: 'volume-2' }) : '',
    e.pending
      ? rowTextAction({ action: 'translate', label: 'Translate', name: `Translate ${name}`, icon: 'languages' })
      : rowAction({ action: 'edit', label: `Edit translation of ${name}`, iconMarkup: editIcon(18), attrs: { 'aria-expanded': editing ? 'true' : 'false' } }),
    // an empty slot keeps the icons of every row in the same columns
    inDeck ? html`<span class="icon-btn lv-action--placeholder" aria-hidden="true"></span>` : rowAction({ action: 'add', label: `Add ${name} to deck`, icon: 'plus' }),
    rowAction({ action: 'delete', label: `Delete ${name}`, icon: 'trash-2', danger: true }),
  ];
  const body = termLines({
    text: e.text, src: e.src, translation: e.translation, tgt: e.tgt,
    editor: editing ? editForm({ key: e.id, term: e.text, value: e.translation, tgt: e.tgt }) : null,
  });
  return listRow({ key: e.id, body, meta, actions, className: [e.pending ? 'lv-row--pending' : '', editing ? 'lv-row--editing' : ''].filter(Boolean).join(' ') });
}

// ---- Rendering ----------------------------------------------------------------------

function renderSubtitle() {
  const t = langName(target());
  render(el.subtitle, `Every word and sentence you’ve met, translated into ${t}.`);
}

function renderHeaderActions(stats) {
  if (batch) return; // the running batch owns these controls
  if (!stats.pending || !stats.total) {
    render(el.actions, '');
    return;
  }
  // The description says how much one run covers.
  render(el.actions, html`
    ${button({ label: 'Translate new words', kind: 'primary', icon: 'languages', action: 'translate-all', attrs: { 'aria-describedby': 'dict-pending-note' } })}
    <span class="visually-hidden" id="dict-pending-note">${formatCount(stats.pending, ENTRY)} not translated yet${stats.pending > BATCH_MAX ? `, up to ${BATCH_MAX} per run` : ''}.</span>`);
}

function buildList() {
  if (list) list.destroy();
  const root = $('[data-dict-list]', el.body);
  list = createListController(root, {
    noun: ENTRY,
    params: { filter: 'all', sort: 'recent' },
    overall: () => dict.stats(target()).total,
    query: ({ q, filter, sort, limit }) => dict.search({ q, ...searchOptions(filter), sort, offset: 0, limit, tgt: target() }),
    keyOf: (e) => e.id,
    renderRow: rowMarkup,
    noMatch: ({ q, filter }) => {
      if (q.trim()) return `Nothing matches ${quoteTerm(q, 60)}.`;
      return filter === 'pending' ? 'Everything is translated.' : 'Nothing here yet.';
    },
    onAction,
    onMenu,
    onSave: (key, value) => {
      const updated = dict.setTranslation(key, target(), value);
      if (!updated) {
        toast('Couldn’t save the translation.', { kind: 'error' });
        return false;
      }
      announce(updated.translation ? 'Translation saved.' : 'Translation removed.');
      queueMicrotask(renderStats);
      return updated;
    },
    onRetranslate: (key) => {
      const e = dict.getEntry(key, target());
      return e ? translate(e.text, e.src, target(), { refresh: true }).catch((err) => { toast(errorText(err), { kind: 'error' }); return null; }) : null;
    },
  });
  const sort = $('[data-dict-sort]', root);
  sort.addEventListener('change', () => list.setParams({ sort: sort.value }));
}

function renderStats() {
  if (bodyState !== 'list') return;
  const s = dict.stats(target());
  render($('[data-dict-stats]', el.body), statsMarkup(s));
  renderHeaderActions(s);
}

function renderBody() {
  renderSubtitle();
  const s = dict.stats(target());
  const next = s.total ? 'list' : 'empty';
  if (next !== bodyState) {
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
    renderStats();
    list.refresh();
  } else {
    renderHeaderActions(s);
  }
}

// ---- Row actions ----------------------------------------------------------------------

// After an async row action the row is re-rendered: follow it with focus only
// if focus was still on the button (or got lost), never pull it from elsewhere.
const focusWasOn = (btn) => {
  const a = document.activeElement;
  return a === btn || !a || a === document.body;
};

async function translateRow(key, btn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  const tgt = target();
  setBusy(btn, true, { label: 'Translating…' });
  try {
    const updated = await dict.translateEntry(key, tgt);
    if (!list || tgt !== target()) return; // the list now shows another language
    const follow = visible && focusWasOn(btn);
    list.updateRow(key, updated);
    if (follow) list.focusRow(key, 'edit');
    announce([{ text: `${quoteTerm(updated.text)}:`, lang: updated.src }, { text: updated.translation, lang: tgt }]);
    renderStats();
  } catch (err) {
    if (btn.isConnected) setBusy(btn, false);
    toast(errorText(err), { kind: 'error' });
  }
}

async function addToDeck(key, btn) {
  const tgt = target();
  let e = dict.getEntry(key, tgt);
  if (!e || btn.getAttribute('aria-busy') === 'true') return;
  if (!e.translation) {
    setBusy(btn, true);
    try {
      e = await dict.translateEntry(key, tgt);
    } catch (err) {
      if (btn.isConnected) setBusy(btn, false);
      toast(`${errorText(err)} The card wasn’t added.`, { kind: 'error' });
      return;
    }
  }
  const res = srs.addCard({ text: e.text, translation: e.translation, src: e.src, tgt, origin: 'manual' });
  if (res.status === 'added') {
    cardsChanged();
    toast(`Added ${quoteTerm(e.text)} to your deck.`, { kind: 'success' });
  } else if (res.status === 'duplicate') {
    toast(`${quoteTerm(e.text)} is already in your deck.`);
  } else {
    if (btn.isConnected) setBusy(btn, false);
    toast('Couldn’t add this card.', { kind: 'error' });
    return;
  }
  if (!list || tgt !== target()) return;
  const follow = visible && focusWasOn(btn);
  list.updateRow(key, e);
  if (follow) list.focusRow(key, 'edit');
  renderStats();
}

function deleteEntry(key) {
  const e = dict.getEntry(key, target());
  const removed = dict.removeEntry(key);
  if (!e || !removed) return;
  if (!dict.stats(target()).total) {
    renderBody();
    focusHeading(section);
  } else {
    renderStats();
    list.removed(key);
  }
  undoToast(`Deleted ${quoteTerm(e.text)}.`, () => {
    const restored = dict.restoreEntry(removed);
    if (!restored) {
      toast('Couldn’t restore this entry.', { kind: 'warning' });
      return;
    }
    renderBody();
    announce(`Restored ${quoteTerm(restored.text)}.`);
    // Undo can be pressed after leaving the Dictionary: only move focus while it's on screen.
    if (visible && !(list && list.focusRow(restored.id))) focusHeading(section);
  }, { scope: 'dictionary' });
}

function onAction(action, { key, item, button: btn }) {
  if (action === 'listen') {
    if (!tts.speak(item.text, item.src)) toast('Speech isn’t available in this browser.', { kind: 'warning' });
  } else if (action === 'translate') translateRow(key, btn);
  else if (action === 'add') addToDeck(key, btn);
  else if (action === 'delete') deleteEntry(key);
}

async function onMenu(action) {
  const tgt = target();
  if (action === 'export-csv' || action === 'export-tsv') {
    const all = dict.entries({ tgt });
    const csv = action === 'export-csv';
    const text = csv ? entriesCsv(all, tgt) : entriesTsv(all, tgt);
    downloadBlob(new Blob([text], { type: csv ? 'text/csv;charset=utf-8' : 'text/tab-separated-values;charset=utf-8' }), exportFileName(csv ? 'csv' : 'txt'));
    const n = csv ? all.length : all.filter((e) => e.translation).length;
    toast(`Exported ${formatCount(n, ENTRY)}.`, { kind: 'success' });
  } else if (action === 'clear') {
    const n = dict.stats(tgt).total;
    const ok = await confirmDialog({
      title: 'Delete all entries?',
      body: `This deletes ${formatCount(n, ENTRY)} from your Dictionary. Your flashcards aren’t affected. This can’t be undone.`,
      confirmLabel: 'Delete all entries',
      danger: true,
    });
    if (!ok) return;
    if (batch) {
      batch.stop = true;
      batch.cleared = true; // no "Stopped…" summary after everything was deleted
    }
    dict.clearAll();
    renderBody();
    focusHeading(section);
    toast(`Deleted ${formatCount(n, ENTRY)}.`, { kind: 'success' });
  }
}

// ---- Batch translation ----------------------------------------------------------------

async function translateAll() {
  if (batch) return;
  const tgt = target();
  const { items } = dict.search({ filter: 'pending', sort: 'recent', limit: BATCH_MAX, tgt });
  if (!items.length) return;
  const run = { stop: false, cleared: false, done: 0, failed: 0, total: items.length, error: null };
  batch = run;
  render(el.actions, html`
    ${button({ label: `Translating 1 of ${run.total}…`, kind: 'primary', icon: 'languages', action: 'translate-all' })}
    ${button({ label: 'Stop', kind: 'ghost', icon: 'stop', action: 'translate-stop' })}`);
  const btn = $('[data-action="translate-all"]', el.actions);
  setBusy(btn, true);
  btn.focus();
  announce(`Translating ${formatCount(run.total, ENTRY)}…`);

  for (let i = 0; i < items.length; i++) {
    if (run.stop) break;
    // Deleted meanwhile (row delete, another tab): not a failure, just one less to do.
    if (!dict.getEntry(items[i].id, tgt)) {
      run.total--;
      continue;
    }
    setBusy(btn, true, { label: `Translating ${run.done + run.failed + 1} of ${run.total}…` });
    try {
      const updated = await dict.translateEntry(items[i].id, tgt);
      run.done++;
      if (list && list.editingKey !== updated.id && tgt === target()) list.updateRow(updated.id, updated);
    } catch (err) {
      if (!dict.getEntry(items[i].id, tgt)) {
        run.total--;
        continue;
      }
      run.failed++;
      // Offline or throttled: every remaining request would fail the same way.
      if (err && (err.code === 'offline' || err.code === 'rate-limited')) {
        run.error = err;
        break;
      }
    }
    if (i < items.length - 1 && !run.stop) await sleep(BATCH_GAP_MS);
  }

  const hadFocus = el.actions.contains(document.activeElement);
  batch = null;
  const summary = batchSummary({ ...run, stopped: run.stop });
  if (section && el.body.isConnected) {
    renderStats();
    if (list) list.refresh();
    if (!$('[data-dict-stats]', el.body)) renderHeaderActions(dict.stats(tgt));
  }
  // The batch buttons are gone: keep keyboard focus nearby.
  if (hadFocus && visible) {
    const again = $('[data-action="translate-all"]', el.actions);
    if (again) again.focus();
    else if (list && list.keys.length) list.focusRow(list.keys[0]);
    else focusHeading(section);
  }
  if (!run.cleared && run.total > 0) toast(summary.message, { kind: summary.kind });
}

function onHeaderClick(e) {
  const t = e.target instanceof Element ? e.target.closest('[data-action]') : null;
  if (!t) return;
  if (t.dataset.action === 'translate-all') translateAll();
  else if (t.dataset.action === 'translate-stop' && batch) {
    batch.stop = true;
    t.setAttribute('aria-disabled', 'true');
  }
}

// ---- View contract ------------------------------------------------------------------------

export default {
  id: 'dictionary',
  title: 'Dictionary',
  icon: 'book-open',
  mount(sectionEl) {
    section = sectionEl;
    render(section, pageMarkup());
    el = {
      subtitle: $('[data-dict-subtitle]', section),
      actions: $('[data-dict-actions]', section),
      body: $('[data-dict-body]', section),
    };
    bodyState = null;
    undoShortcut('dictionary');
    el.actions.addEventListener('click', onHeaderClick);
    // Translations are per target language: re-read when it changes, and stop
    // a running batch (it would keep filling in the old language).
    store.subscribe((key) => {
      if (key !== 'target') return;
      if (batch) batch.stop = true;
      if (visible) renderBody();
    });
    onChange(({ collections, remote }) => {
      if (visible && remote && (collections.includes('dict') || collections.includes('cards'))) renderBody();
    });
    renderBody();
  },
  show(params = {}) {
    visible = true;
    renderBody();
    // Deep links such as #/dictionary?q=Hallo or #/dictionary?filter=pending
    if (list && params) list.applyParams(params);
  },
  hide() {
    visible = false;
    if (list && list.editingKey) list.cancelEdit({ focus: false });
  },
};
