import { store } from '../core/store.js';
import { LANGUAGES, langName, langFlag } from '../core/language.js';

export function langOptions(selected, { includeAuto = false } = {}) {
  let html = '';
  if (includeAuto) html += `<option value="auto" ${selected === 'auto' ? 'selected' : ''}>🌐 Auto-detect</option>`;
  for (const l of LANGUAGES) {
    html += `<option value="${l.code}" ${selected === l.code ? 'selected' : ''}>${l.flag} ${l.name}</option>`;
  }
  return html;
}

export function settingRow(label, control, hint) {
  return `<div class="setting-row"><div class="setting-label"><div>${label}</div>${hint ? `<div class="setting-hint">${hint}</div>` : ''}</div><div class="setting-control">${control}</div></div>`;
}

export function renderStatus(text) {
  const el = document.getElementById('header-status');
  if (el) el.textContent = text;
}
