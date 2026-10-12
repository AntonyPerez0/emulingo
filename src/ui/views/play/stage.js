// The game stage: an aspect-ratio box per system, bound by the viewport
// height so the whole game and the toolbar fit on screen (UX-04, MISS-05),
// with explicit loading / error / saving overlays (UX-08, EMU-15).
// EmulatorJS empties #game and rewrites its inline style, so everything we
// own lives on the stage wrapper around it.
import { html, render } from '../../dom.js';
import { icon } from '../../icons.js';
import { progress, setProgress } from '../../components.js';

/** Aspect ratio of a system's picture ({ w, h } or a number) as a positive number. */
export function aspectOf(value, fallback = 10 / 9) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0.2 && value < 5) return value;
  if (value && value.w > 0 && value.h > 0) return aspectOf(value.aspect, value.w / value.h);
  return fallback;
}

/**
 * createStage(stageEl, { onRetry, onChooseAnother }) →
 *   { setAspect(ar), setTouchDock(on), docked(), setPadMetrics(m), loading({ title }),
 *     progress(p), error({ message, detail }), saving(text), running(), idle(), state() }
 */
export function createStage(stage, { onRetry = () => {}, onChooseAnother = () => {} } = {}) {
  const overlay = stage.querySelector('[data-stage-overlay]');
  let state = 'idle';

  // The controls under the game and the title above it line up with its
  // edges (.play-controls, .play__header).
  const host = stage.closest('.play') || stage.parentElement;
  if (typeof ResizeObserver === 'function' && host) {
    new ResizeObserver(() => {
      const w = stage.offsetWidth;
      if (w) host.style.setProperty('--stage-w', `${w}px`);
    }).observe(stage);
  }

  function show(markup) {
    render(overlay, markup);
    overlay.hidden = false;
  }

  function setState(next) {
    state = next;
    stage.dataset.state = next;
  }

  function loading({ title = 'Starting emulator…' } = {}) {
    setState('loading');
    show(html`<div class="stage__panel">
      <span class="spinner spinner--lg" aria-hidden="true"></span>
      <p class="stage__title" data-stage-title>${title}</p>
      <p class="stage__text">The first time, this downloads the emulator for this system. After that it starts much faster.</p>
      <div class="stage__progress" data-stage-progress>${progress({ value: null, label: 'Loading the emulator', showValue: true })}</div>
    </div>`);
  }

  const PHASES = { download: 'Downloading the emulator', unpack: 'Unpacking the emulator', prepare: 'Preparing your game', loading: 'Loading the emulator' };

  function setLoadProgress(p) {
    if (state !== 'loading' || !p) return;
    const wrap = overlay.querySelector('[data-stage-progress] .progress');
    if (!wrap) return;
    let label = PHASES[p.phase] || PHASES.loading;
    if (p.loadedBytes) label += ` · ${(p.loadedBytes / 1048576).toFixed(1)} MB`;
    setProgress(wrap, typeof p.progress === 'number' ? p.progress : null, label);
  }

  function error({ message, detail = '' } = {}) {
    setState('error');
    // announced by the caller through the shared live region (a new
    // role=alert panel is announced unreliably, and then twice)
    show(html`<div class="stage__panel stage__panel--error" role="group" aria-labelledby="play-stage-error-title" aria-describedby="play-stage-error-text">
      <div class="stage__icon" aria-hidden="true">${icon('alert-triangle', { size: 28 })}</div>
      <h3 class="stage__title" id="play-stage-error-title" tabindex="-1">Couldn’t start the game</h3>
      <p class="stage__text" id="play-stage-error-text">${message || 'The emulator couldn’t start this game.'}</p>
      ${detail ? html`<details class="disclosure stage__details"><summary class="text-sm">Technical details</summary><p class="text-sm">${detail}</p></details>` : ''}
      <div class="stage__actions">
        <button type="button" class="btn btn--primary" data-action="stage-retry">${icon('refresh-cw', { size: 18 })}<span class="btn__label">Try again</span></button>
        <button type="button" class="btn" data-action="stage-choose">${icon('folder-open', { size: 18 })}<span class="btn__label">Choose another game</span></button>
      </div>
    </div>`);
  }

  // (the caller announces it, as for errors)
  function saving(text = 'Saving your game…') {
    setState('saving');
    show(html`<div class="stage__panel">
      <span class="spinner spinner--lg" aria-hidden="true"></span>
      <p class="stage__title">${text}</p>
    </div>`);
  }

  function running() {
    setState('running');
    overlay.hidden = true;
    render(overlay, '');
  }

  function idle() {
    setState('idle');
    overlay.hidden = true;
    render(overlay, '');
  }

  overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'stage-retry') onRetry();
    else if (btn.dataset.action === 'stage-choose') onChooseAnother();
  });

  return {
    // (also on the page: the landscape phone layout sizes the picture there)
    setAspect(ar) {
      const value = String(aspectOf(ar));
      stage.style.setProperty('--game-ar', value);
      if (host && host !== stage) host.style.setProperty('--game-ar', value);
    },
    // Room under the picture for EmulatorJS's on-screen pad (touch
    // devices), so it never covers the game's text box.
    setTouchDock(on) {
      stage.classList.toggle('stage--dock', !!on);
    },
    docked: () => stage.classList.contains('stage--dock'),
    // The pad's measured clusters ({ width, shift } per side, from the view's
    // measurePad), so wider ones (Mega Drive's six buttons) stay in their
    // bars, and whether it has L/R keys (a row for them in the dock).
    setPadMetrics({ left = null, right = null, shoulders = false } = {}) {
      const set = (name, v) => {
        if (host && typeof v === 'number' && Number.isFinite(v)) host.style.setProperty(name, `${v}px`);
        else if (host) host.style.removeProperty(name);
      };
      set('--pad-l-w', left && left.width);
      set('--pad-l-shift', left && left.shift);
      set('--pad-r-w', right && right.width);
      set('--pad-r-shift', right && right.shift);
      stage.classList.toggle('stage--shoulders', !!shoulders);
    },
    loading,
    progress: setLoadProgress,
    error,
    saving,
    running,
    idle,
    state: () => state,
    focusError() {
      const t = overlay.querySelector('[data-action="stage-retry"]');
      if (t) t.focus();
    }
  };
}
