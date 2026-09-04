import { store } from '../core/store.js';
import * as srs from '../core/srs.js';
import * as tts from '../core/tts.js';
import { toast } from './toast.js';
import { escapeHtml, timeAgo } from '../core/utils.js';
import { langName } from '../core/language.js';

let filter = 'all';

export function mountDeckView() {
  const page = document.getElementById('tab-deck');
  const all = srs.cards();

  const filtered = all.filter((c) => {
    if (filter === 'due') return c.due <= Date.now();
    if (filter === 'suspended') return c.suspended;
    return true;
  });

  const due = srs.dueCount();
  const total = all.length;
  const mature = srs.matureCards();

  page.innerHTML = `
    <div class="deck-layout">
      <div class="deck-stats panel">
        <h3>Deck stats</h3>
        <div class="stat-row"><span class="stat-num">${total}</span><span class="stat-label">total cards</span></div>
        <div class="stat-row"><span class="stat-num">${due}</span><span class="stat-label">due now</span></div>
        <div class="stat-row"><span class="stat-num">${mature}</span><span class="stat-label">mature (21d+)</span></div>
        <div class="week-chart" id="week-chart">${weekChartHtml()}</div>
      </div>
      <div class="deck-main">
        <div class="deck-toolbar">
          <div class="seg">
            <button class="seg-btn ${filter === 'all' ? 'active' : ''}" data-f="all">All</button>
            <button class="seg-btn ${filter === 'due' ? 'active' : ''}" data-f="due">Due</button>
          </div>
          <span class="muted small">${filtered.length} shown</span>
          <span class="spacer"></span>
          <button class="btn small ghost" id="btn-export">Export CSV</button>
          <button class="btn small danger ghost" id="btn-clear-deck">Clear deck</button>
        </div>
        <div class="deck-list">
          ${filtered.length ? filtered.map((c) => deckRow(c)).join('') : '<p class="muted">No cards yet. Play a game and collect words!</p>'}
        </div>
      </div>
    </div>`;

  page.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; mountDeckView(); }));
  page.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    srs.removeCard(b.dataset.del);
    mountDeckView();
    toast('Card removed', 'info', 1400);
  }));
  page.querySelectorAll('[data-speak]').forEach((b) => b.addEventListener('click', () => {
    const card = all.find((c) => c.id === b.dataset.speak);
    if (card) tts.speak(card.translation || card.text, store.get('ttsLang') === 'auto' ? store.get('target') : store.get('ttsLang'), store.get('rate'));
  }));
  page.querySelector('#btn-export').addEventListener('click', exportCsv);
  page.querySelector('#btn-clear-deck').addEventListener('click', () => {
    if (confirm('Delete ALL cards? This cannot be undone.')) {
      srs.saveCards([]);
      mountDeckView();
      toast('Deck cleared', 'info');
    }
  });
}

function deckRow(c) {
  const dueIn = c.due - Date.now();
  const dueText = dueIn <= 0 ? '<span class="due-badge">due</span>' : 'in ' + humanize(dueIn);
  return `
    <div class="deck-row">
      <div class="deck-row-main">
        <div class="dr-orig">${escapeHtml(c.text)}</div>
        <div class="dr-trans muted" dir="${['ar','he','fa','ur'].includes(store.get('target')) ? 'rtl' : 'ltr'}">${escapeHtml(c.translation || '')}</div>
      </div>
      <div class="deck-row-meta">
        <span class="tiny muted">interval ${humanize(c.interval)} · ease ${c.ease.toFixed(2)} · seen ${c.seen || 0}×</span>
        <span class="tiny">${dueText}</span>
        <span class="row-actions">
          <button class="icon-btn" data-speak="${c.id}" title="Speak">🔊</button>
          <button class="icon-btn" data-del="${c.id}" title="Delete">🗑</button>
        </span>
      </div>
    </div>`;
}

function humanize(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h';
  return Math.round(ms / 86400000) + 'd';
}

function weekChartHtml() {
  const stats = srs.weekStats();
  const max = Math.max(1, ...stats.map((s) => s.count));
  return stats.map((s) => `
    <div class="week-col" title="${s.key}: ${s.count} cards">
      <div class="week-bar" style="height:${Math.max(4, (s.count / max) * 64)}px"></div>
      <span class="tiny muted">${s.day[0]}</span>
    </div>`).join('');
}

function exportCsv() {
  const cards = srs.cards();
  if (!cards.length) return toast('Nothing to export', 'err');
  const rows = [['front', 'back', 'lang', 'added', 'due', 'ease', 'interval_minutes']];
  for (const c of cards) {
    rows.push([c.text, c.translation || '', c.lang, new Date(c.added).toISOString(), new Date(c.due).toISOString(), c.ease, Math.round(c.interval / 60000)]);
  }
  const csv = rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'emulingo-deck.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
