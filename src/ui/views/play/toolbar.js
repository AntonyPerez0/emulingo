// In-game toolbar (UX-23, 5b): Translate now · Pause · Quick save / load ·
// Text area · Auto-translate · Mute · Fullscreen · More (Restart…, Eject,
// Game controls…, Return to game, Keyboard shortcuts). Secondary controls
// are icon buttons with tooltips (their label stays the accessible name);
// when the toolbar is narrow the less used ones move into More. On a phone
// held sideways (corners mode) only Translate now, Pause, Auto-translate
// and More stay, in the two bottom corners of the game screen. Every
// control but More (and its Eject and Keyboard shortcuts) is disabled
// (aria-disabled, still focusable) until the game has started.
import { html, render } from '../../dom.js';
import { icon } from '../../icons.js';
import { menu } from '../../components.js';
import { formatRelative } from '../../format.js';

// Buttons with a tooltip are named by aria-label: browsers add CSS generated
// content (the tooltip's ::after) to a name computed from the content, so
// while the tooltip shows "Pause" would become "Pause Pause". The visible
// label of the main button doubles as .btn__label so setBusy() can swap it.
// data-keyshortcut lets the view drop aria-keyshortcuts when single-key
// shortcuts are switched off.
function tb({ action, label, iconName, kind = '', attrs = {}, tooltip = true, kbdKey = '' }) {
  const cls = ['btn', 'tb', kind].filter(Boolean).join(' ');
  const key = kbdKey ? kbdKey.toLowerCase() : null;
  return html`<button ${{
    type: 'button', class: cls, 'data-action': action, 'aria-disabled': 'true',
    'data-tooltip': tooltip ? label : null, 'aria-label': tooltip ? label : null,
    'aria-keyshortcuts': key, 'data-keyshortcut': key, ...attrs
  }}>${icon(iconName, { size: 18 })}<span class="${tooltip ? 'tb__label' : 'tb__label btn__label'}" data-label>${label}</span>${kbdKey ? html`<kbd class="tb__kbd kbd-hint" aria-hidden="true">${kbdKey}</kbd>` : ''}</button>`;
}

const SEP = html`<span class="tb-sep" aria-hidden="true"></span>`;

/** More items that work before the game has started (Eject is the way out of a load that hangs). */
export const BEFORE_START = Object.freeze(['eject', 'shortcuts']);
const ALWAYS_ON = new Set(BEFORE_START);

/**
 * createToolbar(el, { onAction(action, event, button) }) → controller
 * Actions: translate-now, pause, quick-save, quick-load, zone, auto-translate,
 * mute, fullscreen, restart, eject, game-controls, return-to-game, shortcuts.
 */
export function createToolbar(el, { onAction = () => {}, zoneEditorId = '' } = {}) {
  let enabled = false;
  let savedAt = null;
  let clock = 0;

  render(el, html`<div class="tb-group tb-group--primary">
      ${tb({ action: 'translate-now', label: 'Translate now', iconName: 'scan-text', kind: 'btn--primary tb--main', tooltip: false, kbdKey: 'T' })}
    </div>
    ${SEP}
    <div class="tb-group">
      ${tb({ action: 'pause', label: 'Pause', iconName: 'pause' })}
      ${tb({ action: 'quick-save', label: 'Quick save', iconName: 'save' })}
      ${tb({ action: 'quick-load', label: 'Quick load', iconName: 'folder-open' })}
    </div>
    ${SEP}
    <div class="tb-group tb-group--end">
      ${tb({ action: 'zone', label: 'Text area', iconName: 'crop', attrs: { 'aria-expanded': 'false', 'aria-controls': zoneEditorId || null } })}
      ${tb({ action: 'auto-translate', label: 'Auto-translate', iconName: 'eye', kind: 'tb--labelled', attrs: { 'aria-pressed': 'true', 'aria-keyshortcuts': 'p', 'data-keyshortcut': 'p' } })}
    </div>
    <span class="tb-spacer" aria-hidden="true"></span>
    <div class="tb-group">
      ${tb({ action: 'mute', label: 'Mute', iconName: 'volume-2' })}
      ${tb({ action: 'fullscreen', label: 'Fullscreen', iconName: 'maximize' })}
      ${menu({
        id: 'play-more',
        label: 'More game options',
        items: [
          { action: 'quick-save', label: 'Quick save', icon: 'save', id: 'play-more-quick-save' },
          { action: 'quick-load', label: 'Quick load', icon: 'folder-open', id: 'play-more-quick-load' },
          { action: 'mute', label: 'Mute', icon: 'volume-2', id: 'play-more-mute' },
          { action: 'fullscreen', label: 'Fullscreen', icon: 'maximize', id: 'play-more-fullscreen' },
          { action: 'zone', label: 'Text area', icon: 'crop', id: 'play-more-zone' },
          { action: 'restart', label: 'Restart…', icon: 'rotate-ccw' },
          { action: 'eject', label: 'Eject game', icon: 'eject' },
          'separator',
          { action: 'game-controls', label: 'Game controls…', icon: 'keyboard' },
          { action: 'return-to-game', label: 'Return to game', icon: 'gamepad', hint: 'G' },
          { action: 'shortcuts', label: 'Keyboard shortcuts', icon: 'help-circle', hint: '?' }
        ]
      })}
    </div>`);

  const btn = (action) => el.querySelector(`.tb[data-action="${action}"]`);
  const item = (action) => el.querySelector(`#play-more-${action}`);
  // The toolbar is as wide as the game. Until everything fits on one row,
  // these steps apply in turn: the audio and fullscreen pair moves into
  // More, Auto-translate drops its label, the save slots move too, then
  // Text area, and last Translate now drops its icon, then its visible
  // label (the label stays its name). `hidden`, not CSS, so the menu's
  // keyboard navigation skips the copies that aren't in use.
  const TIERS = [
    { actions: ['mute', 'fullscreen'] },
    { cls: 'play-toolbar--compact' },
    { actions: ['quick-save', 'quick-load'] },
    { actions: ['zone'] },
    { cls: 'play-toolbar--no-main-icon' },
    { cls: 'play-toolbar--icons' }
  ];

  // until there is a width to go by, the controls stay in the toolbar
  for (const a of TIERS.flatMap((t) => t.actions || [])) {
    const m = item(a);
    if (m) m.hidden = true;
  }

  function applyTiers(level) {
    TIERS.forEach((tier, i) => {
      const on = i < level;
      if (tier.cls) el.classList.toggle(tier.cls, on);
      for (const a of tier.actions || []) {
        const b = btn(a);
        const m = item(a);
        if (b && b.hidden !== on) b.hidden = on;
        if (m && m.hidden !== !on) m.hidden = !on;
      }
    });
  }

  // one row: the last visible control sits level with the first
  function fitsOneRow() {
    const shown = Array.from(el.children).filter((c) => c.offsetParent !== null && c.offsetWidth > 0);
    if (shown.length < 2) return true;
    const first = shown[0].getBoundingClientRect();
    const last = shown[shown.length - 1].getBoundingClientRect();
    return last.top < first.bottom - 4;
  }

  // Steps change only when the width does: wider undoes them one at a time
  // while everything still fits, narrower adds them until it does.
  let level = 0;
  let lastWidth = 0;
  let corners = false;
  function layout() {
    if (corners) return; // every step applies there, whatever the width
    const width = el.clientWidth;
    if (!width) return; // hidden: keep the last layout
    if (width > lastWidth) {
      while (level > 0) {
        applyTiers(level - 1);
        if (!fitsOneRow()) { applyTiers(level); break; }
        level--;
      }
    }
    lastWidth = width;
    while (level < TIERS.length && !fitsOneRow()) applyTiers(++level);
  }
  layout();
  // Changing the buttons resizes the toolbar: lay out in the next frame, not
  // inside the observer callback (that would loop and raise an error).
  let frame = 0;
  const relayout = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; layout(); });
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(relayout).observe(el);
  else window.addEventListener('resize', relayout);

  function setLabel(action, label, iconName) {
    const b = btn(action);
    if (b) {
      const l = b.querySelector('[data-label]');
      if (l) l.textContent = label;
      if (b.hasAttribute('aria-label')) b.setAttribute('aria-label', label);
      if (b.hasAttribute('data-tooltip') && action !== 'quick-save') b.setAttribute('data-tooltip', label);
      if (iconName) b.querySelector('.icon').outerHTML = String(icon(iconName, { size: 18 }));
    }
    const m = item(action);
    if (m) {
      const span = m.querySelector('span');
      if (span) span.textContent = label;
      if (iconName) m.querySelector('.icon').outerHTML = String(icon(iconName, { size: 16 }));
    }
  }

  function savedLabel() {
    const b = btn('quick-save');
    if (!b) return;
    const text = savedAt ? `Quick save · last saved ${formatRelative(savedAt)}` : 'Quick save';
    b.setAttribute('data-tooltip', text);
  }

  el.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target || !el.contains(target)) return;
    if (target.getAttribute('aria-disabled') === 'true') return;
    onAction(target.dataset.action, e, target);
  });

  // The More button stays usable; its other items wait for the game like
  // the buttons do.
  function setEnabled(on) {
    enabled = !!on;
    for (const b of el.querySelectorAll('.tb, [role="menuitem"]')) {
      if (enabled || ALWAYS_ON.has(b.dataset.action)) b.removeAttribute('aria-disabled');
      else b.setAttribute('aria-disabled', 'true');
    }
  }
  setEnabled(false);

  clock = setInterval(savedLabel, 30000);

  return {
    setEnabled,
    enabled: () => enabled,
    setPaused(paused) {
      setLabel('pause', paused ? 'Resume' : 'Pause', paused ? 'play' : 'pause');
    },
    setMuted(muted) {
      setLabel('mute', muted ? 'Unmute' : 'Mute', muted ? 'volume-x' : 'volume-2');
    },
    setFullscreen(on) {
      setLabel('fullscreen', on ? 'Exit fullscreen' : 'Fullscreen', on ? 'minimize' : 'maximize');
    },
    setAutoTranslate(on) {
      const b = btn('auto-translate');
      if (!b) return;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('.icon').outerHTML = String(icon(on ? 'eye' : 'eye-off', { size: 18 }));
    },
    setZone({ open = false, custom = false } = {}) {
      const b = btn('zone');
      if (!b) return;
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      b.classList.toggle('tb--active', open);
      b.classList.toggle('tb--custom', custom);
      const label = custom ? 'Text area (custom)' : 'Text area';
      const l = b.querySelector('[data-label]');
      if (l) l.textContent = label;
      if (b.hasAttribute('aria-label')) b.setAttribute('aria-label', label);
      if (b.hasAttribute('data-tooltip')) b.setAttribute('data-tooltip', label);
      const m = item('zone');
      const span = m && m.querySelector('span');
      if (span) span.textContent = label;
    },
    // Phone held sideways: four buttons in the bottom corners of the game
    // screen (Translate now and Pause left, Auto-translate and More right),
    // the rest in More. Nothing is measured, so every phone gets the same.
    setCorners(on) {
      on = !!on;
      if (on === corners) return;
      corners = on;
      el.classList.toggle('play-toolbar--corners', on);
      if (on) {
        level = TIERS.length;
        applyTiers(level);
      } else {
        // back to a full row, then the steps come back as needed
        level = 0;
        applyTiers(0);
        lastWidth = 0;
        layout();
      }
    },
    setSavedAt(ts) {
      savedAt = ts || null;
      savedLabel();
    },
    button: btn,
    // Drop a control this browser can't honour (e.g. Fullscreen on iPhone
    // Safari), so it isn't a button that does nothing. Both copies go.
    remove(action) {
      for (const node of [btn(action), item(action)]) if (node) node.remove();
    },
    focusTranslate() {
      const b = btn('translate-now');
      if (b) b.focus();
    },
    destroy() { clearInterval(clock); }
  };
}
