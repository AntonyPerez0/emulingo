// Game library: the ROMs stored on this device plus the drop zone.
// Loading a game works without a mouse: "Choose ROM file" is a real button
// for the hidden file input (UX-02, PLAY-13); the whole zone also accepts a
// click or a dropped file, and its highlight doesn't flicker over children.
// Delete lives in each card's overflow menu and asks first, saying that the
// save state and in-game saves go too (A11Y-19, EMU-13).
import { html, render, rerender } from '../../dom.js';
import { icon } from '../../icons.js';
import { announce } from '../../a11y.js';
import { toast } from '../../toast.js';
import { confirmDialog, openDialog } from '../../dialog.js';
import { menu, badge, setBusy, selectField } from '../../components.js';
import { formatBytes, formatRelative, formatCount } from '../../format.js';
import * as rom from '../../../core/rom.js';
import { idbDel } from '../../../core/idb.js';

const SYSTEM_NAMES = 'Game Boy, Game Boy Color, Game Boy Advance, NES, SNES, Mega Drive and more';

/** Most recently played (or added) first. */
export function sortRoms(list) {
  return [...list].sort((a, b) => (b.lastPlayed || b.added || 0) - (a.lastPlayed || a.added || 0));
}

// Loaded on demand: most imports have no restored saves waiting. Never
// rejects (a failure only leaves the saves waiting for the next import).
async function relinkRestoredSaves(record) {
  try {
    const { relinkSaves } = await import('../../../core/backup.js');
    return await relinkSaves(record);
  } catch (err) {
    console.warn('[play] restored saves not linked', err);
    return 0;
  }
}

function systemShort(core) {
  const s = rom.systemFor(core);
  return s ? s.short : 'Game';
}

/** Ask which console a game is for (archives and unknown files). Resolves a core or null. */
export function askSystem(name) {
  const id = 'play-system-choice';
  const options = rom.SYSTEMS.map((s) => ({ value: s.core, label: s.name }));
  const dlg = openDialog({
    title: 'Which system is this game for?',
    content: html`<p class="dialog__text">Emulingo can’t tell which console “${name}” is for. Choose it, and the game is remembered with that system.</p>
      ${selectField({ id, label: 'System', options, value: 'gb' })}`,
    actions: [
      { label: 'Cancel', kind: 'secondary', value: null },
      { label: 'Use this system', kind: 'primary', onClick: ({ close, el }) => { close(el.querySelector(`#${id}`).value); return false; } }
    ]
  });
  return dlg.closed.then((v) => v || null);
}

/**
 * createLibrary(section, { onPlay(record, bytes|null), beforeImport() }) →
 *   { refresh(), focusChooser(), setBusy(on), roms() }
 */
export function createLibrary(section, { onPlay = () => {}, beforeImport = () => {} } = {}) {
  let roms = [];
  let busy = false;
  let loaded = false;

  section.setAttribute('aria-labelledby', 'play-library-title');
  render(section, html`<div class="library__head">
      <h2 class="library__title" id="play-library-title">Your games</h2>
      <p class="library__count text-sm text-muted" data-count></p>
    </div>
    <div class="library__grid" data-grid>
      <div class="library__list" data-list></div>
      <div class="dropzone" data-dropzone>
        <div class="dropzone__icon" aria-hidden="true">${icon('upload', { size: 28 })}</div>
        <h2 class="dropzone__title" id="play-drop-title">Load a game you own</h2>
        <p class="dropzone__text" id="play-drop-desc">Choose a ROM file or drop it here. Works with ${SYSTEM_NAMES}.</p>
        <button type="button" class="btn btn--primary btn--lg" data-action="choose-rom" aria-describedby="play-drop-desc play-drop-privacy">${icon('folder-open')}<span class="btn__label">Choose ROM file</span></button>
        <input type="file" data-rom-input hidden tabindex="-1" accept="${rom.acceptAttr()}">
        <p class="dropzone__privacy text-sm text-muted" id="play-drop-privacy">${icon('shield', { size: 16 })}<span>Your game stays on this device. Nothing is uploaded.</span></p>
        <p class="dropzone__error" id="play-drop-error" data-drop-error hidden></p>
      </div>
    </div>`);

  const listEl = section.querySelector('[data-list]');
  const zone = section.querySelector('[data-dropzone]');
  const input = section.querySelector('[data-rom-input]');
  const chooseBtn = section.querySelector('[data-action="choose-rom"]');
  const errorEl = section.querySelector('[data-drop-error]');
  const countEl = section.querySelector('[data-count]');

  // ---- list --------------------------------------------------------------------

  function card(r, i) {
    const title = r.title || r.name;
    const played = r.lastPlayed ? `Played ${formatRelative(r.lastPlayed)}` : 'Not played yet';
    return html`<li class="rom-card" data-key="${r.id}">
      <div class="rom-card__art" aria-hidden="true">${icon('gamepad', { size: 22 })}</div>
      <div class="rom-card__main">
        <h3 class="rom-card__title">${title}</h3>
        <p class="rom-card__meta">
          ${badge(systemShort(r.core), 'neutral')}
          ${r.size ? html`<span>${formatBytes(r.size)}</span><span aria-hidden="true">·</span>` : ''}
          <span>${played}</span>
        </p>
      </div>
      <div class="rom-card__actions">
        <button type="button" class="btn btn--primary" data-action="play" aria-label="Play ${title}">${icon('play', { size: 18 })}<span class="btn__label">Play</span></button>
        ${menu({ id: `play-rom-${i}`, label: `More options for ${title}`, items: [{ action: 'delete-rom', label: 'Delete…', icon: 'trash-2', danger: true }] })}
      </div>
    </li>`;
  }

  function draw() {
    section.classList.toggle('library--empty', !roms.length);
    countEl.textContent = roms.length ? formatCount(roms.length, 'game') : '';
    render(listEl, roms.length ? html`<ul class="rom-list" role="list">${roms.map(card)}</ul>` : '');
    chooseBtn.classList.toggle('btn--primary', !roms.length);
  }

  async function refresh() {
    try {
      roms = sortRoms(await rom.listRoms());
    } catch (err) {
      console.warn('[play] could not list games', err);
      roms = [];
    }
    loaded = true;
    rerender(section, draw);
    return roms;
  }

  // ---- importing ---------------------------------------------------------------

  // Announced through the shared live region by the caller, and tied to the
  // button so it is read again when the player comes back to it.
  const DESCRIBED_BY = 'play-drop-desc play-drop-privacy';

  function showError(message) {
    render(errorEl, html`${icon('alert-circle', { size: 16 })}<span>${message}</span>`);
    errorEl.hidden = false;
    chooseBtn.setAttribute('aria-describedby', `${DESCRIBED_BY} play-drop-error`);
  }

  function clearError() {
    errorEl.hidden = true;
    render(errorEl, '');
    chooseBtn.setAttribute('aria-describedby', DESCRIBED_BY);
  }

  function setImporting(on) {
    busy = on;
    setBusy(chooseBtn, on, { label: 'Reading file…' });
    zone.classList.toggle('dropzone--busy', on);
  }

  async function importFile(file, core = null) {
    if (!file || busy) return;
    clearError();
    beforeImport();
    setImporting(true);
    let res;
    try {
      res = await rom.importRomFile(file, { core });
    } catch (err) {
      setImporting(false);
      if (err && err.code === 'needs-system') {
        const chosen = await askSystem(file.name || 'this file');
        if (chosen) await importFile(file, chosen);
        return;
      }
      const message = (err && err.name === 'RomError' && err.message) || 'Couldn’t load this file. Try choosing it again.';
      showError(message);
      announce(message, { assertive: true });
      return;
    }
    // Game saves restored from a backup before this game was added wait for
    // it; they must be in place before the emulator reads them at start.
    const relinked = res.persisted ? await relinkRestoredSaves(res.rom) : 0;
    setImporting(false);
    const title = res.rom.title || res.rom.name;
    if (res.duplicate) toast(`“${title}” is already in your library.`, { kind: 'info' });
    if (relinked) toast(`Restored ${formatCount(relinked, 'game save')} from your backup.`, { kind: 'success' });
    if (res.warnings.includes('not-saved')) {
      toast(res.warnings.includes('storage-full')
        ? 'Your device is out of space, so this game is only kept until you close the page.'
        : 'This browser isn’t letting Emulingo store games, so this one is only kept until you close the page.', { kind: 'warning' });
    } else if (res.warnings.includes('large')) {
      toast('This is a large game, so it may take a while to start.', { kind: 'info' });
    }
    await refresh();
    onPlay(res.rom, res.bytes);
  }

  // ---- deleting ------------------------------------------------------------------

  async function deleteGame(id) {
    const r = roms.find((x) => x.id === id);
    if (!r) return;
    const title = r.title || r.name;
    const ok = await confirmDialog({
      title: `Delete “${title}”?`,
      body: 'This removes the game from this device, together with its save state and in-game saves. It can’t be undone.',
      confirmLabel: 'Delete game',
      danger: true
    });
    if (!ok) return;
    try {
      await rom.deleteRom(id);
      idbDel('zone:' + id).catch(() => {});
    } catch (err) {
      console.error('[play] delete failed', err);
      toast('Couldn’t delete the game. Try again.', { kind: 'error' });
      return;
    }
    await refresh();
    toast(`Deleted “${title}”.`, { kind: 'success' });
    // the menu button that opened the dialog is gone: rerender moved focus to the next card
    if (!section.contains(document.activeElement)) chooseBtn.focus();
  }

  // ---- events ----------------------------------------------------------------------

  section.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const key = btn.closest('[data-key]') ? btn.closest('[data-key]').dataset.key : null;
      if (btn.dataset.action === 'choose-rom') {
        if (!busy) input.click();
      } else if (btn.dataset.action === 'play' && key) {
        const r = roms.find((x) => x.id === key);
        if (r) onPlay(r, null);
      } else if (btn.dataset.action === 'delete-rom' && key) {
        deleteGame(key);
      }
      return;
    }
    // the rest of the drop zone opens the file chooser for mouse users
    if (e.target.closest('[data-dropzone]') && !e.target.closest('a, button, input')) {
      if (!busy) input.click();
    }
  });

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) importFile(file);
  });

  // Drag highlight: only leaving the zone itself (not moving over a child) clears it.
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  zone.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    zone.classList.add('dropzone--over');
  });
  zone.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('dropzone--over');
  });
  zone.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
    zone.classList.remove('dropzone--over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dropzone--over');
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (files.length > 1) toast('Drop one game at a time. Loading the first one.', { kind: 'info' });
    if (files[0]) importFile(files[0]);
  });

  return {
    refresh,
    focusChooser: () => chooseBtn.focus(),
    setBusy: setImporting,
    roms: () => roms,
    isLoaded: () => loaded,
    importFile
  };
}
