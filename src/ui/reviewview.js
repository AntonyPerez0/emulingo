import { store } from '../core/store.js';
import * as srs from '../core/srs.js';
import * as tts from '../core/tts.js';
import { toast } from './toast.js';
import { escapeHtml, shuffle } from '../core/utils.js';
import { langName } from '../core/language.js';

let session = null; // { cards, idx, again, good, easy, total }

export function mountReviewView() {
  const page = document.getElementById('tab-review');
  const due = srs.dueCards();

  if (!due.length) {
    const total = srs.totalCards();
    page.innerHTML = `
      <div class="center-panel">
        <div class="big-emoji">🎉</div>
        <h2>Nothing due right now!</h2>
        <p class="muted">${total ? 'Come back when cards are due, or keep playing to collect more words.' : 'Play a game and use "+ Flashcard" or enable auto-collect to build your deck.'}</p>
        <button class="btn primary" id="btn-cram">${total ? 'Study ahead (all ' + total + ' cards)' : 'Go to Deck'}</button>
      </div>`;
    page.querySelector('#btn-cram').addEventListener('click', () => {
      if (!total) { switchToDeck(); return; }
      startSession(srs.cards());
    });
    return;
  }
  page.innerHTML = `
    <div class="center-panel">
      <div class="big-emoji">🧠</div>
      <h2>${due.length} card${due.length === 1 ? '' : 's'} due</h2>
      <p class="muted">Review from ${langName(store.get('source'))} to ${langName(store.get('target'))}</p>
      <button class="btn primary" id="btn-start">Start review</button>
    </div>`;
  page.querySelector('#btn-start').addEventListener('click', () => startSession(due));
}

function switchToDeck() {
  document.querySelector('.tab[data-tab="deck"]').click();
}

function startSession(cards) {
  session = {
    cards: shuffle(cards),
    idx: 0,
    again: 0, good: 0, easy: 0
  };
  renderCard();
}

function renderCard() {
  const page = document.getElementById('tab-review');
  if (session.idx >= session.cards.length) return finishSession();

  const card = session.cards[session.idx];
  const src = store.get('source');
  const reveal = card._revealed;

  page.innerHTML = `
    <div class="flashcard">
      <div class="fc-progress">${session.idx + 1} / ${session.cards.length}</div>
      <div class="fc-meta tiny muted">${langName(src)} → ${langName(store.get('target'))}</div>
      <div class="fc-front">${escapeHtml(card.text)}</div>
      ${reveal ? `
        <div class="fc-divider"></div>
        <div class="fc-back" dir="${['ar','he','fa','ur'].includes(store.get('target')) ? 'rtl' : 'ltr'}">${escapeHtml(card.translation || '(no translation saved)')}</div>
        <div class="fc-actions">
          <button class="btn danger" data-q="0">Again</button>
          <button class="btn" data-q="1">Good</button>
          <button class="btn primary" data-q="3">Easy</button>
        </div>` : `
        <div class="fc-actions">
          <button class="btn ghost" id="fc-tts">🔊</button>
          <button class="btn primary" id="fc-reveal">Show answer</button>
        </div>`}
    </div>`;

  if (reveal) {
    page.querySelectorAll('[data-q]').forEach((btn) => {
      btn.addEventListener('click', () => gradeCard(card, parseInt(btn.dataset.q, 10)));
    });
  } else {
    page.querySelector('#fc-reveal').addEventListener('click', () => {
      card._revealed = true;
      renderCard();
      if (store.get('autoTts')) speakCard(card);
    });
    page.querySelector('#fc-tts').addEventListener('click', () => speakCard(card));
  }
}

function speakCard(card) {
  const lang = store.get('ttsLang') === 'auto' ? card.lang : store.get('ttsLang');
  tts.speak(card.text, lang || store.get('source'), store.get('rate'));
}

function gradeCard(card, quality) {
  const patch = srs.schedule(card, quality);
  srs.updateCard(card.id, patch);
  if (quality === 0) session.again++; else if (quality === 3) session.easy++; else session.good++;
  srs.logActivity(srs.todayKey(), 1);
  session.idx++;
  renderCard();
}

function finishSession() {
  const page = document.getElementById('tab-review');
  const total = session.again + session.good + session.easy;
  page.innerHTML = `
    <div class="center-panel">
      <div class="big-emoji">🏅</div>
      <h2>Session complete!</h2>
      <div class="result-row">
        <div class="result-chip danger">${session.again} again</div>
        <div class="result-chip">${session.good} good</div>
        <div class="result-chip primary">${session.easy} easy</div>
      </div>
      <p class="muted">${total} cards reviewed. Keep playing to learn more!</p>
      <button class="btn" id="btn-again-review">Back</button>
    </div>`;
  session = null;
  page.querySelector('#btn-again-review').addEventListener('click', mountReviewView);
}
