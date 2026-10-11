// Shared list pattern for Deck and Dictionary: a toolbar (labelled search
// with a clear button, segmented filter, live result count, overflow menu),
// a stats strip, and a paged list (100 rows at a time) driven by ONE set of
// delegated listeners. Rows carry data-key, so deletes, edits and refreshes
// put keyboard focus somewhere sensible instead of dropping it to <body>.
import '../../styles/views/listview.css';
import { html, render, rerender, debounce, isFocusable } from '../dom.js';
import { icon } from '../icons.js';
import { searchField, segmented, setSegmented, menu, setBusy } from '../components.js';
import { announce, focusHeading, registerShortcut } from '../a11y.js';
import { toast } from '../toast.js';
import { formatCount } from '../format.js';
import { dirFor } from '../../core/language.js';

export const PAGE_SIZE = 100;
const SEARCH_DELAY = 150;

// ---- Small shared pieces ----------------------------------------------------

/** The Edit (pencil) icon used by row and card editors. */
export function editIcon(size = 16) {
  return icon('pencil', { size });
}

/** “Hallo” for button names and messages; long text is shortened with an ellipsis. */
export function quoteTerm(text, max = 40) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return `“${chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : t}”`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * When a future time arrives, in study-day terms: 'in 5 min', 'in 3 hours',
 * 'tomorrow', 'in 9 days', 'in 2 months'. Days are counted between local
 * study days (they roll over at 4 am, like the scheduler's due times).
 */
export function untilText(ts, now = Date.now()) {
  const ms = ts - now;
  if (ms < MINUTE) return 'in a moment';
  const day = (t) => {
    const d = new Date(t);
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
  };
  const days = day(ts) - day(now);
  if (days <= 0 || ms < 6 * HOUR) {
    // Round first, so 59.7 minutes reads 'in 1 hour' rather than 'in 60 min'.
    const min = Math.round(ms / MINUTE);
    if (min < 60) return `in ${min} min`;
    const h = Math.round(ms / HOUR);
    return `in ${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  if (days === 1) return 'tomorrow';
  if (days < 60) return `in ${days} days`;
  const months = Math.round(days / 30.4);
  return months < 24 ? `in ${months} months` : `in ${Math.round(days / 365)} years`;
}

/** Text-direction attributes for a piece of text in language `code`. */
export function langAttrs(code) {
  return code ? { lang: code, dir: dirFor(code) } : {};
}

/**
 * Compact stats strip: statsStrip({ label, tiles: [{ label, value, tone, icon }] }).
 * A <dl> so each number is read with its label ("Due now, 12").
 */
export function statsStrip({ label, tiles = [], className = '' }) {
  return html`<dl class="${['stats', 'lv-stats', className].filter(Boolean).join(' ')}" aria-label="${label}">
    ${tiles.map((t) => html`<div class="${t.tone ? `stat lv-stat lv-stat--${t.tone}` : 'stat lv-stat'}">
      <dt class="stat__label">${t.icon ? icon(t.icon, { size: 16 }) : ''}<span>${t.label}</span></dt>
      <dd class="stat__value">${t.value}</dd>
    </div>`)}
  </dl>`;
}

/**
 * Toolbar: listToolbar({ id, searchLabel, placeholder, filterLabel, filters, filter, extra, menuLabel, menuItems }).
 * `extra` is optional markup placed after the filter (e.g. a sort select).
 */
export function listToolbar({ id, searchLabel, placeholder = '', filterLabel, filters = [], filter = 'all', extra = '', menuLabel = 'More actions', menuItems = [] }) {
  return html`<div class="lv-toolbar">
    <div class="lv-search">
      ${searchField({ id: `${id}-search`, label: searchLabel, placeholder, describedBy: `${id}-count`, attrs: { 'data-lv-search': '', enterkeyhint: 'search' } })}
      <button type="button" class="icon-btn icon-btn--sm lv-search__clear" data-lv-action="clear" aria-label="Clear search" hidden>${icon('x', { size: 16 })}</button>
    </div>
    <div class="lv-toolbar__filters" data-lv-filter-wrap>
      ${segmented({ id: `${id}-filter`, label: filterLabel, hideLabel: true, options: filters, value: filter, size: 'sm' })}
      ${extra}
    </div>
    <div class="lv-toolbar__end">
      <p class="lv-count" id="${id}-count" role="status" data-lv-count></p>
      ${menuItems.length ? menu({ id: `${id}-menu`, label: menuLabel, items: menuItems }) : ''}
    </div>
  </div>`;
}

/** The list itself plus its "no matches" message and "Show more" footer. */
export function listBody({ id, label }) {
  return html`<ul class="lv-list" id="${id}-list" aria-label="${label}" data-lv-list></ul>
    <div class="lv-nomatch" data-lv-empty hidden></div>
    <div class="lv-more" data-lv-more hidden>
      <button type="button" class="btn" data-lv-action="more">${icon('chevron-down', { size: 16 })}<span class="btn__label">Show more</span></button>
      <p class="lv-more__note" data-lv-more-note></p>
    </div>`;
}

/**
 * Term + translation lines of a row. The translation (or a placeholder when
 * there is none yet) carries its own language, so screen readers switch voice.
 * With `editor`, the inline edit form takes the translation's place.
 */
export function termLines({ text, src, translation, tgt, emptyText = 'Not translated yet', editor = null }) {
  let second;
  if (editor) second = editor;
  else if (translation) second = html`<p ${{ class: 'lv-translation', ...langAttrs(tgt) }}>${translation}</p>`;
  else second = html`<p class="lv-translation lv-translation--empty">${emptyText}</p>`;
  return html`<p ${{ class: 'lv-term', ...langAttrs(src) }}>${text}</p>${second}`;
}

/** Inline editor for a translation: Enter saves, Escape (or Cancel) closes. */
export function editForm({ key, term, value = '', tgt, retranslate = true }) {
  const inputId = `lv-edit-${key}`;
  return html`<form class="lv-edit" data-lv-edit novalidate>
    <label class="visually-hidden" for="${inputId}">Translation of ${quoteTerm(term)}</label>
    <input ${{ class: 'input', id: inputId, name: 'translation', type: 'text', value, autocomplete: 'off', spellcheck: 'true', enterkeyhint: 'done', ...langAttrs(tgt) }}>
    <div class="lv-edit__actions">
      <button type="submit" class="btn btn--sm btn--primary" data-edit-action="save">${icon('check', { size: 16 })}<span class="btn__label">Save</span></button>
      <button type="button" class="btn btn--sm btn--ghost" data-edit-action="cancel">Cancel</button>
      ${retranslate ? html`<button type="button" class="btn btn--sm btn--ghost" data-edit-action="retranslate">${icon('refresh-cw', { size: 16 })}<span class="btn__label">Translate again</span></button>` : ''}
    </div>
  </form>`;
}

/** A list row: <li data-key> with the text block, meta chips and labelled actions. */
export function listRow({ key, body, meta = [], actions = [], className = '' }) {
  const chips = meta.filter(Boolean);
  return html`<li class="${['lv-row', className].filter(Boolean).join(' ')}" data-key="${key}">
    <div class="lv-row__main">
      ${body}
      ${chips.length ? html`<div class="lv-row__meta">${chips}</div>` : ''}
    </div>
    <div class="lv-row__actions">${actions.filter(Boolean)}</div>
  </li>`;
}

/** Labelled icon button for a row action (data-action is read by the controller). */
export function rowAction({ action, label, icon: iconName, iconMarkup, danger = false, attrs = {} }) {
  const cls = ['icon-btn', 'lv-action', danger ? 'icon-btn--danger' : ''].filter(Boolean).join(' ');
  return html`<button ${{ type: 'button', class: cls, 'data-action': action, 'aria-label': label, ...attrs }}>${iconMarkup || icon(iconName, { size: 18 })}</button>`;
}

/** Visible-text row action (e.g. "Translate" on pending rows). */
export function rowTextAction({ action, label, name, icon: iconName, kind = 'secondary' }) {
  const cls = ['btn', 'btn--sm', 'lv-action', kind === 'primary' ? 'btn--primary' : kind === 'ghost' ? 'btn--ghost' : ''].filter(Boolean).join(' ');
  return html`<button ${{ type: 'button', class: cls, 'data-action': action, 'aria-label': name || null }}>${iconName ? icon(iconName, { size: 16 }) : ''}<span class="btn__label">${label}</span></button>`;
}

// ---- Undo -----------------------------------------------------------------------
// A deleted row's Undo sits in a toast at the end of the page, which can be
// hundreds of Tab presses away from the list: Ctrl+Z (⌘Z on Apple devices)
// runs the newest Undo of the current view while its toast is showing.

let lastUndo = null; // { scope, handle, run, done }

/** Toast "message" with an Undo button that `undoShortcut(scope)` can also trigger. */
export function undoToast(message, onUndo, { scope }) {
  const entry = { scope, done: false, handle: null };
  entry.run = () => {
    if (entry.done) return;
    entry.done = true;
    if (lastUndo === entry) lastUndo = null;
    onUndo();
  };
  entry.handle = toast(message, { action: { label: 'Undo', onClick: entry.run } });
  lastUndo = entry;
  return entry.handle;
}

/** Run the newest pending Undo for `scope`; false when there is none showing. */
export function runLastUndo(scope) {
  const u = lastUndo;
  if (!u || u.done || u.scope !== scope || !(u.handle && u.handle.el && u.handle.el.isConnected && !u.handle.el.hasAttribute('data-leaving'))) return false;
  u.handle.dismiss();
  u.run();
  return true;
}

const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

/** Register Ctrl+Z / ⌘Z for a view (only the platform's own combo is listed in the help). */
export function undoShortcut(scope) {
  // false lets the key through; Ctrl+Shift+Z is redo, not undo.
  const handler = (e) => !(e && e.shiftKey) && runLastUndo(scope);
  const offs = [
    registerShortcut({ key: 'Ctrl+z', label: 'Undo the last delete', scope, handler, hidden: APPLE }),
    registerShortcut({ key: 'Meta+z', label: 'Undo the last delete', scope, handler, hidden: !APPLE }),
  ];
  return () => offs.forEach((off) => off());
}

// ---- Controller ---------------------------------------------------------------

function firstFocusable(el) {
  if (!el) return null;
  return Array.from(el.querySelectorAll('button, a[href], input, select, textarea')).find(isFocusable) || null;
}

function rowByKey(listEl, key) {
  return Array.from(listEl.children).find((li) => li.dataset.key === key) || null;
}

/**
 * createListController(root, options) wires the toolbar and list inside `root`.
 * options:
 *   noun: ['card', 'cards']                    used in counts
 *   pageSize: 100
 *   params: { filter: 'all', ... }             initial query params (plus q)
 *   query({ q, filter, ...params, limit })     → { items, total }
 *   overall()                                  → number of items with no search/filter
 *   keyOf(item), renderRow(item, { editing })  → html <li data-key>
 *   noMatch({ q, filter })                     → message when nothing matches
 *   onAction(action, ctx)                      row buttons ([data-action] inside a row)
 *   onMenu(action, event)                      toolbar menu items
 *   onSave(key, value, ctx)                    → true/false (or a promise) when an edit is saved
 *   onRetranslate(key, ctx)                    → Promise<string> filling the edit input
 *   afterRender()                              after every list render
 * Returns { refresh, render, setParams, applyParams, reset, showMore, focusRow,
 * updateRow, removed, startEdit, cancelEdit, destroy, … }.
 */
export function createListController(root, options) {
  const opts = { pageSize: PAGE_SIZE, noun: ['item', 'items'], ...options };
  const el = {
    search: root.querySelector('[data-lv-search]'),
    clear: root.querySelector('[data-lv-action="clear"]'),
    filter: root.querySelector('[data-segmented]'),
    count: root.querySelector('[data-lv-count]'),
    list: root.querySelector('[data-lv-list]'),
    empty: root.querySelector('[data-lv-empty]'),
    more: root.querySelector('[data-lv-more]'),
    moreNote: root.querySelector('[data-lv-more-note]'),
  };
  const state = { q: '', filter: 'all', ...opts.params, limit: opts.pageSize };
  let items = new Map();
  let order = [];
  let total = 0;
  let editingKey = null;
  const offs = [];

  const params = () => ({ ...state });
  const filtered = () => !!state.q.trim() || (state.filter && state.filter !== 'all');

  function countText() {
    const overall = typeof opts.overall === 'function' ? opts.overall() : total;
    if (!filtered()) return formatCount(total, opts.noun);
    return `${total.toLocaleString('en')} of ${formatCount(overall, opts.noun)}`;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  const editInput = (key) => (key ? rowByKey(el.list, key)?.querySelector('[data-lv-edit] input') : null);

  function renderList() {
    const res = opts.query(params());
    // A refresh (search, filter, another tab) must not throw away a half-typed edit.
    const draft = editInput(editingKey)?.value;
    total = res.total;
    items = new Map(res.items.map((it) => [String(opts.keyOf(it)), it]));
    order = res.items.map((it) => String(opts.keyOf(it)));
    if (editingKey && !items.has(editingKey)) editingKey = null;
    render(el.list, html`${res.items.map((it) => opts.renderRow(it, { editing: String(opts.keyOf(it)) === editingKey }))}`);
    const input = editInput(editingKey);
    if (input && draft != null) input.value = draft;
    el.list.hidden = res.items.length === 0;
    el.empty.hidden = res.items.length > 0;
    if (!res.items.length) {
      render(el.empty, html`<p>${opts.noMatch ? opts.noMatch(params()) : 'Nothing matches.'}</p>
        ${filtered() ? html`<button type="button" class="btn btn--sm" data-lv-action="reset">Clear search and filters</button>` : ''}`);
    }
    const remaining = Math.max(0, total - res.items.length);
    el.more.hidden = remaining === 0;
    if (remaining) {
      const next = Math.min(remaining, opts.pageSize);
      setText(el.more.querySelector('.btn__label'), `Show ${next.toLocaleString('en')} more`);
      setText(el.moreNote, `Showing ${res.items.length.toLocaleString('en')} of ${total.toLocaleString('en')}`);
    }
    setText(el.count, countText());
    if (el.clear) el.clear.hidden = !state.q;
    if (opts.afterRender) opts.afterRender();
  }

  /** Re-query and re-render, keeping focus on the same row (or its replacement). */
  function refresh({ resetPage = false } = {}) {
    if (resetPage) state.limit = opts.pageSize;
    rerender(root, renderList);
  }

  function focusRow(key, action) {
    const li = rowByKey(el.list, String(key));
    if (!li) return false;
    const target = (action && Array.from(li.querySelectorAll(`[data-action="${action}"]`)).find(isFocusable)) || firstFocusable(li);
    if (target) target.focus();
    return !!target;
  }

  function focusFallback() {
    if (el.search && isFocusable(el.search)) el.search.focus();
    else focusHeading(root.closest('section[data-view]') || undefined);
  }

  /** After the view removed `key` from its data: re-render and focus the row that took its place. */
  function removed(key) {
    const idx = order.indexOf(String(key));
    renderList();
    const next = order[Math.min(Math.max(idx, 0), order.length - 1)];
    if (next != null && focusRow(next)) return;
    focusFallback();
  }

  /** Replace one row in place (focus stays on the same control inside it). */
  function updateRow(key, item) {
    const k = String(key);
    const li = rowByKey(el.list, k);
    if (!li) return false;
    if (item) items.set(k, item);
    const current = items.get(k);
    if (!current) return false;
    rerender(li.parentElement, () => {
      const tpl = document.createElement('template');
      tpl.innerHTML = String(opts.renderRow(current, { editing: editingKey === k }));
      const fresh = tpl.content.firstElementChild;
      if (fresh) li.replaceWith(fresh);
    });
    return true;
  }

  function startEdit(key) {
    const k = String(key);
    if (editingKey && editingKey !== k) cancelEdit({ focus: false });
    editingKey = k;
    updateRow(k);
    const input = rowByKey(el.list, k)?.querySelector('[data-lv-edit] input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function cancelEdit({ focus = true } = {}) {
    const k = editingKey;
    if (!k) return;
    editingKey = null;
    updateRow(k);
    if (focus) focusRow(k, 'edit');
  }

  async function saveEdit(form) {
    const li = form.closest('li[data-key]');
    const k = li && li.dataset.key;
    if (!k || !opts.onSave || form.dataset.saving) return;
    const input = form.querySelector('input');
    let ok;
    form.dataset.saving = 'true'; // a second Enter while an async save runs is ignored
    try {
      ok = await opts.onSave(k, input.value, { item: items.get(k), controller: api });
    } catch (err) {
      console.error('[list] save failed', err);
      ok = false;
    } finally {
      delete form.dataset.saving;
    }
    if (ok === false) {
      if (input.isConnected) input.focus();
      return;
    }
    editingKey = null;
    if (ok && typeof ok === 'object') items.set(k, ok);
    updateRow(k);
    focusRow(k, 'edit');
  }

  async function retranslate(form, btn) {
    const li = form.closest('li[data-key]');
    const k = li && li.dataset.key;
    if (!k || !opts.onRetranslate || btn.getAttribute('aria-busy') === 'true') return;
    const input = form.querySelector('input');
    setBusy(btn, true, { label: 'Translating…' });
    try {
      const text = await opts.onRetranslate(k, { item: items.get(k), controller: api });
      if (typeof text === 'string' && text && input.isConnected) {
        input.value = text;
        announce(`New translation: ${text}. Press Save to keep it.`);
      }
    } catch (err) {
      console.error('[list] translate failed', err);
    } finally {
      if (btn.isConnected) setBusy(btn, false);
      if (input.isConnected) input.focus();
    }
  }

  function setParams(patch, { resetPage = true } = {}) {
    Object.assign(state, patch);
    refresh({ resetPage });
  }

  /**
   * Apply query params from a deep link (#/deck?q=…&filter=…) and update the
   * search field and filter to match. Unknown filters are ignored.
   */
  function applyParams(params = {}) {
    const patch = {};
    if (typeof params.q === 'string' && params.q !== state.q) patch.q = params.q;
    const opt = typeof params.filter === 'string' && el.filter
      ? Array.from(el.filter.querySelectorAll('.segmented__option')).find((b) => b.dataset.value === params.filter)
      : null;
    if (opt && params.filter !== state.filter) patch.filter = params.filter;
    if (!Object.keys(patch).length) return false;
    runSearch.cancel();
    if ('q' in patch && el.search) el.search.value = patch.q;
    if ('filter' in patch) setSegmented(el.filter, patch.filter);
    setParams(patch);
    return true;
  }

  function reset() {
    state.q = '';
    state.filter = 'all';
    if (el.search) el.search.value = '';
    if (el.filter) setSegmented(el.filter, 'all');
    refresh({ resetPage: true });
    if (el.search) el.search.focus();
  }

  function showMore() {
    const before = order.length;
    state.limit += opts.pageSize;
    renderList();
    // Continue reading where the new rows start.
    const first = order[before];
    if (first == null || !focusRow(first)) focusFallback();
    announce(`Showing ${order.length.toLocaleString('en')} of ${formatCount(total, opts.noun)}`);
  }

  const runSearch = debounce(() => {
    const q = el.search ? el.search.value : '';
    if (q === state.q) return;
    state.q = q;
    refresh({ resetPage: true });
  }, SEARCH_DELAY);

  // ---- Delegated listeners (one per event type for the whole list section) ----

  const onClick = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const lv = t.closest('[data-lv-action]');
    if (lv && root.contains(lv)) {
      const a = lv.dataset.lvAction;
      if (a === 'more') showMore();
      else if (a === 'reset') reset();
      else if (a === 'clear') {
        runSearch.cancel();
        if (el.search) el.search.value = '';
        setParams({ q: '' });
        if (el.search) el.search.focus();
      }
      return;
    }
    const editBtn = t.closest('[data-edit-action]');
    if (editBtn) {
      const form = editBtn.closest('[data-lv-edit]');
      if (editBtn.dataset.editAction === 'cancel') cancelEdit();
      else if (editBtn.dataset.editAction === 'retranslate') retranslate(form, editBtn);
      return;
    }
    const btn = t.closest('[data-action]');
    if (!btn || !root.contains(btn) || btn.getAttribute('aria-disabled') === 'true') return;
    const li = btn.closest('li[data-key]');
    if (li && el.list.contains(li)) {
      const key = li.dataset.key;
      if (btn.dataset.action === 'edit' && !opts.handlesEdit) {
        if (editingKey === key) cancelEdit();
        else startEdit(key);
        return;
      }
      if (opts.onAction) opts.onAction(btn.dataset.action, { key, item: items.get(key), button: btn, event: e, controller: api });
    } else if (btn.getAttribute('role') === 'menuitem' && opts.onMenu) {
      opts.onMenu(btn.dataset.action, e);
    }
  };

  const onInput = (e) => {
    if (e.target === el.search) {
      if (el.clear) el.clear.hidden = !el.search.value;
      runSearch();
    }
  };

  const onKeydown = (e) => {
    // Enter in the search runs it now instead of waiting for the debounce.
    if (e.key === 'Enter' && e.target === el.search) {
      runSearch.flush();
      return;
    }
    if (e.key !== 'Escape') return;
    if (e.target === el.search && el.search.value) {
      e.preventDefault();
      runSearch.cancel();
      el.search.value = '';
      setParams({ q: '' });
      return;
    }
    if (e.target instanceof Element && e.target.closest('[data-lv-edit]')) {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  };

  const onSubmit = (e) => {
    const form = e.target instanceof Element ? e.target.closest('[data-lv-edit]') : null;
    if (!form) return;
    e.preventDefault();
    saveEdit(form);
  };

  const onFilter = (e) => {
    if (!e.detail || !el.filter || e.target !== el.filter) return;
    setParams({ filter: e.detail.value });
  };

  const listen = (type, fn) => {
    root.addEventListener(type, fn);
    offs.push(() => root.removeEventListener(type, fn));
  };
  listen('click', onClick);
  listen('input', onInput);
  listen('keydown', onKeydown);
  listen('submit', onSubmit);
  listen('change', onFilter);

  const api = {
    get state() { return params(); },
    get total() { return total; },
    get keys() { return [...order]; },
    get editingKey() { return editingKey; },
    item: (key) => items.get(String(key)),
    refresh,
    render: renderList,
    setParams,
    applyParams,
    reset,
    showMore,
    focusRow,
    updateRow,
    removed,
    startEdit,
    cancelEdit,
    rowEl: (key) => rowByKey(el.list, String(key)),
    destroy() {
      runSearch.cancel();
      while (offs.length) offs.pop()();
    },
  };
  return api;
}
