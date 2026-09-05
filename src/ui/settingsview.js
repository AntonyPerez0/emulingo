import { store } from '../core/store.js';
import * as tts from '../core/tts.js';
import * as ocr from '../core/ocr.js';
import { clearTranslateCache, cacheSize } from '../core/translate.js';
import { toast } from './toast.js';
import { langOptions, settingRow } from './components.js';
import { LANGUAGES } from '../core/language.js';

export function mountSettingsView() {
  const page = document.getElementById('tab-settings');
  const s = store.all();
  const voices = tts.listVoices().length;

  page.innerHTML = `
    <div class="settings-layout">
      <div class="panel">
        <h3>🌐 Languages</h3>
        ${settingRow('Game language (ROM text)', `<select id="set-source">${langOptions(s.source)}</select>`, 'The language the game text is in')}
        ${settingRow('Translate to', `<select id="set-target">${langOptions(s.target)}</select>`, 'Your language')}
        ${settingRow('TTS voice language', `<select id="set-tts-lang">${langOptions(s.ttsLang, { includeAuto: true })}</select>`, 'Auto uses your target language')}
      </div>
      <div class="panel">
        <h3>📖 Learning</h3>
        ${settingRow('Auto-add flashcards', `<input type="checkbox" id="set-auto-add" ${s.autoAdd ? 'checked' : ''}>`, 'Automatically collect every translated line')}
        ${settingRow('Auto-pronounce translations', `<input type="checkbox" id="set-auto-tts" ${s.autoTts ? 'checked' : ''}>`, 'Speak translations as they appear')}
        ${settingRow('Speech rate', `<input type="range" id="set-rate" min="0.5" max="2" step="0.05" value="${s.rate}"><span class="range-val">${s.rate}×</span>`, 'TTS playback speed')}
      </div>
      <div class="panel">
        <h3>🔍 OCR</h3>
        ${settingRow('Scan interval', `<input type="range" id="set-interval" min="600" max="4000" step="100" value="${s.ocrInterval}"><span class="range-val">${(s.ocrInterval / 1000).toFixed(1)}s</span>`, 'Lower = faster detection, more CPU')}
        ${settingRow('Stability threshold', `<input type="range" id="set-stable" min="1" max="5" step="1" value="${s.stableThreshold}"><span class="range-val">${s.stableThreshold}× </span>`, 'How many matching scans before translating')}
        ${settingRow('Min word length', `<input type="range" id="set-minlen" min="1" max="8" step="1" value="${s.minWordLen}"><span class="range-val">${s.minWordLen}</span>`, 'Ignore shorter OCR words')}
        ${settingRow('Fix OCR misreads', `<input type="checkbox" id="set-spellcheck" ${s.spellCheck ? 'checked' : ''}>`, 'Spell-correct OCR text against a real dictionary before translating (dictionary downloads once per game language)')}
        ${settingRow('History size', `<input type="range" id="set-history" min="20" max="500" step="10" value="${s.keepHistory}"><span class="range-val">${s.keepHistory}</span>`, 'Lines kept in Play history')}
      </div>
      <div class="panel">
        <h3>🎮 Emulator</h3>
        ${settingRow('Core', `<select id="set-core">
            <option value="auto" ${s.core === 'auto' ? 'selected' : ''}>Auto</option>
            <option value="gb" ${s.core === 'gb' ? 'selected' : ''}>GB / GBC</option>
            <option value="gba" ${s.core === 'gba' ? 'selected' : ''}>GBA</option>
            <option value="nes" ${s.core === 'nes' ? 'selected' : ''}>NES</option>
            <option value="snes" ${s.core === 'snes' ? 'selected' : ''}>SNES</option>
            <option value="md" ${s.core === 'md' ? 'selected' : ''}>Genesis</option>
            <option value="nds" ${s.core === 'nds' ? 'selected' : ''}>NDS</option>
          </select>`, 'Auto usually works. Force a core if a ROM misbehaves')}
        ${settingRow('Fast boot', `<input type="checkbox" id="set-fastboot" ${s.fastBoot ? 'checked' : ''}>`, 'Skip BIOS/boot sequence')}
        <div class="muted small">Gamepad and keyboard input are handled by the emulator once the game loads.</div>
      </div>
      <div class="panel">
        <h3>🗑 Data</h3>
        <div class="btn-col">
          <button class="btn" id="btn-test-tts">Test speech (voices: ${voices})</button>
          <button class="btn" id="btn-clear-cache">Clear translation cache (${cacheSize()})</button>
          <button class="btn ghost" id="btn-ocr-reset">Reset OCR worker</button>
          <button class="btn" id="btn-export-backup">Export backup (deck + dictionary + progress)</button>
          <label class="btn" style="text-align:center">Import backup<input type="file" id="import-backup" accept=".json" hidden></label>
          <button class="btn danger ghost" id="btn-wipe">Erase everything</button>
        </div>
        <p class="muted small">Everything is stored locally in your browser. No account, no server. Build ${__BUILD__}.</p>
      </div>
    </div>`;

  const bindSelect = (id, key) => page.querySelector('#' + id).addEventListener('change', (e) => {
    store.set(key, e.target.value);
    toast('Saved', 'ok', 1200);
  });
  const bindCheck = (id, key) => page.querySelector('#' + id).addEventListener('change', (e) => store.set(key, e.target.checked));
  const bindRange = (id, key, fmt) => {
    const el = page.querySelector('#' + id);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      el.parentElement.querySelector('.range-val').textContent = fmt ? fmt(v) : v;
    });
    el.addEventListener('change', () => {
      const v = parseFloat(el.value);
      store.set(key, v);
      toast('Saved', 'ok', 1000);
    });
  };

  bindSelect('set-source', 'source');
  bindSelect('set-target', 'target');
  bindSelect('set-tts-lang', 'ttsLang');
  bindCheck('set-auto-add', 'autoAdd');
  bindCheck('set-auto-tts', 'autoTts');
  bindCheck('set-spellcheck', 'spellCheck');
  bindRange('set-rate', 'rate', (v) => v + '×');
  bindRange('set-interval', 'ocrInterval', (v) => (v / 1000).toFixed(1) + 's');
  bindRange('set-stable', 'stableThreshold', (v) => v + '× ');
  bindRange('set-minlen', 'minWordLen');
  bindRange('set-history', 'keepHistory');
  bindSelect('set-core', 'core');
  bindCheck('set-fastboot', 'fastBoot');

  page.querySelector('#btn-test-tts').addEventListener('click', () => {
    const ok = tts.speak('Hallo! Willkommen bei Emulingo. Let us learn together!', store.get('ttsLang') === 'auto' ? store.get('target') : store.get('ttsLang'), store.get('rate'));
    if (!ok) toast('Speech synthesis not available in this browser', 'err');

  });
  page.querySelector('#btn-clear-cache').addEventListener('click', () => {
    clearTranslateCache();
    mountSettingsView();
    toast('Translation cache cleared', 'ok');
  });
  page.querySelector('#btn-ocr-reset').addEventListener('click', async () => {
    await ocr.terminateOcr();
    toast('OCR worker reset', 'ok');
  });
  page.querySelector('#btn-export-backup').addEventListener('click', exportBackup);
  page.querySelector('#import-backup').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importBackup(f);
    e.target.value = '';
  });
  page.querySelector('#btn-wipe').addEventListener('click', async () => {
    if (!confirm('Erase all ROMs, saves, cards, dictionary, history and settings?')) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('emulingo:')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    try {
      const { idbClear } = await import('../core/idb.js');
      await idbClear();
    } catch {}
    location.reload();
  });
}

// ---- backup / restore ----
function exportBackup() {
  const data = { version: 1, exported: new Date().toISOString() };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k.startsWith('emulingo:')) continue;
    if (k.startsWith('emulingo:romdata:')) continue; // skip raw ROM blobs
    data[k] = localStorage.getItem(k);
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'emulingo-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Backup downloaded', 'ok');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.version !== 1) throw new Error('Not an Emulingo backup');
    let restored = 0;
    for (const [k, v] of Object.entries(data)) {
      if (k === 'version' || k === 'exported') continue;
      if (!k.startsWith('emulingo:')) continue;
      localStorage.setItem(k, v);
      restored++;
    }
    toast('Restored ' + restored + ' data sets - reloading…', 'ok');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast('Invalid backup file: ' + e.message, 'err');
  }
}
