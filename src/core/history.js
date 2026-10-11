// Recent captures shown under the live translation (newest first).
// A capture is the scanner's Capture object:
//   { id, time, src, tgt, dialog: { text, translation, status } | null,
//     others: [{ key, kind, text, translation, status }], conf /*0..1|null*/ }
// add() and update() work in place by id, so a continuation or a late
// translation never duplicates a line. The list is capped by keepHistory.

import { collection } from './db.js';
import { store } from './store.js';
import { isLang } from './language.js';
import { cleanText } from './srs.js';
import { ID_RE, hashString, clamp } from './utils.js';
import { isEngineErrorText } from './translate.js';

const TEXT_MAX = 2000;
const OTHERS_MAX = 24;
const STATUS_RE = /^[a-z][a-z-]{0,19}$/;
const KEY_RE = /^[^\u0000-\u001f\u007f]{1,120}$/;
const IN_FLIGHT = new Set(['pending', 'translating', 'queued']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Scanner ids are used as-is when safe, otherwise mapped to a stable safe id.
export function safeId(id) {
  const s = String(id ?? '');
  if (ID_RE.test(s)) return s;
  return s ? 'h' + hashString(s) : null;
}

function cleanPart(p, { stored }) {
  if (!p || typeof p !== 'object') return null;
  const text = cleanText(p.text, TEXT_MAX);
  if (!text) return null;
  let translation = cleanText(p.translation, TEXT_MAX);
  if (isEngineErrorText(translation)) translation = '';
  let status = typeof p.status === 'string' && STATUS_RE.test(p.status) ? p.status : translation ? 'done' : 'error';
  // a translation still running when the page closed will never finish
  if (stored && IN_FLIGHT.has(status)) status = translation ? 'done' : 'error';
  return { text, translation, status };
}

// v1 history entries: { original, translation, regions: [{ original, translation, conf }], time, conf, src, tgt }
function fromV1(raw) {
  const regions = Array.isArray(raw.regions) && raw.regions.length
    ? raw.regions.map((r) => ({ text: r?.original, translation: r?.translation }))
    : [{ text: raw.original, translation: raw.translation }];
  const longest = regions.reduce((best, r, i) =>
    (String(r.text || '').length > String(regions[best].text || '').length ? i : best), 0);
  const words = String(regions[longest].text || '').trim().split(/\s+/).length;
  const dialogIdx = words >= 2 ? longest : -1;
  return {
    dialog: dialogIdx >= 0 ? regions[dialogIdx] : null,
    others: regions.filter((_, i) => i !== dialogIdx).map((r, i) => ({ ...r, key: 'v1-' + i, kind: 'label' }))
  };
}

// Validate a capture -> clean record, or null. stored: true when it comes
// from storage or a backup (unfinished statuses become final).
export function sanitizeCapture(raw, { stored = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = safeId(raw.id);
  if (!id || !isLang(raw.src) || !isLang(raw.tgt)) return null;
  const v1 = !('dialog' in raw) && ('original' in raw || 'regions' in raw);
  const src = v1 ? fromV1(raw) : raw;
  const dialog = src.dialog ? cleanPart(src.dialog, { stored }) : null;
  const others = [];
  if (Array.isArray(src.others)) {
    for (const o of src.others.slice(0, OTHERS_MAX)) {
      const part = cleanPart(o, { stored });
      if (!part) continue;
      // region keys come from the layout (any text); views escape them like all data
      const key = typeof o.key === 'string' && KEY_RE.test(o.key) ? o.key : 'r' + others.length;
      const kind = ['dialog', 'menu', 'label'].includes(o.kind) ? o.kind : 'label';
      others.push({ key, kind, ...part });
    }
  }
  if (!dialog && !others.length) return null;
  // confidence is 0..1 (the scanner's score); v1 stored OCR percentages
  let conf = finite(Number(raw.conf)) ? Number(raw.conf) : null;
  if (conf !== null) conf = clamp(conf > 1 ? conf / 100 : conf, 0, 1);
  return {
    id,
    time: finite(raw.time) && raw.time > 0 ? raw.time : Date.now(),
    src: raw.src,
    tgt: raw.tgt,
    dialog,
    others,
    conf
  };
}

// Captures another tab just wrote may still be translating there: keep their status.
const col = collection('history', { sanitize: (r, ctx) => sanitizeCapture(r, { stored: !ctx?.remote }) });

function cap() {
  return store.get('keepHistory') || 200;
}

function trim() {
  const max = cap();
  if (col.size() <= max) return;
  const sorted = col.all().sort((a, b) => b.time - a.time);
  for (const c of sorted.slice(max)) col.delete(c.id);
}

store.subscribe((key) => { if (key === 'keepHistory') trim(); });

export function list() {
  return col.all().sort((a, b) => b.time - a.time);
}

export function get(id) {
  return col.get(safeId(id));
}

// Insert or replace by id. Returns the stored capture, or null when invalid.
export function add(capture) {
  const clean = sanitizeCapture(capture, { stored: false });
  if (!clean) return null;
  const prev = col.get(clean.id);
  if (prev) clean.time = prev.time; // keep its place in the list
  const out = col.put(clean);
  trim();
  return out;
}

// Replace an existing capture in place (late translation, continuation, retry).
export function update(capture) {
  const id = safeId(capture?.id);
  if (!id || !col.has(id)) return null;
  return add(capture);
}

export function remove(id) {
  return col.delete(safeId(id));
}

export function clear() {
  col.clear();
}

// Restore from a backup (captures already sanitized); existing ids win on merge.
export function importCaptures(list, { mode = 'merge' } = {}) {
  const incoming = mode === 'replace' ? list : list.filter((c) => !col.has(c.id));
  if (mode === 'replace') col.replaceAll(incoming);
  else col.putMany(incoming);
  trim();
  return incoming.length;
}
