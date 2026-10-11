// Text area ("zone") editor: the player marks the part of the game screen
// that holds the text, and only that part is read. The area is stored per
// ROM in normalised game-frame units ({ x, y, w, h } in 0..1), so it stays
// right at any canvas size, rotation or zoom (PLAY-11, UX-10, A11Y-27).
//
// Three equivalent ways to set it: drag on the game (pointer capture, cancel
// safe), the keyboard on the outlined area (arrows move, Shift+arrows
// resize, Enter saves, Esc cancels) and four % fields with validation.
import { html, render, uid, debounce } from '../../dom.js';
import { icon } from '../../icons.js';
import { announce } from '../../a11y.js';
import { button } from '../../components.js';

// ---- Pure geometry (exported for tests) -------------------------------------------

export const MIN_SIZE = 0.05;
export const KEY_STEP = 0.01;
/** A starting suggestion: the bottom third, where most games put their text box. */
export const DEFAULT_ZONE = Object.freeze({ x: 0.03, y: 0.64, w: 0.94, h: 0.33 });

const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/** Keep a rect inside the frame and at least MIN_SIZE wide and tall. */
export function clampZone(r) {
  if (!r) return null;
  const w = Math.min(1, Math.max(MIN_SIZE, Number(r.w) || 0));
  const h = Math.min(1, Math.max(MIN_SIZE, Number(r.h) || 0));
  const x = Math.min(1 - w, Math.max(0, Number(r.x) || 0));
  const y = Math.min(1 - h, Math.max(0, Number(r.y) || 0));
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

/** Whether a stored value is a usable zone. */
export function isZone(r) {
  return !!r && ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k])) &&
    r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001;
}

/** Rect spanned by two normalised points (drawing). */
export function zoneFromPoints(a, b) {
  const x0 = clamp01(Math.min(a.x, b.x));
  const y0 = clamp01(Math.min(a.y, b.y));
  const x1 = clamp01(Math.max(a.x, b.x));
  const y1 = clamp01(Math.max(a.y, b.y));
  // a tap without a drag grows to the minimum around the point
  const w = Math.max(MIN_SIZE, x1 - x0);
  const h = Math.max(MIN_SIZE, y1 - y0);
  return clampZone({ x: x1 - x0 < MIN_SIZE ? x0 - MIN_SIZE / 2 : x0, y: y1 - y0 < MIN_SIZE ? y0 - MIN_SIZE / 2 : y0, w, h });
}

export function moveZone(r, dx, dy) {
  return clampZone({ ...r, x: r.x + dx, y: r.y + dy });
}

/** Grow or shrink from the bottom-right corner, staying inside the frame. */
export function resizeZone(r, dw, dh) {
  const w = Math.min(1 - r.x, Math.max(MIN_SIZE, r.w + dw));
  const h = Math.min(1 - r.y, Math.max(MIN_SIZE, r.h + dh));
  return clampZone({ ...r, w, h });
}

/** Normalised position of a pointer inside a box (DOMRect-like), clamped. */
export function pointInBox(clientX, clientY, box) {
  if (!box || !box.width || !box.height) return { x: 0, y: 0 };
  return { x: clamp01((clientX - box.left) / box.width), y: clamp01((clientY - box.top) / box.height) };
}

const pct = (n) => Math.round(n * 1000) / 10;

/** { left, top, width, height } in % with one decimal. */
export function zoneToPercent(r) {
  return { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) };
}

export const FIELD_LABELS = { left: 'Left', top: 'Top', width: 'Width', height: 'Height' };

/**
 * Validate the four % fields. → { zone, errors } where errors maps a field
 * name to a message (zone is null when any field is invalid).
 */
export function zoneFromPercent(fields) {
  const errors = {};
  const val = {};
  const min = MIN_SIZE * 100;
  for (const k of ['left', 'top', 'width', 'height']) {
    const raw = fields ? fields[k] : undefined;
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
    if (raw === '' || raw == null || !Number.isFinite(n)) { errors[k] = `Enter a number for ${FIELD_LABELS[k].toLowerCase()}.`; continue; }
    if (k === 'width' || k === 'height') {
      if (n < min || n > 100) { errors[k] = `${FIELD_LABELS[k]} must be between ${min} and 100%.`; continue; }
    } else if (n < 0 || n > 100 - min) {
      errors[k] = `${FIELD_LABELS[k]} must be between 0 and ${100 - min}%.`;
      continue;
    }
    val[k] = n / 100;
  }
  if (!errors.left && !errors.width && val.left + val.width > 1.0001) errors.width = 'Left plus width can’t be more than 100%.';
  if (!errors.top && !errors.height && val.top + val.height > 1.0001) errors.height = 'Top plus height can’t be more than 100%.';
  if (Object.keys(errors).length) return { zone: null, errors };
  return { zone: clampZone({ x: val.left, y: val.top, w: val.width, h: val.height }), errors };
}

export function sameZone(a, b) {
  if (!a || !b) return !a && !b;
  return ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 0.0005);
}

export function describeZone(r) {
  const p = zoneToPercent(r);
  return `Left ${p.left}%, top ${p.top}%, width ${p.width}%, height ${p.height}%.`;
}

// ---- Editor ---------------------------------------------------------------------

const KEY_MOVES = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * createZoneEditor({ overlayEl, panelEl, onOpen, onClose, onSave })
 *   overlayEl: positioned over the game frame (inside the stage)
 *   panelEl:   where the fields and buttons go (below the toolbar)
 *   onSave(zone | null): persist and apply (null = automatic detection)
 * → { open(current), close(), isOpen() }
 */
export function createZoneEditor({ overlayEl, panelEl, onOpen = () => {}, onClose = () => {}, onSave = async () => {} }) {
  const id = uid('zone');
  const ids = { title: `${id}-title`, help: `${id}-help`, values: `${id}-values`, desc: `${id}-desc` };
  let open = false;
  let saved = null;     // the zone in use when the editor opened (null = automatic)
  let rect = { ...DEFAULT_ZONE };
  let drag = null;
  let ac = null;        // listeners that only exist while editing
  let returnFocus = null;

  const speakValues = debounce(() => { if (open) announce(describeZone(rect)); }, 600);

  function renderOverlay() {
    render(overlayEl, html`<div class="zone-rect" tabindex="0" role="application" aria-roledescription="text area editor"
        aria-labelledby="${ids.title}" aria-describedby="${ids.help} ${ids.values}" data-zone-rect>
        <span class="zone-rect__label" aria-hidden="true">${icon('scan-text', { size: 14 })}Text area</span>
        <span class="zone-rect__handle" data-handle aria-hidden="true"></span>
      </div>
      <p class="visually-hidden" id="${ids.help}">Arrow keys move the area. Shift and arrow keys resize it. Enter saves, Escape cancels.</p>
      <p class="visually-hidden" id="${ids.values}" data-zone-values></p>`);
  }

  function field(name) {
    const fid = `${id}-${name}`;
    return html`<div class="zone-field" data-zone-field="${name}">
      <label class="field__label" for="${fid}">${FIELD_LABELS[name]} <span class="text-muted">(%)</span></label>
      <input class="input" id="${fid}" name="${name}" type="number" inputmode="decimal" min="0" max="100" step="0.5"
        aria-describedby="${ids.desc}" autocomplete="off">
      <p class="field__error" id="${fid}-error" hidden></p>
    </div>`;
  }

  function renderPanel() {
    render(panelEl, html`<div class="zone-editor" role="region" aria-labelledby="${ids.title}">
      <div class="zone-editor__head">
        <h3 class="zone-editor__title" id="${ids.title}">Text area</h3>
        <p class="zone-editor__desc text-sm text-muted" id="${ids.desc}">Draw a box over the game’s text, or enter it as a percentage of the screen. Only this part of the screen is read.</p>
      </div>
      <form class="zone-editor__form" novalidate data-zone-form>
        <div class="zone-editor__fields">${['left', 'top', 'width', 'height'].map(field)}</div>
        <div class="zone-editor__actions">
          ${button({ label: 'Save area', icon: 'check', kind: 'primary', type: 'submit', action: 'zone-save' })}
          ${button({ label: 'Use automatic detection', icon: 'sparkles', action: 'zone-auto' })}
          ${button({ label: 'Cancel', kind: 'ghost', action: 'zone-cancel' })}
        </div>
      </form>
    </div>`);
  }

  function paint() {
    const el = overlayEl.querySelector('[data-zone-rect]');
    if (el) {
      el.style.left = `${rect.x * 100}%`;
      el.style.top = `${rect.y * 100}%`;
      el.style.width = `${rect.w * 100}%`;
      el.style.height = `${rect.h * 100}%`;
    }
    const values = overlayEl.querySelector('[data-zone-values]');
    if (values) values.textContent = describeZone(rect);
  }

  function fillFields() {
    const p = zoneToPercent(rect);
    for (const [k, v] of Object.entries(p)) {
      const input = panelEl.querySelector(`input[name="${k}"]`);
      if (input && document.activeElement !== input) input.value = String(v);
    }
    clearErrors();
  }

  function clearErrors() {
    for (const input of panelEl.querySelectorAll('input[name]')) {
      input.removeAttribute('aria-invalid');
      input.setAttribute('aria-describedby', ids.desc);
      const err = panelEl.querySelector(`#${input.id}-error`);
      if (err) { err.hidden = true; err.textContent = ''; }
    }
  }

  function showErrors(errors) {
    clearErrors();
    let first = null;
    for (const [k, msg] of Object.entries(errors)) {
      const input = panelEl.querySelector(`input[name="${k}"]`);
      if (!input) continue;
      const err = panelEl.querySelector(`#${input.id}-error`);
      render(err, html`${icon('alert-circle', { size: 16 })}<span>${msg}</span>`);
      err.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${ids.desc} ${err.id}`);
      first = first || input;
    }
    if (first) first.focus();
    return first;
  }

  function setRect(next, { fields = true } = {}) {
    rect = clampZone(next);
    paint();
    if (fields) fillFields();
  }

  function readFields() {
    const out = {};
    for (const input of panelEl.querySelectorAll('input[name]')) out[input.name] = input.value;
    return zoneFromPercent(out);
  }

  // ---- pointer ----

  function overlayBox() {
    return overlayEl.getBoundingClientRect();
  }

  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const box = overlayBox();
    const p = pointInBox(e.clientX, e.clientY, box);
    const handle = e.target.closest('[data-handle]');
    const body = e.target.closest('[data-zone-rect]');
    const mode = handle ? 'resize' : body ? 'move' : 'draw';
    drag = { id: e.pointerId, mode, start: p, from: { ...rect }, box };
    try { overlayEl.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    if (mode === 'draw') setRect(zoneFromPoints(p, p), { fields: false });
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const p = pointInBox(e.clientX, e.clientY, drag.box);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (drag.mode === 'move') setRect(moveZone(drag.from, dx, dy), { fields: false });
    else if (drag.mode === 'resize') setRect(resizeZone(drag.from, dx, dy), { fields: false });
    else setRect(zoneFromPoints(drag.start, p), { fields: false });
  }

  function endDrag(e, cancelled) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (cancelled) setRect(drag.from);
    else fillFields();
    try { overlayEl.releasePointerCapture(drag.id); } catch { /* already released */ }
    drag = null;
    speakValues();
  }

  // ---- keyboard on the outlined area ----

  function onRectKey(e) {
    if (!e.target.closest('[data-zone-rect]')) return;
    const move = KEY_MOVES[e.key];
    if (move) {
      e.preventDefault();
      const [dx, dy] = move.map((n) => n * KEY_STEP);
      setRect(e.shiftKey ? resizeZone(rect, dx, dy) : moveZone(rect, dx, dy));
      speakValues();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      save(rect);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close({ cancelled: true });
    }
  }

  function onPanelKey(e) {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      close({ cancelled: true });
    }
  }

  function onFieldInput(e) {
    if (!e.target.matches('input[name]')) return;
    const { zone } = readFields();
    if (zone) { rect = zone; paint(); }
  }

  async function save(zone) {
    await onSave(zone);
    announce(zone ? 'Text area saved. Only that part of the screen is read now.' : 'Using automatic text detection.');
    close({ cancelled: false, saved: zone });
  }

  function onPanelClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'zone-cancel') close({ cancelled: true });
    else if (action === 'zone-auto') save(null);
  }

  function onSubmit(e) {
    e.preventDefault();
    const { zone, errors } = readFields();
    if (!zone) { showErrors(errors); return; }
    save(zone);
  }

  // ---- open / close ----

  function openEditor(current) {
    if (open) return;
    open = true;
    saved = current && isZone(current) ? clampZone(current) : null;
    returnFocus = document.activeElement;
    renderOverlay();
    renderPanel();
    overlayEl.hidden = false;
    panelEl.hidden = false;
    setRect(saved || DEFAULT_ZONE);
    ac = new AbortController();
    const opts = { signal: ac.signal };
    overlayEl.addEventListener('pointerdown', onPointerDown, opts);
    overlayEl.addEventListener('pointermove', onPointerMove, opts);
    overlayEl.addEventListener('pointerup', (e) => endDrag(e, false), opts);
    overlayEl.addEventListener('pointercancel', (e) => endDrag(e, true), opts);
    overlayEl.addEventListener('lostpointercapture', (e) => endDrag(e, false), opts);
    overlayEl.addEventListener('keydown', onRectKey, opts);
    panelEl.addEventListener('keydown', onPanelKey, opts);
    panelEl.addEventListener('input', onFieldInput, opts);
    panelEl.addEventListener('click', onPanelClick, opts);
    panelEl.querySelector('[data-zone-form]').addEventListener('submit', onSubmit, opts);
    onOpen();
    const target = overlayEl.querySelector('[data-zone-rect]');
    if (target) target.focus({ preventScroll: true });
    // the fields and buttons sit under the game: bring them into view
    requestAnimationFrame(() => {
      if (open && typeof panelEl.scrollIntoView === 'function') panelEl.scrollIntoView({ block: 'nearest' });
    });
  }

  function close({ cancelled = true } = {}) {
    if (!open) return;
    open = false;
    drag = null;
    speakValues.cancel();
    if (ac) ac.abort();
    ac = null;
    overlayEl.hidden = true;
    panelEl.hidden = true;
    render(overlayEl, '');
    render(panelEl, '');
    onClose({ cancelled });
    if (cancelled) announce('Text area unchanged.');
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  return {
    open: openEditor,
    close,
    isOpen: () => open,
    get rect() { return { ...rect }; }
  };
}
