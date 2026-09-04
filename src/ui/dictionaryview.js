import { store } from '../core/store.js';
import * as dict from '../core/dictionary.js';
import * as srs from '../core/srs.js';
import * as tts from '../core/tts.js';
import { toast } from './toast.js';
import { escapeHtml, timeAgo } from '../core/utils.js';
import { langName } from '../core/language.js';

let query = '';
let kindFilter = 'all';

export function mountDictionaryView() {
  const page = document.getElementById('tab-dictionary');
  const st = dict.stats();
  const results = dict.search(query, kindFilter);

  page.innerHTML = `
    <div class="dict-layout">
      <div class="panel dict-side">
        <h3>📖 Dictionary</h3>
        <div class="stat-row"><span class="stat-num">${st.total}</span><span class="stat-label">entries seen</span></div>
        <div class="stat-row"><span class="stat-num">${st.words}</span><span class="stat-label">words</span></div>
        <div class="stat-row"><span class="stat-num">${st.lines}</span><span class="stat-label">sentences</span></div>
        <div class="stat-row"><span class="stat-num">${st.translated}</span><span class="stat-label">translated</span></div>
        <p class="muted small">Words and lines captured while playing ${langName(store.get('source'))} games, translated to ${langName(store.get('target'))}. Tap untranslated words to look them up.</p>
        <button class="btn small" id="btn-translate-pending">Translate new words (up to 20)</button>
        <button class="btn small ghost" id="btn-clear-dict">Clear dictionary</button>
      </div>
      <div class="dict-main">
        <div class="deck-toolbar">
          <input type="text" id="dict-search" placeholder="Search word or translation…" value="${escapeHtml(query)}" />
          <div class="seg">
            <button class="seg-btn ${kindFilter === 'all' ? 'active' : ''}" data-f="all">All</button>
            <button class="seg-btn ${kindFilter === 'word' ? 'active' : ''}" data-f="word">Words</button>
            <button class="seg-btn ${kindFilter === 'line' ? 'active' : ''}" data-f="line">Sentences</button>
          </div>
          <span class="muted small">${results.length} shown</span>
        </div>
        <div class="deck-list" id="dict-list">
          ${results.length ? results.map((e) => dictRow(e)).join('') : '<p class="muted">Nothing here yet. Play a game - everything you see lands in the dictionary.</p>'}
        </div>
      </div>
    </div>`;

  const searchEl = page.querySelector('#dict-search');
  let deb = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { query = searchEl.value; renderListOnly(); }, 200);
  });
  page.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    kindFilter = b.dataset.f;
    mountDictionaryView();
  }));
  page.querySelector('#btn-translate-pending').addEventListener('click', translatePending);
  page.querySelector('#btn-clear-dict').addEventListener('click', () => {
    if (confirm('Clear the whole dictionary? Flashcards are not affected.')) {
      dict.clearAll();
      mountDictionaryView();
      toast('Dictionary cleared', 'info');
    }
  });
  bindRowActions(page);
}

function dictRow(e) {
  const tgtDir = ['ar', 'he', 'fa', 'ur'].includes(e.tgt || store.get('target')) ? 'rtl' : 'ltr';
  const kindBadge = e.kind === 'line' ? '<span class="kind-badge line">sentence</span>' : '<span class="kind-badge">word</span>';
  const pending = !e.translation;
  return `
    <div class="deck-row dict-row ${pending ? 'pending' : ''}" data-id="${e.id}">
      <div class="deck-row-main">
        <div class="dr-orig">${escapeHtml(e.text)} ${kindBadge}</div>
        <div class="dr-trans muted" dir="${tgtDir}">${pending ? '<em class="muted">tap to translate</em>' : escapeHtml(e.translation)}</div>
      </div>
      <div class="deck-row-meta">
        <span class="tiny muted">seen ${e.count}× · ${timeAgo(e.lastSeen)}</span>
        <span class="row-actions">
          ${e.translation ? `<button class="icon-btn" data-speak="${e.id}" title="Speak">🔊</button>` : ''}
          ${e.translation ? `<button class="icon-btn" data-card="${e.id}" title="Add to flashcards">🃏</button>` : ''}
          <button class="icon-btn" data-del="${e.id}" title="Delete">🗑</button>
        </span>
      </div>
    </div>`;
}

function bindRowActions(page) {
  page.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    dict.removeEntry(b.dataset.del);
    mountDictionaryView();
    toast('Removed', 'info', 1200);
  }));
  page.querySelectorAll('[data-speak]').forEach((b) => b.addEventListener('click', () => {
    const e = dict.entries().find((x) => x.id === b.dataset.speak);
    if (!e) return;
    tts.speak(e.translation || e.text, store.get('ttsLang') === 'auto' ? (e.tgt || store.get('target')) : store.get('ttsLang'), store.get('rate'));
  }));
  page.querySelectorAll('[data-card]').forEach((b) => b.addEventListener('click', () => {
    const e = dict.entries().find((x) => x.id === b.dataset.card);
    if (!e || !e.translation) return;
    const c = srs.addCard(e.text, e.lang || store.get('source'), e.translation);
    srs.logActivity(srs.todayKey(), 1);
    toast(c ? 'Flashcard added' : 'Already in your deck', c ? 'ok' : 'info', 1500);
  }));
  // pending rows: click anywhere to translate on demand
  page.querySelectorAll('.dict-row.pending').forEach((row) => {
    row.addEventListener('click', async () => {
      const id = row.dataset ? row.querySelector('[data-del]').dataset.del : null;
      const e = dict.entries().find((x) => x.id === id);
      if (!e) return;
      const transEl = row.querySelector('.dr-trans');
      transEl.innerHTML = '<div class="spinner"></div>';
      try {
        const tr = await dict.lookup(e.text, e.lang, e.tgt || store.get('target'));
        dict.setTranslation(id, tr ? tr.translation : '');
        if (tr && tr.translation) toast('"' + tr.text + '" → ' + tr.translation, 'ok', 2200);
        else toast('No translation found', 'err', 2000);
      } catch {
        transEl.innerHTML = '<em class="muted">lookup failed - try again</em>';
        return;
      }
      renderListOnly();
    });
  });
}

function renderListOnly() {
  const page = document.getElementById('tab-dictionary');
  const results = dict.search(query, kindFilter);
  const listEl = page.querySelector('#dict-list');
  const countEl = page.querySelector('.deck-toolbar .muted');
  if (countEl) countEl.textContent = results.length + ' shown';
  listEl.innerHTML = results.length ? results.map((e) => dictRow(e)).join('') : '<p class="muted">No matches.</p>';
  bindRowActions(page);
}

async function translatePending() {
  const pending = dict.entries().filter((e) => e.kind === 'word' && !e.translation).slice(0, 20);
  if (!pending.length) return toast('No untranslated words', 'info');
  toast('Translating ' + pending.length + ' words…', 'info', 1800);
  let done = 0;
  for (const e of pending) {
    try {
      const tr = await dict.lookup(e.text, e.lang, e.tgt || store.get('target'));
      if (tr && tr.translation) { dict.setTranslation(e.id, tr.translation); done++; }
    } catch { break; }
  }
  toast(done + ' words translated', 'ok');
  mountDictionaryView();
}
