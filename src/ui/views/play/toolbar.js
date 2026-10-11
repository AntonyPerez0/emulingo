// In-game toolbar (UX-23, 5b): Translate now · Pause · Quick save / load ·
// Text area · Auto-translate · Mute · Fullscreen · More (Restart…, Eject,
// Game controls…, Return to game, Keyboard shortcuts). Secondary controls
// are icon buttons with tooltips (their label stays the accessible name);
// when the toolbar is narrow the less used ones move into More. Every
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
    <div class="tb-group">
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
  // When the toolbar is narrow, these move into More (first the audio and
  // fullscreen pair, then the save slots). `hidden`, not CSS, so the menu's
  // keyboard navigation skips the copies that aren't in use.
  const TIERS = [
    { below: 660, actions: ['mute', 'fullscreen'] },
    { below: 500, actions: ['quick-save', 'quick-load'] }
  ];

  // until there is a width to go by, the controls stay in the toolbar
  for (const a of TIERS.flatMap((t) => t.actions)) {
    const m = item(a);
    if (m) m.hidden = true;
  }

  function layout() {
    const width = el.clientWidth;
    if (!width) return; // hidden: keep the last layout
    for (const tier of TIERS) {
      const inMenu = width < tier.below;
      for (const a of tier.actions) {
        const b = btn(a);
        const m = item(a);
        if (b && b.hidden !== inMenu) b.hidden = inMenu;
        if (m && m.hidden !== !inMenu) m.hidden = !inMenu;
      }
    }
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
    },
    setSavedAt(ts) {
      savedAt = ts || null;
      savedLabel();
    },
    button: btn,
    focusTranslate() {
      const b = btn('translate-now');
      if (b) b.focus();
    },
    destroy() { clearInterval(clock); }
  };
}
