// Shared, accessible building blocks. Template functions return html``
// results (SafeHtml) for views to compose; the small amount of behaviour they
// need (segmented selection, live range values, menus, aria-disabled) is
// delegated from the document and installed on first use.
import { html, SafeHtml, uid } from './dom.js';
import { icon } from './icons.js';
import { LANGUAGES } from '../core/language.js';

// ---- Helpers -----------------------------------------------------------------

const ids = (...list) => list.filter(Boolean).join(' ') || null;
const isTemplate = (v) => v instanceof SafeHtml;

// ---- Buttons -----------------------------------------------------------------

const BUTTON_KINDS = { primary: 'btn--primary', secondary: '', ghost: 'btn--ghost', danger: 'btn--danger', 'danger-ghost': 'btn--danger-ghost' };
const BUTTON_SIZES = { sm: 'btn--sm', md: '', lg: 'btn--lg' };

/**
 * button({ label, icon, kind, size, iconOnly, href, id, action, attrs, className, type })
 * iconOnly buttons keep `label` as their aria-label. `action` sets data-action for delegation.
 */
export function button({ label, icon: iconName, kind = 'secondary', size = 'md', iconOnly = false, href, id, action, attrs = {}, className = '', type = 'button', tooltip = false } = {}) {
  ensureBehaviors();
  const cls = ['btn', BUTTON_KINDS[kind] ?? '', BUTTON_SIZES[size] ?? '', iconOnly ? 'btn--icon' : '', className].filter(Boolean).join(' ');
  const base = {
    class: cls,
    id: id || null,
    'data-action': action || null,
    'aria-label': iconOnly ? label : null,
    'data-tooltip': iconOnly && tooltip ? label : null,
    ...attrs,
  };
  const inner = html`${iconName ? icon(iconName, { size: size === 'sm' ? 16 : 20 }) : ''}${iconOnly ? '' : html`<span class="btn__label">${label}</span>`}`;
  if (href) return html`<a ${{ ...base, href }}>${inner}</a>`;
  return html`<button ${{ type, ...base }}>${inner}</button>`;
}

/** Icon-only ghost button with a mandatory accessible name. */
export function iconButton({ label, icon: iconName, size = 'md', id, action, attrs = {}, className = '', danger = false, tooltip = false } = {}) {
  ensureBehaviors();
  const cls = ['icon-btn', size === 'sm' ? 'icon-btn--sm' : '', danger ? 'icon-btn--danger' : '', className].filter(Boolean).join(' ');
  return html`<button ${{ type: 'button', class: cls, id: id || null, 'data-action': action || null, 'aria-label': label, 'data-tooltip': tooltip ? label : null, ...attrs }}>${icon(iconName, { size: size === 'sm' ? 16 : 20 })}</button>`;
}

/**
 * Busy state for a button: aria-busy + aria-disabled (it stays focusable, so
 * keyboard focus is not lost), a spinner via CSS, and an optional temporary label.
 */
export function setBusy(btn, busy, { label } = {}) {
  if (!btn) return;
  const labelEl = btn.querySelector('.btn__label');
  if (busy) {
    if (labelEl && label != null) {
      if (btn.dataset.idleLabel == null) btn.dataset.idleLabel = labelEl.textContent;
      labelEl.textContent = label;
    }
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
  } else {
    if (labelEl && btn.dataset.idleLabel != null) {
      labelEl.textContent = btn.dataset.idleLabel;
      delete btn.dataset.idleLabel;
    }
    btn.removeAttribute('aria-busy');
    btn.removeAttribute('aria-disabled');
  }
}

// ---- Form fields -------------------------------------------------------------

/**
 * field({ id, label, hint, error, control, inline })
 * `control` is either a template (the caller wires id/aria-describedby) or a
 * function ({ id, describedBy, invalid }) => template.
 */
export function field({ id, label, hint, error, control, inline = false, className = '' }) {
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;
  const describedBy = ids(hintId, errorId);
  const ctrl = typeof control === 'function' ? control({ id, describedBy, invalid: !!error }) : control;
  return html`<div class="${['field', inline ? 'field--inline' : '', className].filter(Boolean).join(' ')}" data-field="${id}">
    <label class="field__label" for="${id}">${label}</label>
    ${hint ? html`<p class="field__hint" id="${hintId}">${hint}</p>` : ''}
    ${ctrl}
    ${error ? html`<p class="field__error" id="${errorId}">${icon('alert-circle', { size: 16 })}<span>${error}</span></p>` : ''}
  </div>`;
}

/** Text-like input wired to a field. */
export function inputField({ id, label, hint, error, type = 'text', value = '', placeholder, inline, attrs = {} }) {
  return field({
    id, label, hint, error, inline,
    control: ({ describedBy, invalid }) => html`<input ${{
      class: 'input', id, type, value, placeholder: placeholder || null,
      'aria-describedby': describedBy, 'aria-invalid': invalid ? 'true' : null, ...attrs,
    }}>`,
  });
}

function optionMarkup(options, value) {
  if (isTemplate(options)) return options;
  const list = Array.isArray(options) ? options : [];
  const groups = [];
  const byGroup = new Map();
  for (const o of list) {
    const g = o.group || '';
    if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g); }
    byGroup.get(g).push(o);
  }
  const opt = (o) => html`<option ${{
    value: o.value ?? '',
    selected: String(o.value ?? '') === String(value ?? ''),
    disabled: !!o.disabled,
    lang: o.lang || null,
  }}>${o.label}</option>`;
  return groups.map((g) => (g
    ? html`<optgroup label="${g}">${byGroup.get(g).map(opt)}</optgroup>`
    : byGroup.get(g).map(opt)));
}

/**
 * selectField({ id, label, hint, error, options, value, inline })
 * options: [{ value, label, lang?, disabled?, group? }] or a template of <option>s
 * (e.g. langSelectOptions()).
 */
export function selectField({ id, label, hint, error, options, value, inline = false, attrs = {} }) {
  return field({
    id, label, hint, error, inline,
    control: ({ describedBy, invalid }) => html`<select ${{
      class: 'select', id, 'aria-describedby': describedBy, 'aria-invalid': invalid ? 'true' : null, ...attrs,
    }}>${optionMarkup(options, value)}</select>`,
  });
}

/**
 * switchField({ id, label, hint, checked, disabled })
 * A checkbox with role=switch inside a full-row <label>; the name comes from
 * the label text only, the hint is the description.
 */
export function switchField({ id, label, hint, checked = false, disabled = false, attrs = {} }) {
  const labelId = `${id}-label`;
  const hintId = hint ? `${id}-hint` : null;
  return html`<div class="switch-field" data-field="${id}">
    <label class="switch-field__row">
      <span class="switch-field__text">
        <span class="switch-field__label" id="${labelId}">${label}</span>
        ${hint ? html`<span class="switch-field__hint" id="${hintId}">${hint}</span>` : ''}
      </span>
      <span class="switch">
        <input ${{
          type: 'checkbox', role: 'switch', class: 'switch__input', id,
          checked: !!checked, disabled: !!disabled,
          'aria-labelledby': labelId, 'aria-describedby': hintId, ...attrs,
        }}>
        <span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span>
      </span>
    </label>
  </div>`;
}

const rangeFormats = new Map();

/**
 * rangeField({ id, label, hint, min, max, step, value, format })
 * The visible <output> and aria-valuetext both use format(value) and update
 * live as the slider moves.
 */
export function rangeField({ id, label, hint, min = 0, max = 100, step = 1, value = 0, format = (v) => String(v), attrs = {} }) {
  ensureBehaviors();
  rangeFormats.set(id, format);
  const text = format(Number(value));
  const hintId = hint ? `${id}-hint` : null;
  return html`<div class="field range-field" data-field="${id}">
    <div class="range-field__head">
      <label class="field__label" for="${id}">${label}</label>
      <output class="range-field__value" id="${id}-value" for="${id}" aria-hidden="true">${text}</output>
    </div>
    ${hint ? html`<p class="field__hint" id="${hintId}">${hint}</p>` : ''}
    <input ${{
      type: 'range', class: 'range', id, min, max, step, value,
      'aria-valuetext': text, 'aria-describedby': hintId, 'data-range': '', ...attrs,
    }}>
  </div>`;
}

/** Update a range's output and aria-valuetext after setting its value from code. */
export function syncRange(input) {
  if (!input) return;
  const format = rangeFormats.get(input.id) || ((v) => String(v));
  const text = format(Number(input.value));
  input.setAttribute('aria-valuetext', text);
  const out = document.getElementById(`${input.id}-value`);
  if (out) out.textContent = text;
}

/**
 * segmented({ id, label, hint, options:[{ value, label, icon? }], value, hideLabel, block })
 * aria-pressed toggle buttons in a labelled group (described by the hint, id
 * `${id}-hint`). Clicking one updates the pressed state and dispatches a
 * bubbling 'change' CustomEvent on the group with detail.value (the group's
 * data-value is kept in sync).
 */
export function segmented({ id, label, hint, options = [], value, hideLabel = false, block = false, size }) {
  ensureBehaviors();
  const labelId = `${id}-label`;
  const hintId = hint ? `${id}-hint` : null;
  return html`<div class="segmented-field" data-field="${id}">
    <span class="${hideLabel ? 'visually-hidden' : 'field__label'}" id="${labelId}">${label}</span>
    ${hint ? html`<p class="field__hint" id="${hintId}">${hint}</p>` : ''}
    <div ${{
      class: ['segmented', block ? 'segmented--block' : '', size === 'sm' ? 'segmented--sm' : ''].filter(Boolean).join(' '),
      role: 'group', id, 'aria-labelledby': labelId, 'aria-describedby': hintId, 'data-segmented': '', 'data-value': value ?? '',
    }}>
      ${options.map((o) => html`<button ${{
        type: 'button', class: 'segmented__option', 'data-value': o.value,
        'aria-pressed': String(String(o.value) === String(value)),
      }}>${o.icon ? icon(o.icon, { size: 16 }) : ''}<span>${o.label}</span></button>`)}
    </div>
  </div>`;
}

/** Set a segmented control's value from code (no change event). */
export function setSegmented(group, value) {
  if (!group) return;
  group.dataset.value = value;
  for (const b of group.querySelectorAll('.segmented__option')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === String(value)));
  }
}

/** Search input with a leading icon and a (visually hidden by default) label. */
export function searchField({ id, label, placeholder = '', value = '', hideLabel = true, describedBy, attrs = {} }) {
  return html`<div class="search">
    <label class="${hideLabel ? 'visually-hidden' : 'field__label'}" for="${id}">${label}</label>
    ${icon('search', { size: 18 })}
    <input ${{ class: 'input', type: 'search', id, value, placeholder: placeholder || null, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': describedBy || null, ...attrs }}>
  </div>`;
}

/**
 * listToolbar({ search, filters, count, actions }) — search/filter/count row shared by Deck and Dictionary.
 * count: { id, text } renders a polite status region for result counts.
 */
export function listToolbar({ search = '', filters = '', count = null, actions = '' } = {}) {
  return html`<div class="list-toolbar">
    ${search ? html`<div class="list-toolbar__search">${search}</div>` : ''}
    ${filters}
    ${count ? html`<p class="list-toolbar__count" id="${count.id}" role="status">${count.text}</p>` : ''}
    ${actions}
  </div>`;
}

// ---- Display -----------------------------------------------------------------

function actionMarkup(a) {
  if (!a) return '';
  if (isTemplate(a)) return a;
  if (Array.isArray(a)) return a.map(actionMarkup);
  return button({ kind: 'primary', ...a });
}

/**
 * emptyState({ icon, title, body, action, level, tone })  tone: 'danger' | 'warning' tints the icon
 * action: a template, a button() option object ({ label, href | action | id, icon, kind }) or an array.
 */
const EMPTY_HEADINGS = {
  2: (title, attrs) => html`<h2 ${attrs}>${title}</h2>`,
  3: (title, attrs) => html`<h3 ${attrs}>${title}</h3>`,
  4: (title, attrs) => html`<h4 ${attrs}>${title}</h4>`,
};

export function emptyState({ icon: iconName = 'sparkles', title, body, action, level = 2, id, tone } = {}) {
  const make = EMPTY_HEADINGS[level] || EMPTY_HEADINGS[2];
  const heading = make(title, { class: 'empty-state__title', id: id ? `${id}-title` : null });
  return html`<div class="empty-state" ${id ? { id } : ''}>
    <div class="${tone === 'danger' || tone === 'warning' ? `empty-state__icon empty-state__icon--${tone}` : 'empty-state__icon'}" aria-hidden="true">${icon(iconName, { size: 28 })}</div>
    ${heading}
    ${body ? html`<p class="empty-state__body">${body}</p>` : ''}
    ${action ? html`<div class="empty-state__actions">${actionMarkup(action)}</div>` : ''}
  </div>`;
}

const BADGE_TONES = new Set(['neutral', 'accent', 'success', 'info', 'warning', 'danger']);

/** Soft-toned pill: badge('Due now', 'accent'). */
export function badge(text, tone = 'neutral', { icon: iconName } = {}) {
  const t = BADGE_TONES.has(tone) ? tone : 'neutral';
  return html`<span class="badge badge--${t}">${iconName ? icon(iconName, { size: 12 }) : ''}${text}</span>`;
}

const STATUS_LABELS = {
  off: 'Off',
  setup: 'Setting up…',
  watching: 'Watching',
  reading: 'Reading…',
  translating: 'Translating…',
  paused: 'Paused',
  error: 'Error',
};

/** OCR status chip: dot + label. States: off, setup, watching, reading, translating, paused, error. */
export function statusChip({ state = 'off', label, id } = {}) {
  const s = STATUS_LABELS[state] ? state : 'off';
  return html`<span class="status-chip" data-state="${s}" ${id ? { id } : ''}>
    <span class="status-chip__dot" aria-hidden="true"></span>
    <span class="status-chip__label">${label || STATUS_LABELS[s]}</span>
  </span>`;
}

/** Update a rendered status chip in place. */
export function setStatusChip(el, { state, label } = {}) {
  if (!el) return;
  const s = STATUS_LABELS[state] ? state : el.dataset.state || 'off';
  el.dataset.state = s;
  const l = el.querySelector('.status-chip__label');
  if (l) l.textContent = label || STATUS_LABELS[s];
}

/**
 * progress({ value, label, id, showValue }) — value is a fraction 0..1
 * (null/undefined → indeterminate). Uses native <progress>.
 */
export function progress({ value, label, id, showValue = true } = {}) {
  const pid = id || uid('progress');
  const labelId = `${pid}-label`;
  const known = typeof value === 'number' && Number.isFinite(value);
  const pct = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : null;
  return html`<div class="progress" data-progress="${pid}">
    <div class="progress__head">
      <span class="progress__label" id="${labelId}">${label}</span>
      ${showValue && known ? html`<span class="progress__value" aria-hidden="true">${pct}%</span>` : ''}
    </div>
    <progress ${{ class: 'progress__bar', id: pid, max: 100, value: known ? pct : null, 'aria-labelledby': labelId }}>${known ? `${pct}%` : ''}</progress>
  </div>`;
}

/** Update a rendered progress in place (value fraction 0..1, or null for indeterminate). */
export function setProgress(wrapper, value, label) {
  if (!wrapper) return;
  const bar = wrapper.querySelector('progress');
  const known = typeof value === 'number' && Number.isFinite(value);
  const pct = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : null;
  if (bar) {
    if (known) { bar.value = pct; bar.textContent = `${pct}%`; } else { bar.removeAttribute('value'); bar.textContent = ''; }
  }
  const v = wrapper.querySelector('.progress__value');
  if (v) v.textContent = known ? `${pct}%` : '';
  if (label != null) {
    const l = wrapper.querySelector('.progress__label');
    if (l) l.textContent = label;
  }
}

/** Inline banner: banner({ tone:'info'|'success'|'warning'|'danger', title, body, actions, role }). */
export function banner({ tone = 'info', title, body, actions = '', role, id, icon: iconName } = {}) {
  const icons = { info: 'info', success: 'check-circle', warning: 'alert-triangle', danger: 'alert-triangle' };
  return html`<div ${{ class: `banner banner--${tone}`, role: role || null, id: id || null }}>
    ${icon(iconName || icons[tone] || 'info')}
    <div class="banner__content">
      ${title ? html`<p class="banner__title">${title}</p>` : ''}
      ${body ? html`<p>${body}</p>` : ''}
    </div>
    ${actions ? html`<div class="banner__actions">${actions}</div>` : ''}
  </div>`;
}

/** Keyboard hint: kbd('T') or kbd(['Shift', '?']). Hidden on touch-only devices when hint is true. */
export function kbd(keys, { hint = false } = {}) {
  const list = Array.isArray(keys) ? keys : [keys];
  return html`<span class="${hint ? 'kbd-combo kbd-hint' : 'kbd-combo'}">${list.map((k) => html`<kbd>${k}</kbd>`)}</span>`;
}

/** Spinner with a status message (visually hidden unless showLabel). */
export function spinner({ label = 'Loading…', size, showLabel = false } = {}) {
  return html`<span class="spinner-wrap" role="status">
    <span class="${size === 'lg' ? 'spinner spinner--lg' : 'spinner'}" aria-hidden="true"></span>
    <span class="${showLabel ? '' : 'visually-hidden'}">${label}</span>
  </span>`;
}

/** Placeholder lines while content loads, with a status message for screen readers. */
export function skeleton({ lines = 3, label = 'Loading…' } = {}) {
  return html`<div class="skeleton">
    <span class="visually-hidden" role="status">${label}</span>
    ${Array.from({ length: Math.max(1, lines) }, () => html`<span class="skeleton__line" aria-hidden="true"></span>`)}
  </div>`;
}

// ---- Languages ---------------------------------------------------------------

const OCR_GROUPS = [
  ['neural', 'Full support'],
  ['tesseract', 'Basic support — expect more misreads'],
  ['none', 'Not supported yet'],
];

/** 'German — Deutsch' (the endonym only when it differs from the English name). */
export function langLabel(l) {
  if (!l) return '';
  return l.endonym && l.endonym !== l.name ? `${l.name} — ${l.endonym}` : l.name;
}

/**
 * <option> markup for language selects.
 *   filter: (lang) => boolean
 *   group: 'ocr' → optgroups by OCR support; unsupported languages are listed but disabled
 *   placeholder: text for an empty first option (selected when nothing is)
 */
export function langSelectOptions(selected, { filter, group, placeholder } = {}) {
  const list = (Array.isArray(LANGUAGES) ? LANGUAGES : []).filter((l) => (typeof filter === 'function' ? filter(l) : true));
  const sel = selected ?? '';
  const opt = (l, disabled = false) => html`<option ${{ value: l.code, selected: l.code === sel, disabled }}>${langLabel(l)}</option>`;
  const head = placeholder != null
    ? html`<option ${{ value: '', disabled: true, selected: !list.some((l) => l.code === sel) }}>${placeholder}</option>`
    : '';
  if (group !== 'ocr') return html`${head}${list.map((l) => opt(l))}`;
  return html`${head}${OCR_GROUPS.map(([level, title]) => {
    const items = list.filter((l) => (l.ocr || 'none') === level);
    return items.length ? html`<optgroup label="${title}">${items.map((l) => opt(l, level === 'none'))}</optgroup>` : '';
  })}`;
}

// ---- Menu (button + role=menu) ------------------------------------------------

/**
 * menu({ id, label, icon, iconOnly, items:[{ action, label, icon, danger, disabled, hint } | 'separator'], align })
 * Items are buttons with data-action; views handle clicks by delegation. The
 * menu closes (and focus returns to its button) before item handlers run.
 */
export function menu({ id, label, icon: iconName = 'more-horizontal', iconOnly = true, items = [], align = 'end', kind = 'ghost', size = 'md' } = {}) {
  ensureBehaviors();
  const menuId = `${id}-menu`;
  const triggerCls = iconOnly
    ? ['icon-btn', size === 'sm' ? 'icon-btn--sm' : ''].filter(Boolean).join(' ')
    : ['btn', BUTTON_KINDS[kind] ?? '', BUTTON_SIZES[size] ?? ''].filter(Boolean).join(' ');
  return html`<div class="menu" data-menu>
    <button ${{
      type: 'button', class: triggerCls, id, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId,
      'aria-label': iconOnly ? label : null, 'data-menu-trigger': '',
    }}>${iconName ? icon(iconName, { size: size === 'sm' ? 16 : 20 }) : ''}${iconOnly ? '' : html`<span class="btn__label">${label}</span>${icon('chevron-down', { size: 16 })}`}</button>
    <div class="${align === 'start' ? 'menu__list menu__list--start' : 'menu__list'}" data-align="${align === 'start' ? 'start' : 'end'}" role="menu" id="${menuId}" aria-labelledby="${id}" hidden>
      ${items.map((it) => (it === 'separator'
        ? html`<hr class="menu__separator">`
        : html`<button ${{
          type: 'button', role: 'menuitem', tabindex: '-1',
          class: it.danger ? 'menu__item menu__item--danger' : 'menu__item',
          'data-action': it.action || null, id: it.id || null,
          'aria-disabled': it.disabled ? 'true' : null,
        }}>${it.icon ? icon(it.icon, { size: 16 }) : ''}<span>${it.label}</span>${it.hint ? html`<span class="menu__hint" aria-hidden="true">${it.hint}</span>` : ''}</button>`))}
    </div>
  </div>`;
}

function menuItems(list) {
  return Array.from(list.querySelectorAll('[role="menuitem"]')).filter((el) => !el.hidden);
}

function openMenu(trigger, focus = 'first') {
  const list = document.getElementById(trigger.getAttribute('aria-controls'));
  if (!list) return;
  closeAllMenus(trigger);
  list.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  // Keep the menu on screen: flip its horizontal alignment when it would run
  // off either edge, and fit it vertically.
  list.classList.remove('menu__list--up', 'menu__list--scroll');
  list.style.removeProperty('max-height');
  // (measured without its opening animation, which scales it)
  list.style.animation = 'none';
  const startAligned = list.dataset.align === 'start';
  list.classList.toggle('menu__list--start', startAligned);
  const r = list.getBoundingClientRect();
  if (r.width && (r.left < 8 || r.right > window.innerWidth - 8)) list.classList.toggle('menu__list--start', !startAligned);
  fitMenu(list, trigger);
  list.style.removeProperty('animation');
  const items = menuItems(list);
  const target = focus === 'last' ? items[items.length - 1] : items[0];
  if (target) target.focus();
}

// Vertically the menu stays clear of what covers the page's edges (the
// sticky header, the tab bar, toasts: the page's scroll padding, base.css).
// It opens downwards when it fits there, else upwards when it fits there,
// else towards the side with more room, scrolling within it.
function fitMenu(list, trigger) {
  const pad = getComputedStyle(document.documentElement);
  const top = Math.max(8, parseFloat(pad.scrollPaddingTop) || 0);
  const bottom = window.innerHeight - Math.max(8, parseFloat(pad.scrollPaddingBottom) || 0);
  const r = list.getBoundingClientRect();
  if (!r.height || (r.top >= top && r.bottom <= bottom)) return;
  const t = trigger.getBoundingClientRect();
  const gap = 6;
  const below = bottom - t.bottom - gap;
  const above = t.top - gap - top;
  const up = r.height > below && (r.height <= above || above > below);
  list.classList.toggle('menu__list--up', up);
  const room = Math.floor(up ? above : below);
  if (r.height <= room) return;
  list.style.maxHeight = `${Math.max(room, 96)}px`;
  list.classList.add('menu__list--scroll');
}

// One item of an open menu is in the tab order: the one with focus (a
// roving tabindex). Arrow keys move it; Tab closes the menu (onKeydown).
function onMenuFocusIn(e) {
  const item = e.target instanceof Element ? e.target.closest('[role="menuitem"]') : null;
  const list = item && item.closest('[role="menu"]');
  if (!list) return;
  for (const el of list.querySelectorAll('[role="menuitem"]')) el.tabIndex = el === item ? 0 : -1;
}

function closeMenu(trigger, { returnFocus = false } = {}) {
  const list = document.getElementById(trigger.getAttribute('aria-controls'));
  if (list) list.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (returnFocus) trigger.focus();
}

function closeAllMenus(except) {
  for (const t of document.querySelectorAll('[data-menu-trigger][aria-expanded="true"]')) {
    if (t !== except) closeMenu(t);
  }
}

function triggerFor(el) {
  const wrap = el.closest('[data-menu]');
  return wrap ? wrap.querySelector('[data-menu-trigger]') : null;
}

// ---- Delegated behaviour -------------------------------------------------------

let behaviorsInstalled = false;

function onClickCapture(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  // aria-disabled controls stay focusable but must not act.
  const disabled = t.closest('[aria-disabled="true"]');
  if (disabled && disabled.matches('button, a, [role="menuitem"], [role="button"]')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  // Menu items: close the menu and return focus first, so handlers that open a
  // dialog record the menu button (still visible) as the element to return to.
  const item = t.closest('[role="menuitem"]');
  if (item) {
    const trigger = triggerFor(item);
    if (trigger) closeMenu(trigger, { returnFocus: true });
  }
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;

  const trigger = t.closest('[data-menu-trigger]');
  if (trigger) {
    if (trigger.getAttribute('aria-expanded') === 'true') closeMenu(trigger, { returnFocus: true });
    else openMenu(trigger, 'first');
    return;
  }
  if (!t.closest('[role="menu"]')) closeAllMenus();

  const seg = t.closest('[data-segmented] .segmented__option');
  if (seg && !seg.disabled) {
    const group = seg.closest('[data-segmented]');
    const value = seg.dataset.value;
    const changed = group.dataset.value !== value;
    setSegmented(group, value);
    if (changed) group.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));
  }
}

function onInput(e) {
  const t = e.target;
  if (t && t.matches && t.matches('input[type="range"][data-range]')) syncRange(t);
}

function onKeydown(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (e.key === 'Escape') document.documentElement.classList.add('tooltips-dismissed');

  const trigger = t.closest('[data-menu-trigger]');
  if (trigger && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    openMenu(trigger, e.key === 'ArrowUp' ? 'last' : 'first');
    return;
  }
  const list = t.closest('[role="menu"]');
  if (!list) return;
  const items = menuItems(list);
  const i = items.indexOf(t.closest('[role="menuitem"]'));
  const owner = triggerFor(list);
  const move = (n) => { e.preventDefault(); const next = items[(n + items.length) % items.length]; if (next) next.focus(); };
  switch (e.key) {
    case 'ArrowDown': move(i + 1); break;
    case 'ArrowUp': move(i - 1); break;
    case 'Home': move(0); break;
    case 'End': move(items.length - 1); break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      if (owner) closeMenu(owner, { returnFocus: true });
      break;
    case 'Tab':
      // Close and hand focus back to the button, so Tab carries on from there
      // rather than from an item that just disappeared.
      if (owner) closeMenu(owner, { returnFocus: true });
      break;
    default:
      // Type-ahead: jump to the next item starting with the typed letter.
      if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ch = e.key.toLowerCase();
        const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
        const hit = order.find((el) => el.textContent.trim().toLowerCase().startsWith(ch));
        if (hit) { e.preventDefault(); hit.focus(); }
      }
  }
}

// Safari (and Firefox on macOS) don't focus buttons on click: pressing a menu
// item or the trigger blurs the focused item with no relatedTarget. Remember
// which menu the pointer is pressing so that blur doesn't close the menu
// before the click arrives.
let pressedMenu = null;

function onPointerDown(e) {
  pressedMenu = e.target instanceof Element ? e.target.closest('[data-menu]') : null;
}

function onPointerUp() {
  // The click follows pointerup in the same task; forget the press afterwards.
  setTimeout(() => { pressedMenu = null; }, 0);
}

function onFocusOut(e) {
  const list = e.target instanceof Element ? e.target.closest('[role="menu"]') : null;
  if (!list || list.hidden) return;
  const to = e.relatedTarget;
  const wrap = list.closest('[data-menu]');
  if (to && wrap && wrap.contains(to)) return;
  if (!to && wrap && pressedMenu === wrap) return;
  const owner = triggerFor(list);
  if (owner) closeMenu(owner);
}

function onPointerMove() {
  document.documentElement.classList.remove('tooltips-dismissed');
}

/** Install the delegated component behaviour (idempotent; also runs on first template use). */
export function ensureBehaviors() {
  if (behaviorsInstalled || typeof document === 'undefined') return;
  behaviorsInstalled = true;
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  // Capture phase: a menu inside a dialog must handle Escape before the dialog does.
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('focusin', onMenuFocusIn);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
  document.addEventListener('pointermove', onPointerMove, { passive: true });
}

export const initComponents = ensureBehaviors;
