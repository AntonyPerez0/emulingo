// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createToolbar, BEFORE_START } from '../../src/ui/views/play/toolbar.js';
import { setBusy } from '../../src/ui/components.js';
import { createStage, aspectOf } from '../../src/ui/views/play/stage.js';

afterAll(() => new Promise((r) => setTimeout(r, 150)));

describe('toolbar', () => {
  let el;
  let actions;
  let tb;

  beforeEach(() => {
    document.body.innerHTML = '<div id="tb" role="group" aria-label="Game controls"></div>';
    el = document.getElementById('tb');
    actions = [];
    tb = createToolbar(el, { onAction: (a, e) => actions.push([a, e.detail]), zoneEditorId: 'zone-panel' });
  });

  it('names every control and starts disabled (but focusable)', () => {
    const buttons = [...el.querySelectorAll('.tb')];
    expect(buttons.map((b) => b.querySelector('.tb__label').textContent)).toEqual(
      ['Translate now', 'Pause', 'Quick save', 'Quick load', 'Text area', 'Auto-translate', 'Mute', 'Fullscreen']
    );
    for (const b of buttons) {
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.disabled).toBe(false);
    }
    expect(el.querySelector('#play-more').getAttribute('aria-label')).toBe('More game options');
    buttons[0].click();
    expect(actions).toEqual([]);
  });

  it('dispatches actions once enabled, from buttons and menu items', () => {
    tb.setEnabled(true);
    el.querySelector('.tb[data-action="translate-now"]').click();
    el.querySelector('[role="menuitem"][data-action="restart"]').click();
    expect(actions.map((a) => a[0])).toEqual(['translate-now', 'restart']);
  });

  it('marks Translate now with its shortcut, without changing its name', () => {
    const b = el.querySelector('.tb[data-action="translate-now"]');
    expect(b.getAttribute('aria-keyshortcuts')).toBe('t');
    expect(b.querySelector('kbd').getAttribute('aria-hidden')).toBe('true');
  });

  it('reflects game state in labels and pressed states', () => {
    tb.setPaused(true);
    expect(el.querySelector('.tb[data-action="pause"] .tb__label').textContent).toBe('Resume');
    tb.setMuted(true);
    expect(el.querySelector('.tb[data-action="mute"] .tb__label').textContent).toBe('Unmute');
    expect(el.querySelector('#play-more-mute span').textContent).toBe('Unmute');
    tb.setFullscreen(true);
    expect(el.querySelector('.tb[data-action="fullscreen"] .tb__label').textContent).toBe('Exit fullscreen');
    const auto = el.querySelector('.tb[data-action="auto-translate"]');
    tb.setAutoTranslate(false);
    expect(auto.getAttribute('aria-pressed')).toBe('false');
    tb.setAutoTranslate(true);
    expect(auto.getAttribute('aria-pressed')).toBe('true');
  });

  it('exposes the text-area editor as expanded/collapsed', () => {
    const zone = el.querySelector('.tb[data-action="zone"]');
    expect(zone.getAttribute('aria-controls')).toBe('zone-panel');
    tb.setZone({ open: true, custom: true });
    expect(zone.getAttribute('aria-expanded')).toBe('true');
    expect(zone.querySelector('.tb__label').textContent).toBe('Text area (custom)');
    tb.setZone({ open: false, custom: false });
    expect(zone.getAttribute('aria-expanded')).toBe('false');
  });

  it('names icon buttons with aria-label, so the tooltip never joins the name', () => {
    const pause = el.querySelector('.tb[data-action="pause"]');
    expect(pause.getAttribute('aria-label')).toBe('Pause');
    tb.setPaused(true);
    expect(pause.getAttribute('aria-label')).toBe('Resume');
    expect(pause.dataset.tooltip).toBe('Resume');
    tb.setZone({ open: false, custom: true });
    expect(el.querySelector('.tb[data-action="zone"]').getAttribute('aria-label')).toBe('Text area (custom)');
    tb.setSavedAt(Date.now());
    // the "last saved" note is visual: the name stays "Quick save"
    expect(el.querySelector('.tb[data-action="quick-save"]').getAttribute('aria-label')).toBe('Quick save');
    // Translate now has a visible label and no tooltip: named by its content
    expect(el.querySelector('.tb[data-action="translate-now"]').hasAttribute('aria-label')).toBe(false);
  });

  it('keeps More items inert until enabled, except Eject and Keyboard shortcuts', () => {
    const item = (a) => el.querySelector(`[role="menuitem"][data-action="${a}"]`);
    expect(el.querySelector('#play-more').hasAttribute('aria-disabled')).toBe(false);
    for (const a of ['restart', 'quick-save', 'game-controls', 'return-to-game']) expect(item(a).getAttribute('aria-disabled')).toBe('true');
    for (const a of BEFORE_START) expect(item(a).hasAttribute('aria-disabled')).toBe(false);
    item('restart').click();
    item('eject').click();
    expect(actions.map((x) => x[0])).toEqual(['eject']);
    tb.setEnabled(true);
    expect(item('restart').hasAttribute('aria-disabled')).toBe(false);
    tb.setEnabled(false);
    expect(item('restart').getAttribute('aria-disabled')).toBe('true');
  });

  it('shows "Reading…" on Translate now while busy', () => {
    const b = el.querySelector('.tb[data-action="translate-now"]');
    setBusy(b, true, { label: 'Reading…' });
    expect(b.querySelector('[data-label]').textContent).toBe('Reading…');
    expect(b.getAttribute('aria-busy')).toBe('true');
    setBusy(b, false);
    expect(b.querySelector('[data-label]').textContent).toBe('Translate now');
  });

  it('shows when the quick save was made', () => {
    tb.setSavedAt(Date.now() - 120000);
    expect(el.querySelector('.tb[data-action="quick-save"]').dataset.tooltip).toBe('Quick save · last saved 2 minutes ago');
  });
});

describe('stage', () => {
  let stageEl;
  let stage;
  let calls;

  beforeEach(() => {
    document.body.innerHTML = '<div class="stage" data-stage><div id="game"></div><div data-stage-overlay hidden></div></div>';
    stageEl = document.querySelector('.stage');
    calls = [];
    stage = createStage(stageEl, { onRetry: () => calls.push('retry'), onChooseAnother: () => calls.push('choose') });
  });

  it('computes the aspect ratio from dims or numbers', () => {
    expect(aspectOf({ w: 160, h: 144 })).toBeCloseTo(10 / 9, 5);
    expect(aspectOf({ w: 240, h: 160, aspect: 1.5 })).toBe(1.5);
    expect(aspectOf(0)).toBeCloseTo(10 / 9, 5);
    expect(aspectOf(null, 4 / 3)).toBeCloseTo(4 / 3, 5);
    stage.setAspect(1.5);
    expect(stageEl.style.getPropertyValue('--game-ar')).toBe('1.5');
  });

  it('shows loading with progress, then running', () => {
    stage.loading({ title: 'Starting Pokémon…' });
    expect(stageEl.dataset.state).toBe('loading');
    const overlay = stageEl.querySelector('[data-stage-overlay]');
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain('Starting Pokémon…');
    stage.progress({ phase: 'download', progress: 0.5 });
    expect(overlay.querySelector('progress').value).toBe(50);
    expect(overlay.textContent).toContain('Downloading the emulator');
    stage.running();
    expect(overlay.hidden).toBe(true);
    expect(stageEl.querySelector('#game')).not.toBe(null);
  });

  it('explains a failure and offers both ways out', () => {
    stage.error({ message: 'Couldn’t load the emulator.', detail: 'loader.js' });
    const panel = stageEl.querySelector('.stage__panel--error');
    expect(panel.textContent).toContain('Couldn’t start the game');
    expect(panel.textContent).toContain('Couldn’t load the emulator.');
    // a named group whose description is the reason; the view announces it once
    // through the shared live region, so the panel is not role=alert itself
    expect(panel.getAttribute('role')).toBe('group');
    expect(document.getElementById(panel.getAttribute('aria-describedby')).textContent).toBe('Couldn’t load the emulator.');
    expect(stageEl.querySelector('[role="alert"], [role="status"]')).toBe(null);
    stage.focusError();
    expect(document.activeElement.dataset.action).toBe('stage-retry');
    stageEl.querySelector('[data-action="stage-retry"]').click();
    stageEl.querySelector('[data-action="stage-choose"]').click();
    expect(calls).toEqual(['retry', 'choose']);
  });
});
