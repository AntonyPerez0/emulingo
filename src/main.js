import { store } from './core/store.js';
import * as tts from './core/tts.js';
import { saveRom, listRoms } from './core/rom.js';
import { switchTab } from './ui/router.js';
import { mountPlayView } from './ui/playview.js';
import { mountReviewView } from './ui/reviewview.js';
import { mountDictionaryView } from './ui/dictionaryview.js';
import { mountDeckView } from './ui/deckview.js';
import { mountSettingsView } from './ui/settingsview.js';
import { renderStatus } from './ui/components.js';
import { toast } from './ui/toast.js';

// ---- tabs ----
document.getElementById('tab-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) switchTab(btn.dataset.tab);
});

window.addEventListener('tabchange', (e) => {
  const { tab } = e.detail;
  if (tab === 'review') mountReviewView();
  else if (tab === 'dictionary') mountDictionaryView();
  else if (tab === 'deck') mountDeckView();
  else if (tab === 'settings') mountSettingsView();
});

// ---- boot ----
async function init() {
  await tts.init();
  mountPlayView();
  renderStatus(`${listRoms().length} ROM(s) stored`);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
