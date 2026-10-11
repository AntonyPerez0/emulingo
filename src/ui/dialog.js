// Modal dialogs on native <dialog>.showModal(): the browser traps focus and
// makes the page inert; we add Escape/backdrop dismissal, initial focus and
// focus return to the control that opened the dialog.
import { html, render, toElement, uid, SafeHtml, isFocusable } from './dom.js';
import { icon } from './icons.js';

let openCount = 0;

function setScrollLock(delta) {
  const root = document.documentElement;
  if (delta > 0 && openCount === 0) {
    const scrollbar = Math.max(0, window.innerWidth - root.clientWidth);
    root.style.setProperty('--scrollbar-comp', `${scrollbar}px`);
  }
  openCount = Math.max(0, openCount + delta);
  root.classList.toggle('has-modal', openCount > 0);
  if (openCount === 0) root.style.removeProperty('--scrollbar-comp');
}

function canFocus(el) {
  if (!el || !el.isConnected || typeof el.focus !== 'function') return false;
  if (el.disabled || el.closest('[hidden], [inert]')) return false;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
  return true;
}

function returnFocusTo(candidates) {
  for (const el of candidates) {
    if (!canFocus(el)) continue;
    el.focus();
    if (document.activeElement === el) return;
  }
  // The opener is gone (e.g. a menu item that closed): fall back to the view heading.
  const view = document.querySelector('section[data-view]:not([hidden])') || document.getElementById('main');
  const h = view && (view.querySelector('h1') || view);
  if (h) {
    if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }
}

function fillBody(body, content) {
  if (content == null) return;
  if (content instanceof SafeHtml) render(body, content);
  else if (typeof Node !== 'undefined' && content instanceof Node) body.append(content);
  else render(body, html`<p class="dialog__text">${content}</p>`);
}

const KIND_CLASS = { primary: 'btn--primary', secondary: '', ghost: 'btn--ghost', danger: 'btn--danger', 'danger-ghost': 'btn--danger-ghost' };

/**
 * openDialog({ title, content, actions, size, dismissible, closeButton, describedBy, returnFocus, onClose })
 *   content: a node, an html`` template or plain text
 *   actions: [{ label, kind:'primary'|'secondary'|'ghost'|'danger', value, onClick({ close, el, event }), autofocus, disabled, id, icon }]
 *            onClick may return false (or a promise of false) to keep the dialog open.
 * → { el, close(value), closed: Promise<value> }
 */
export function openDialog(options = {}, extra = {}) {
  // Also accept openDialog(content, { title, … }) (DESIGN §5 wording).
  const isContent = (v) => v instanceof SafeHtml || typeof v === 'string' || (typeof Node !== 'undefined' && v instanceof Node);
  const opts = isContent(options) ? { ...extra, content: options } : (options || {});
  const {
    title,
    content,
    actions = [{ label: 'Close', kind: 'primary' }],
    size = 'md',
    dismissible = true,
    closeButton = true,
    describedBy = null,
    returnFocus = null,
    onClose = null,
  } = opts;
  const id = uid('dialog');
  const opener = document.activeElement;
  const el = toElement(html`<dialog class="dialog ${size === 'wide' ? 'dialog--wide' : ''}" aria-labelledby="${id}-title" ${describedBy ? { 'aria-describedby': describedBy } : ''}>
    <div class="dialog__header">
      <h2 class="dialog__title" id="${id}-title">${title}</h2>
      ${closeButton && dismissible ? html`<button type="button" class="icon-btn dialog__close" data-dialog-close aria-label="Close">${icon('x')}</button>` : ''}
    </div>
    <div class="dialog__body" id="${id}-body"></div>
    ${actions && actions.length ? html`<div class="dialog__footer">${actions.map((a, i) => html`<button type="button" ${{
      class: ['btn', KIND_CLASS[a.kind || 'secondary'] || ''].filter(Boolean).join(' '),
      'data-action-index': i,
      id: a.id || null,
      disabled: !!a.disabled,
      'data-autofocus': a.autofocus ? '' : null,
    }}>${a.icon ? icon(a.icon) : ''}<span>${a.label}</span></button>`)}</div>` : ''}
    <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-live="polite"></div>
    <div class="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true" data-live="assertive"></div>
  </dialog>`);
  const body = el.querySelector('.dialog__body');
  fillBody(body, content);

  let settled = false;
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  let result;

  const finish = () => {
    if (settled) return;
    settled = true;
    setScrollLock(-1);
    el.remove();
    returnFocusTo([returnFocus, opener]);
    try { if (onClose) onClose(result); } finally { resolveClosed(result); }
  };

  const close = (value) => {
    if (settled) return;
    result = value;
    if (el.open && typeof el.close === 'function') el.close();
    finish();
  };

  el.addEventListener('close', finish);
  el.addEventListener('cancel', (e) => {
    // Escape: dismiss unless the dialog insists on an explicit choice.
    e.preventDefault();
    if (dismissible) close(undefined);
  });
  // Some browsers do not fire 'cancel' for Escape when nothing inside has focus.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      if (dismissible) close(undefined);
    }
  });

  // Backdrop click (the press must start and end on the backdrop, so text selection drags don't close it).
  let downOnBackdrop = false;
  el.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === el; });
  el.addEventListener('click', (e) => {
    if (dismissible && downOnBackdrop && e.target === el) close(undefined);
    downOnBackdrop = false;
  });

  // A double click on an async action (Import, Save…) must not run it twice.
  let running = false;
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || !el.contains(t)) return;
    if (t.hasAttribute('data-dialog-close')) { close(undefined); return; }
    const idx = t.getAttribute('data-action-index');
    if (idx == null) return;
    const a = actions[Number(idx)];
    if (!a || t.disabled || t.getAttribute('aria-disabled') === 'true') return;
    let keep = false;
    if (typeof a.onClick === 'function') {
      // Plain actions such as Cancel still close while another action is busy.
      if (running) return;
      running = true;
      t.setAttribute('aria-busy', 'true');
      try {
        keep = (await a.onClick({ close, el, event: e })) === false;
      } catch (err) {
        console.error(err);
        keep = true;
      } finally {
        running = false;
        t.removeAttribute('aria-busy');
      }
    }
    if (!keep) close(a.value !== undefined ? a.value : a.label);
  });

  document.body.appendChild(el);
  setScrollLock(1);
  if (typeof el.showModal === 'function') el.showModal();
  else el.setAttribute('open', '');

  // Initial focus: explicit autofocus, else the first field in the body, else the primary action, else Close.
  const initial = el.querySelector('[autofocus], [data-autofocus]')
    || Array.from(body.querySelectorAll('input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])')).find(isFocusable)
    || el.querySelector('.dialog__footer .btn--primary, .dialog__footer .btn--danger')
    || el.querySelector('[data-dialog-close]')
    || el.querySelector('.dialog__footer button');
  if (initial) initial.focus();

  return { el, close, closed };
}

/**
 * confirmDialog({ title, body, confirmLabel, cancelLabel, danger, requireText }) → Promise<boolean>
 * Focus starts on Cancel (never on the destructive button). With requireText
 * (e.g. 'ERASE') the confirm button stays disabled until it is typed.
 */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, requireText = '' } = {}) {
  const inputId = uid('confirm-text');
  const textId = uid('confirm-desc');
  const confirmId = uid('confirm-ok');
  const bodyNode = typeof Node !== 'undefined' && body instanceof Node ? body : null;
  const content = html`
    ${body != null && body !== '' && !bodyNode ? (body instanceof SafeHtml ? html`<div id="${textId}" class="dialog__text">${body}</div>` : html`<p id="${textId}" class="dialog__text">${body}</p>`) : ''}
    ${requireText ? html`<div class="field">
      <label class="field__label" for="${inputId}">Type <strong>${requireText}</strong> to confirm</label>
      <input class="input" id="${inputId}" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" data-autofocus>
    </div>` : ''}`;

  const matches = (v) => v.trim().toLowerCase() === String(requireText).trim().toLowerCase();

  const dlg = openDialog({
    title,
    content,
    closeButton: false,
    describedBy: body != null && body !== '' ? textId : null,
    actions: [
      { label: cancelLabel, kind: 'secondary', value: false, autofocus: !requireText },
      { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true, disabled: !!requireText, id: confirmId },
    ],
  });

  if (bodyNode) {
    const wrap = document.createElement('div');
    wrap.id = textId;
    wrap.className = 'dialog__text';
    wrap.append(bodyNode);
    dlg.el.querySelector('.dialog__body').prepend(wrap);
  }

  if (requireText) {
    const input = dlg.el.querySelector(`#${inputId}`);
    const ok = dlg.el.querySelector(`#${confirmId}`);
    input.addEventListener('input', () => { ok.disabled = !matches(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && matches(input.value)) {
        e.preventDefault();
        dlg.close(true);
      }
    });
  }
  return dlg.closed.then((v) => v === true);
}
