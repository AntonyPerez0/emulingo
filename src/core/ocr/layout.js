// Turns engine lines inside one text container into regions (pure).
//
// The detector returns one item per text run: whole lines on a crisp ×4
// crop, but also single words, a menu cursor or the ▼ arrow as their own
// items (OCR-09). Items are grouped geometrically, in native pixels:
// rows by vertical-centre overlap, cells by wide gaps (menu columns), and
// blocks by left alignment and line spacing. Blocks are then classified as
// dialog (sentence-like), menu (several short items) or label.

import {
  cleanLine, isHudToken, stripHudTokens, letterCount, alnumCount, isCapsish, normalizeMenuCase
} from './lexicon.js';

const MIN_SCORE = 0.6;
const FRAMED = new Set(['dialog', 'menu', 'battle', 'box']);
// Containers known to hold text (a framed box, or the player's text area):
// short lines such as "Ja!", "Oh!" or "はい" are real there (OCR-M5). Free
// reads keep the strict junk rules, they see map texture.
const TEXT_BOX = new Set([...FRAMED, 'zone']);
// Battle and zone boxes may hold a single short line ("Oh!"), menus never
const SHORT_LINE_KINDS = new Set(['battle', 'zone']);
const TERMINAL = /[.!?…。！？]["'“”‘’»›)]*$/u;
const KIND_ORDER = { dialog: 0, menu: 1, label: 2 };

// Join a region's lines into running text. A line-final hyphen is a word
// wrap ("zeich-" + "net" -> "zeichnet") unless the next line starts with a
// capital or digit or the left word is all-caps ("POKéMON-" + "CENTER"),
// where it is part of a compound and must stay (OCR-15).
export function joinLines(lines) {
  let out = '';
  for (const raw of lines || []) {
    const line = String(raw || '').trim();
    if (!line) continue;
    if (!out) { out = line; continue; }
    if (/\p{L}-$/u.test(out)) {
      const word = out.slice(out.lastIndexOf(' ') + 1, -1);
      const keep = /^[\p{Lu}\d]/u.test(line) || isCapsish(word);
      out = keep ? out + line : out.slice(0, -1) + line;
    } else {
      out += ' ' + line;
    }
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function union(boxes) {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const cx = (b) => b.x + b.w / 2;
const cy = (b) => b.y + b.h / 2;

// Valid, confident items whose centre lies in the container (with a little
// slack for the crop margin). Framed boxes also lose one- and two-letter
// specks sitting on their border (tile edges read as "a", "8"), and free
// reads lose items without two letters or digits (map texture).
function prepareItems(lines, container, minScore = MIN_SCORE) {
  const framed = FRAMED.has(container.kind);
  const minAlnum = TEXT_BOX.has(container.kind) ? 1 : 2;
  const items = [];
  for (const l of lines || []) {
    const text = String(l && l.text || '').replace(/\s+/gu, ' ').trim();
    const b = l && l.box;
    if (!text || !b || !(b.w >= 2) || !(b.h >= 3)) continue;
    if (typeof l.score === 'number' && l.score < minScore) continue;
    const x = cx(b), y = cy(b);
    const dx = Math.min(x - container.x, container.x + container.w - x);
    const dy = Math.min(y - container.y, container.y + container.h - y);
    if (dx < -2 || dy < -2) continue;
    if (framed && text.length <= 2 && (dx < 2 || dy < 2)) continue;
    if (!framed && alnumCount(text) < minAlnum) continue;
    const item = { text, score: typeof l.score === 'number' ? l.score : 1, box: { ...b } };
    // a text-row cell's column (containers.js cells): the box detector
    // already split menu columns there, even where the gap is narrow
    if (Number.isInteger(l.col)) item.col = l.col;
    items.push(item);
  }
  return items;
}

// Typical line height and glyph advance, from the items themselves (GB
// tiles are 8 px, the GBA font about 6 px wide with 13 px lines).
function measure(items) {
  const lineH = median(items.map((i) => i.box.h)) || 8;
  const widths = items.filter((i) => i.text.length >= 3).map((i) => i.box.w / i.text.length);
  let glyphW = median(widths) || lineH * 0.75;
  glyphW = Math.min(Math.max(glyphW, lineH * 0.3), lineH * 1.2);
  return { lineH, glyphW };
}

function clusterRows(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => cy(a.box) - cy(b.box))) {
    const c = cy(it.box);
    const row = rows.find((r) => Math.abs(r.cy - c) < 0.5 * Math.min(r.h, it.box.h));
    if (row) {
      row.items.push(it);
      row.cy = row.items.reduce((s, i) => s + cy(i.box), 0) / row.items.length;
      row.h = median(row.items.map((i) => i.box.h));
    } else {
      rows.push({ items: [it], cy: c, h: it.box.h });
    }
  }
  rows.sort((a, b) => a.cy - b.cy);
  for (const r of rows) r.items.sort((a, b) => a.box.x - b.box.x);
  return rows;
}

const gapBefore = (row, i) => row.items[i].box.x - (row.items[i - 1].box.x + row.items[i - 1].box.w);

// Left edges of items that start a new column in their row (preceded by a
// real gap). Used to split "FIGHT PkMn / ITEM RUN" into four menu items
// although the columns are only one or two glyphs apart.
function columnStarts(rows, glyphW) {
  const starts = [];
  rows.forEach((row, r) => {
    for (let i = 1; i < row.items.length; i++) {
      if (gapBefore(row, i) >= 0.6 * glyphW) starts.push({ r, x: row.items[i].box.x });
    }
  });
  return starts;
}

function makeCell(items, r) {
  return {
    row: r,
    text: items.map((i) => i.text).join(' ').replace(/\s+/gu, ' ').trim(),
    box: union(items.map((i) => i.box)),
    score: Math.min(...items.map((i) => i.score))
  };
}

function splitCells(rows, { glyphW, columns }) {
  const starts = columns ? columnStarts(rows, glyphW) : [];
  const tol = Math.max(glyphW * 0.75, 2);
  const cells = [];
  rows.forEach((row, r) => {
    let cur = [row.items[0]];
    for (let i = 1; i < row.items.length; i++) {
      const gap = gapBefore(row, i);
      const x = row.items[i].box.x;
      const aligned = columns && gap >= 0.6 * glyphW &&
        starts.some((s) => s.r !== r && Math.abs(s.x - x) <= tol);
      const prevCol = row.items[i - 1].col;
      const otherCell = columns && prevCol !== undefined && row.items[i].col !== undefined && prevCol !== row.items[i].col;
      if (gap > 2.5 * glyphW || aligned || otherCell) {
        cells.push(makeCell(cur, r));
        cur = [];
      }
      cur.push(row.items[i]);
    }
    cells.push(makeCell(cur, r));
  });
  return cells;
}

// Stack cells into blocks: same left edge (±1 glyph) and a vertical gap
// under 1.2 line heights.
function buildBlocks(cells, { glyphW, lineH }) {
  const blocks = [];
  for (const cell of [...cells].sort((a, b) => a.row - b.row || a.box.x - b.box.x)) {
    const block = blocks.find((bl) => {
      const last = bl.cells[bl.cells.length - 1];
      if (last.row >= cell.row) return false;
      const gap = cell.box.y - (last.box.y + last.box.h);
      return Math.abs(last.box.x - cell.box.x) <= glyphW && gap < 1.2 * lineH;
    });
    if (block) block.cells.push(cell);
    else blocks.push({ cells: [cell] });
  }
  return blocks;
}

const wordsOf = (t) => String(t || '').split(/\s+/u).filter((w) => /\p{L}/u.test(w));

// Running text rather than a list of labels: ends like a sentence, or has
// several words including a lowercase one ("What will PIKACHU do?").
export function isSentenceLike(text) {
  const t = String(text || '').trim();
  if (letterCount(t) < 4) return false;
  const words = wordsOf(t);
  const terminal = TERMINAL.test(t);
  if (terminal && words.length >= 2) return true;
  const lowerWord = words.some((w) => /^\p{Ll}{2,}$/u.test(w.replace(/^[¡¿"“„'‘‚(«‹]+|[.,!?…:;"“”'‘’)»›]+$/gu, '')));
  return words.length >= 3 && lowerWord;
}

// A column of short all-caps entries is a menu even when the last one ends
// in "!" ("KAUFEN / VERKAUFEN / TSCHÜSS!").
function isMenuColumn(texts) {
  return texts.length >= 2 && texts.every((t) => wordsOf(t).length <= 2 && isCapsish(t));
}

// Free reads see map texture and sprites: keep labels and menus only when
// they hold a word-like token (two letters with a vowel, or a non-Latin
// script) rather than strokes read as "lll" or "Il".
function looksLikeText(text) {
  return wordsOf(text).some((w) => {
    const core = w.replace(/[^\p{L}]/gu, '');
    if (core.length < 2 || /^[IlLi1|]+$/u.test(core)) return false;
    return /[aeiouyäöüàáâãåèéêëìíîïòóôõùúûýÿæœ]/iu.test(core) || /[^\p{Script=Latin}\P{L}]/u.test(core);
  });
}

// Free reads: at least three letters, mostly letters. Text boxes: one
// letter (or a number) is enough, as long as it is not mostly symbols.
function isJunk(text, lenient = false) {
  const letters = letterCount(text);
  const nonSpace = String(text || '').replace(/\s+/gu, '').length;
  if (!lenient) return letters < 3 || letters < 0.4 * nonSpace;
  const alnum = alnumCount(text);
  return !(letters >= 1 || alnum >= 2) || alnum < 0.4 * nonSpace;
}

// Menu entries can be two letters ("NO", "JA") but not mostly symbols.
function isJunkItem(text) {
  const letters = letterCount(text);
  return letters < 2 || letters < 0.4 * String(text || '').replace(/\s+/gu, '').length;
}

function dialogRegion(rows, ctx) {
  const lines = [];
  const scores = [];
  const boxes = [];
  rows.forEach((row, i) => {
    const prev = lines[lines.length - 1];
    const raw = row.items.map((it) => it.text).join(' ');
    const text = cleanLine(raw, {
      kind: 'dialog',
      isLastLine: i === rows.length - 1,
      lang: ctx.lang,
      isKnown: ctx.isKnown,
      // the box's first line starts a sentence when it opens with a
      // capitalised word (not an all-caps name that may end the previous one)
      sentenceStart: prev ? TERMINAL.test(prev) : /^\P{L}*\p{Lu}\p{Ll}/u.test(raw)
    });
    if (ctx.lenient ? isJunk(text, true) : alnumCount(text) < 2) return;
    lines.push(text);
    scores.push(Math.min(...row.items.map((it) => it.score)));
    boxes.push(union(row.items.map((it) => it.box)));
  });
  if (!lines.length) return null;
  const text = joinLines(lines);
  if (isJunk(text, ctx.lenient)) return null;
  return { kind: 'dialog', lines, text, box: union(boxes), score: Math.min(...scores), lineScores: scores };
}

function cellText(cell, kind, ctx) {
  return cleanLine(cell.text, { kind, isLastLine: kind === 'dialog', lang: ctx.lang, isKnown: ctx.isKnown });
}

// Gen 1's battle menu (FIGHT PkMn / ITEM RUN): the PK and MN ligature
// tiles are no letters the recogniser knows and come back as one or two
// stray letters ("EN", "P"). Next to FIGHT and RUN such an item is PkMn.
function fixPkMnItem(items) {
  if (!items.includes('FIGHT') || !items.includes('RUN')) return items;
  return items.map((t) => (/^\p{L}{1,2}$/u.test(t) ? 'PkMn' : t));
}

function menuRegion(cells, ctx) {
  const kept = [];
  for (const cell of cells.sort((a, b) => a.row - b.row || a.box.x - b.box.x)) {
    const text = cellText(cell, 'menu', ctx);
    if (isJunkItem(text)) continue;
    kept.push({ text, cell });
  }
  if (!kept.length) return null;
  const items = fixPkMnItem(normalizeMenuCase(kept.map((k) => k.text)));
  if (letterCount(items.join('')) < 3) return null;
  const scores = kept.map((k) => k.cell.score);
  return {
    kind: items.length >= 2 ? 'menu' : 'label',
    lines: items,
    text: items.join('\n'),
    box: union(kept.map((k) => k.cell.box)),
    score: Math.min(...scores),
    lineScores: scores
  };
}

function blockDialog(block, ctx) {
  const rows = block.cells.map((c) => ({ items: [{ text: c.text, score: c.score, box: c.box }] }));
  return dialogRegion(rows, ctx);
}

// Regions for one container.
// lines: engine Lines ({text, score, box} in native px); container: the
// tracker's Container; frame: {w, h}. opts.lang selects language rules
// (Spanish ¡/¿, French spacing), opts.isKnown(word) overrides the
// vocabulary check used to merge split letters, opts.minScore the line
// confidence floor (lower for Tesseract, whose scores run lower).
export function buildRegions(lines, container, frame, opts = {}) {
  if (!container) return [];
  const box = container.w > 0 && container.h > 0
    ? container
    : { ...container, x: 0, y: 0, w: frame ? frame.w : 1e6, h: frame ? frame.h : 1e6 };
  const ctx = { lang: opts.lang || 'en', isKnown: opts.isKnown, lenient: TEXT_BOX.has(container.kind) };
  const items = prepareItems(lines, box, typeof opts.minScore === 'number' ? opts.minScore : MIN_SCORE);
  if (!items.length) return [];
  const metrics = measure(items);
  // drop specks far smaller than the text around them
  const sized = items.length >= 3 ? items.filter((i) => i.box.h >= 0.45 * metrics.lineH) : items;
  const rows = clusterRows(sized);
  if (!rows.length) return [];

  const regions = [];
  if (container.kind === 'dialog') {
    // a menu box drawn over the dialog box can end up in its crop: short
    // all-caps entries with no sentence are a menu, not dialog
    const r = dialogRegion(rows, ctx);
    const cells = r && !isSentenceLike(r.text) && splitCells(rows, { glyphW: metrics.glyphW, columns: true });
    const texts = cells ? cells.map((c) => cellText(c, 'menu', ctx)) : [];
    if (cells && cells.length >= 2 && texts.every((t) => wordsOf(t).length <= 2 && isCapsish(t))) {
      const m = menuRegion(cells, ctx);
      if (m) regions.push(m);
    } else if (r) {
      regions.push(r);
    }
  } else {
    const framed = FRAMED.has(container.kind);
    const cells = splitCells(rows, { glyphW: metrics.glyphW, columns: framed })
      .filter((c) => !isHudToken(c.text) && !isHudToken(stripHudTokens(c.text)));
    const blocks = buildBlocks(cells, metrics);
    const menuCells = [];
    for (const block of blocks) {
      const texts = block.cells.map((c) => cellText(c, 'label', ctx));
      const joined = joinLines(texts);
      const shortLine = SHORT_LINE_KINDS.has(container.kind) && texts.length === 1 &&
        TERMINAL.test(joined) && letterCount(joined) >= 1;
      if ((isSentenceLike(joined) || shortLine) && !isMenuColumn(texts)) {
        const r = blockDialog(block, ctx);
        if (r) regions.push(r);
      } else if (framed) {
        menuCells.push(...block.cells);
      } else {
        const r = menuRegion(block.cells, ctx);
        if (r) regions.push(r);
      }
    }
    if (menuCells.length) {
      const r = menuRegion(menuCells, ctx);
      if (r) regions.push(r);
    }
  }

  const kept = FRAMED.has(container.kind) ? regions : regions.filter((r) => r.kind === 'dialog' || looksLikeText(r.text));
  const ordered = kept.sort((a, b) => {
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k) return k;
    if (a.kind === 'dialog') return letterCount(b.text) - letterCount(a.text);
    return a.box.y - b.box.y || a.box.x - b.box.x;
  });
  const count = {};
  return ordered.map((r) => {
    count[r.kind] = (count[r.kind] || 0) + 1;
    return {
      key: `${container.key}:${r.kind}${count[r.kind] - 1}`,
      kind: r.kind,
      containerKey: container.key,
      lines: r.lines,
      text: r.text,
      box: r.box,
      score: r.score,
      lineScores: r.lineScores
    };
  });
}

// Regions from line-mode results on a framed box's text-row cells
// (containers.js cells(): { row, col, x, y, w, h } plus the engine's
// { text, score } per cell). The cell's ink box is the line's box.
export function buildRegionsFromCells(cells, container, frame, opts = {}) {
  const lines = (cells || [])
    .filter((c) => c && c.text)
    .map((c) => ({ text: c.text, score: typeof c.score === 'number' ? c.score : 0, box: { x: c.x, y: c.y, w: c.w, h: c.h }, row: c.row, col: c.col }));
  return buildRegions(lines, container, frame, opts);
}
