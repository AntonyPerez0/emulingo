// Spaced-repetition: SM-2 inspired scheduler + localStorage persistence + stats.

import { load, save } from './localStorage.js';

const CARDS = 'cards';
const LOG = 'activitylog';
const STREAK = 'streak';

export function cards() { return load(CARDS, []); }

export function saveCards(list) { save(CARDS, list); }

export function findCard(text, lang) {
  return cards().find((c) => c.text === text && c.lang === lang) || null;
}

export function addCard(text, lang, translation) {
  const list = cards();
  if (list.some((c) => c.text === text && c.lang === lang)) return null;
  const card = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    text, lang, translation,
    ease: 2.5, interval: 0, reps: 0, lapses: 0,
    due: Date.now(), added: Date.now(),
    lastResult: null, seen: 0
  };
  list.unshift(card);
  saveCards(list);
  return card;
}

export function removeCard(id) {
  saveCards(cards().filter((c) => c.id !== id));
}

export function updateCard(id, patch) {
  const list = cards().map((c) => (c.id === id ? { ...c, ...patch } : c));
  saveCards(list);
  return list.find((c) => c.id === id);
}

// SM-2-ish. quality: 0 (fail) .. 3 (easy)
export function schedule(card, quality) {
  let { ease, interval, reps, lapses } = card;
  if (quality === 0) {
    lapses += 1;
    reps = 0;
    interval = 10 * 60 * 1000; // 10 minutes
    ease = Math.max(1.3, ease - 0.2);
  } else {
    if (reps === 0) interval = quality === 3 ? 2 * 86400000 : 86400000;
    else if (reps === 1) interval = quality === 3 ? 5 * 86400000 : 3 * 86400000;
    else interval = Math.round(interval * ease);
    if (quality === 3) ease += 0.1; else ease = Math.max(1.3, ease - 0.05);
    reps += 1;
    interval = Math.min(interval, 180 * 86400000);
  }
  return { ease, interval, reps, lapses, due: Date.now() + interval, lastResult: quality, seen: (card.seen || 0) + 1 };
}

export function dueCards() {
  const now = Date.now();
  return cards().filter((c) => c.due <= now);
}

export function dueCount() {
  return dueCards().length;
}

export function totalCards() {
  return cards().length;
}

export function matureCards() {
  return cards().filter((c) => c.interval >= 21 * 86400000).length;
}

// ---- activity log / stats ----
export function logActivity(day, count) {
  const log = load(LOG, {});
  log[day] = (log[day] || 0) + count;
  const keys = Object.keys(log).sort();
  if (keys.length > 400) { for (const k of keys.slice(0, 100)) delete log[k]; }
  save(LOG, log);
  updateStreak();
}

export function activityLog() { return load(LOG, {}); }

export function todayCount() {
  return activityLog()[todayKey()] || 0;
}

export function todayKey() { return new Date().toISOString().slice(0, 10); }

function updateStreak() {
  const log = activityLog();
  let streak = 0;
  const d = new Date();
  for (;;) {
    const key = d.toISOString().slice(0, 10);
    if ((log[key] || 0) > 0) { streak++; d.setDate(d.getDate() - 1); }
    else if (streak === 0 && key === todayKey()) { d.setDate(d.getDate() - 1); } // today may be empty yet
    else break;
    if (streak > 3650) break;
  }
  save(STREAK, streak);
}

export function streak() { return load(STREAK, 0); }

export function weekStats() {
  const log = activityLog();
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ key, count: log[key] || 0, day: d.toLocaleDateString(undefined, { weekday: 'short' }) });
  }
  return out;
}
