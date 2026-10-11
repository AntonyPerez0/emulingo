// Text containers on the crisp native frame, with temporal masking and
// per-container settle timing. Pure: works on ImageData-like objects
// ({ data, width, height }) and never touches the DOM.
//
// Detection: a text box is a flat interior colour region (light for GB/GBC
// dialogs and menus, white rounded GBA boxes, dark teal GBA battle boxes)
// that (1) fills its bounding box, (2) is enclosed on every side by a frame
// line of one contrasting colour, and (3) that line is THIN. (3) is what keeps
// ponds, paths and tall-grass patches out: their "border" is the surrounding
// map, many pixels deep. Gen 1/2 battle HUDs are open L-shapes, never boxes.
//
// Masking: decorations that blink or move (▼ continue arrow, ▶ cursor) are
// painted with the box background in crops and left out of the hash, so the
// hash only changes when text changes. Typewriter growth is never masked
// for long: newly printed glyphs change once and then stay.

import { makeImageData } from './capture.js';

const TOL = 24;               // |dr|+|dg|+|db| inside one flat region
const MIN_W = 24;             // smallest interior: a one-line money box is ~62×14
const MIN_H = 10;
const MIN_FILL = 0.45;        // interior pixels / bbox area (text takes the rest)
const SIDE_FILL = 0.7;        // share of each bbox side that is interior colour
const MAX_TRIM = 0.25;        // sides may be trimmed this much (lines over the edge)
const RING_SHARE = 0.7;       // share of each frame side in one colour
const RING_CONTRAST = 40;     // frame colour vs interior
const MAX_LINE = 4;           // frame lines are thin (median run outwards)
const MIN_INK = 6;            // fewer ink pixels: an empty box (fg = null)
const BAR_RUN = 32;           // one-colour horizontal run: an HP bar, not text
const CELL = 8;               // tile size of every supported console
const MARGIN = 4;             // crop margin around the interior

const SMALL_EVENT = 0.04;     // changes ≤ 4 % of a box: decoration, cursor or a few glyphs
const PAGE_ERASE = 0.5;       // a change that erases this share of a box's ink is a new page
const TOGGLE_HOLD_MS = 1500;  // a pixel that toggled stays masked while it keeps changing
const ZONE_HOLD_MS = 1000;    // arrow-cell changes are masked until stable this long
const NONE = 0xffff;          // "no previous value" in the per-pixel memory

// ---------------------------------------------------------------- detection

// Framed text boxes on one native frame, top-to-bottom (stateless; the
// tracker below adds keys, hashes and masking). Each:
// { x, y, w, h /*interior, native px*/, kind, bg: [r,g,b], fg: [r,g,b]|null, cursors: rect[] /*static ▶*/ }
export function findContainers(img) {
  const W = img.width, H = img.height;
  return detect(packColours(img.data, W * H), W, H)
    .map(({ x, y, w, h, kind, bg, fg, cursors }) => ({ x, y, w, h, kind, bg: rgb(bg), fg, cursors }));
}

function detect(col, W, H) {
  const { lab, regions } = labelRegions(col, W, H);
  const boxes = [];
  for (const reg of regions) {
    if (reg.x0 === 0 || reg.y0 === 0 || reg.x1 === W - 1 || reg.y1 === H - 1) continue;
    const bw = reg.x1 - reg.x0 + 1, bh = reg.y1 - reg.y0 + 1;
    if (bw < MIN_W || bh < MIN_H || reg.area < MIN_FILL * bw * bh) continue;
    const box = evaluate(reg, lab, col, W, H);
    if (box) boxes.push(box);
  }
  // a box inside another box's interior is part of its content
  const kept = boxes.filter((b) => !boxes.some((o) => o !== b && contains(o, b)));
  kept.sort((a, b) => a.y - b.y || a.x - b.x);
  return kept;
}

// 4-connected flat regions; a pixel joins when it is within TOL of the
// region's seed colour (seed-relative, so gradients cannot chain across).
function labelRegions(col, W, H) {
  const N = W * H;
  const { lab, stack } = scratch(N);
  lab.fill(-1);
  const regions = [];
  for (let s = 0; s < N; s++) {
    if (lab[s] !== -1) continue;
    const id = regions.length, c = col[s];
    let sp = 0, area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    stack[sp++] = s; lab[s] = id;
    while (sp) {
      const p = stack[--sp];
      area++;
      const y = (p / W) | 0, x = p - y * W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      let q;
      if (x > 0 && lab[q = p - 1] === -1 && dist(col[q], c) <= TOL) { lab[q] = id; stack[sp++] = q; }
      if (x < W - 1 && lab[q = p + 1] === -1 && dist(col[q], c) <= TOL) { lab[q] = id; stack[sp++] = q; }
      if (y > 0 && lab[q = p - W] === -1 && dist(col[q], c) <= TOL) { lab[q] = id; stack[sp++] = q; }
      if (y < H - 1 && lab[q = p + W] === -1 && dist(col[q], c) <= TOL) { lab[q] = id; stack[sp++] = q; }
    }
    regions.push({ id, colour: c, area, x0, y0, x1, y1 });
  }
  return { lab, regions };
}

function evaluate(reg, lab, col, W, H) {
  const id = reg.id;
  const rowFill = (y, a, b) => { let n = 0; for (let x = a, p = y * W + a; x <= b; x++, p++) if (lab[p] === id) n++; return n / (b - a + 1); };
  const colFill = (x, a, b) => { let n = 0; for (let y = a, p = a * W + x; y <= b; y++, p += W) if (lab[p] === id) n++; return n / (b - a + 1); };
  let { x0, y0, x1, y1 } = reg;
  // trim sides that are not interior colour (rounded corners, a line drawn
  // over the box edge); anything that needs more than MAX_TRIM is no box
  for (let pass = 0; pass < 2; pass++) {
    while (y1 > y0 && rowFill(y0, x0, x1) < SIDE_FILL) y0++;
    while (y1 > y0 && rowFill(y1, x0, x1) < SIDE_FILL) y1--;
    while (x1 > x0 && colFill(x0, y0, y1) < SIDE_FILL) x0++;
    while (x1 > x0 && colFill(x1, y0, y1) < SIDE_FILL) x1--;
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const bw = reg.x1 - reg.x0 + 1, bh = reg.y1 - reg.y0 + 1;
  if (w < MIN_W || h < MIN_H || w < bw * (1 - MAX_TRIM) || h < bh * (1 - MAX_TRIM)) return null;
  const bg = reg.colour;
  // frame: the ring just outside, side by side (overlapping boxes may give
  // each side its own frame colour)
  const sides = [
    [(y0 - 1) * W + x0, 1, w, -W, y0 - 1],
    [(y1 + 1) * W + x0, 1, w, W, H - 2 - y1],
    [y0 * W + x0 - 1, W, h, -1, x0 - 1],
    [y0 * W + x1 + 1, W, h, 1, W - 2 - x1]
  ];
  // A smoothed (bilinear) picture puts a blended, low-contrast pixel
  // between the interior and its frame line: on a side that fails, look
  // one pixel further out (phone-sized GBA boxes were missed otherwise).
  const rings = sides.map((sd) => {
    const [start, step, n, out, room] = sd;
    if (frameSide(col, start, step, n, out, room, bg)) return sd;
    return room > 0 ? [start + out, step, n, out, room - 1] : sd;
  });
  const kinds = rings.map(([start, step, n, out, room]) => frameSide(col, start, step, n, out, room, bg));
  if (kinds.some((k) => !k)) return null;
  // patterned frames are symmetric: opposite sides repeat the same pattern
  // (a path between rows of tall grass is not)
  if (kinds.includes('pattern') && !(sameSeq(col, rings[0], rings[1]) && sameSeq(col, rings[2], rings[3]))) return null;
  const ink = inkStats(col, W, x0, y0, w, h, bg);
  return { x: x0, y: y0, w, h, bg, fg: ink.fg, ...classify() };

  function classify() {
    const dark = luma(bg) < 110;
    const atBottom = y1 + 1 >= 0.85 * H;
    let kind;
    if (dark && atBottom && w >= 0.4 * W) kind = 'battle';
    else if (atBottom && w >= 0.8 * W) kind = 'dialog';
    else if (ink.bars || ink.bands.length <= 1) kind = 'box';
    else kind = 'menu';
    return { kind, cursors: kind === 'menu' ? staticCursors(col, W, x0, y0, w, h, bg, ink) : [] };
  }
}

// One frame side: 'line', 'pattern' or null (not a frame). A plain line is
// mostly one colour, contrasts with the interior and is thin (the colour does
// not continue far outwards); a patterned frame (Gen 2/3 frame options) is a
// short repeating pattern that contrasts with the interior and is thin pixel
// by pixel.
function frameSide(col, start, step, n, out, room, bg) {
  const counts = new Map();
  for (let i = 0, p = start; i < n; i++, p += step) counts.set(col[p], (counts.get(col[p]) || 0) + 1);
  let line = 0, best = -1;
  for (const [c, k] of counts) if (k > best) { best = k; line = c; }
  if (dist(line, bg) < RING_CONTRAST) return null;
  let same = 0;
  for (let i = 0, p = start; i < n; i++, p += step) if (dist(col[p], line) <= TOL) same++;
  if (same >= RING_SHARE * n) return thin(col, start, step, n, out, room, (c) => dist(c, line) <= TOL) ? 'line' : null;
  return patterned(col, start, step, n, bg) && thin(col, start, step, n, out, room, null) ? 'pattern' : null;
}

function sameSeq(col, [a, step, n], [b]) {
  let same = 0;
  for (let i = 0; i < n; i++) if (dist(col[a + i * step], col[b + i * step]) <= TOL) same++;
  return same >= 0.85 * n;
}

// median run (in px) of each ring pixel's colour going outwards
function thin(col, start, step, n, out, room, keep) {
  const runs = [];
  for (let i = 0, p = start; i < n; i++, p += step) {
    const c = col[p];
    if (keep && !keep(c)) continue;
    let t = 1;
    for (let k = 1, q = p + out; k <= room && t <= MAX_LINE + 1; k++, q += out) {
      if (dist(col[q], c) > TOL) break;
      t++;
    }
    runs.push(t);
  }
  if (!runs.length) return false;
  runs.sort((a, b) => a - b);
  return runs[runs.length >> 1] <= MAX_LINE;
}

function patterned(col, start, step, n, bg) {
  if (n < 16) return false;
  let contrast = 0;
  for (let i = 0, p = start; i < n; i++, p += step) if (dist(col[p], bg) >= RING_CONTRAST) contrast++;
  if (contrast < 0.85 * n) return false;
  for (let period = 2; period <= CELL; period++) {
    let same = 0;
    for (let i = 0, p = start; i + period < n; i++, p += step) if (dist(col[p], col[p + period * step]) <= TOL) same++;
    if (same >= 0.9 * (n - period)) return true;
  }
  return false;
}

// Ink inside the interior: the text colour, text bands (row groups, each
// with its leftmost ink column) and whether there is an HP-bar-like run.
function inkStats(col, W, x0, y0, w, h, bg) {
  const counts = new Map();
  const rows = new Uint16Array(h);
  const lefts = new Int32Array(h).fill(-1);
  let total = 0, bars = false;
  for (let y = 0; y < h; y++) {
    let run = 0, runC = -1;
    for (let x = 0, p = (y0 + y) * W + x0; x < w; x++, p++) {
      const c = col[p];
      if (dist(c, bg) <= TOL) { run = 0; runC = -1; continue; }
      if (!rows[y]++) lefts[y] = x0 + x;
      total++;
      counts.set(c, (counts.get(c) || 0) + 1);
      if (c === runC) { if (++run >= BAR_RUN) bars = true; } else { run = 1; runC = c; }
    }
  }
  // text colour: the most contrasting of the common ink colours (GBA drop
  // shadows cover more pixels than the glyphs themselves)
  let fg = null;
  if (total >= MIN_INK) {
    let most = 0;
    for (const k of counts.values()) if (k > most) most = k;
    let far = -1;
    for (const [c, k] of counts) {
      if (k < 0.2 * most) continue;
      const d = dist(c, bg);
      if (d > far) { far = d; fg = c; }
    }
  }
  // bands: rows with ink, bridging 1-row gaps; < 3 rows tall is decoration
  const bands = [];
  for (let y = 0; y < h;) {
    if (!rows[y]) { y++; continue; }
    let e = y, left = Infinity;
    while (e + 1 < h && (rows[e + 1] || (e + 2 < h && rows[e + 2]))) e++;
    for (let k = y; k <= e; k++) if (rows[k] && lefts[k] < left) left = lefts[k];
    if (e - y + 1 >= 3) bands.push({ y0: y0 + y, y1: y0 + e, left });
    y = e + 1;
  }
  return { fg: fg == null ? null : rgb(fg), bands, bars };
}

// Static menu cursors: ▶/▷ triangles anywhere in a menu's text bands, and
// a narrow cluster that starts one band left of where every other band
// starts (cursor column of any shape). Returned as rects to blank.
function staticCursors(col, W, x0, y0, w, h, bg, ink) {
  const out = [];
  if (ink.fg) {
    const fg = (ink.fg[0] << 16) | (ink.fg[1] << 8) | ink.fg[2];
    for (const b of ink.bands) out.push(...triangles(col, W, x0, w, y0 + h, b, fg));
  }
  const lead = leadingCluster(col, W, x0, w, bg, ink.bands);
  if (lead && !out.some((r) => overlapsRect(r, lead))) out.push(lead);
  return out;
}

// Right-pointing triangles in the text colour: 3–8 columns whose vertical
// extents shrink left to right around one centre line, with gaps either side.
function triangles(col, W, x0, w, yEnd, band, fg) {
  const spans = [];
  for (let x = x0; x < x0 + w; x++) {
    let top = -1, bot = -1;
    for (let y = band.y0, p = y * W + x; y <= band.y1; y++, p += W) {
      if (dist(col[p], fg) <= TOL) { if (top < 0) top = y; bot = y; }
    }
    spans.push(top < 0 ? null : [top, bot]);
  }
  const found = [];
  for (let i = 0; i < spans.length;) {
    if (!spans[i]) { i++; continue; }
    let e = i;
    while (e + 1 < spans.length && spans[e + 1]) e++;
    const n = e - i + 1;
    const gapL = i === 0 || (!spans[i - 1] && (i < 2 || !spans[i - 2]));
    const gapR = e + 2 >= spans.length || (!spans[e + 1] && !spans[e + 2]);
    if (n >= 3 && n <= 8 && gapL && gapR && isTriangle(spans.slice(i, e + 1))) {
      const top = spans[i][0], bot = spans[i][1];
      // +1 px right and down: drop shadows
      found.push({ x: x0 + i, y: top, w: Math.min(n + 1, w - i), h: Math.min(bot - top + 2, yEnd - top) });
    }
    i = e + 1;
  }
  return found;
}

function isTriangle(sp) {
  const len = sp.map(([a, b]) => b - a + 1), mid = (sp[0][0] + sp[0][1]) / 2;
  if (len[0] < 5 || len[len.length - 1] > 2 || len[0] - len[len.length - 1] < 4) return false;
  for (let k = 0; k < sp.length; k++) {
    if (k && len[k] > len[k - 1]) return false;
    if (Math.abs((sp[k][0] + sp[k][1]) / 2 - mid) > 1) return false;
  }
  return true;
}

function leadingCluster(col, W, x0, w, bg, bands) {
  if (bands.length < 2) return null;
  const sorted = bands.map((b) => b.left).sort((a, b) => a - b);
  const band = bands.find((b) => b.left === sorted[0]);
  if (sorted[1] - sorted[0] < 4) return null;
  const colInk = (x) => {
    for (let y = band.y0, p = y * W + x; y <= band.y1; y++, p += W) if (dist(col[p], bg) > TOL) return true;
    return false;
  };
  let cx1 = band.left;
  while (cx1 + 1 < x0 + w && colInk(cx1 + 1)) cx1++;
  if (cx1 - band.left + 1 > CELL - 1 || cx1 + 2 > sorted[1]) return null;
  for (let x = cx1 + 1; x <= cx1 + 2; x++) if (x >= x0 + w || colInk(x)) return null;
  return { x: band.left, y: band.y0, w: cx1 - band.left + 1, h: band.y1 - band.y0 + 1 };
}

function overlapsRect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(o, b) {
  return b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h;
}

// ---------------------------------------------------------------- tracking

export function createContainerTracker({ zone = null } = {}) {
  let zoneNorm = normZone(zone);
  let W = 0, H = 0;
  // Temporal masking needs only the previous frame and a per-pixel memory
  // (value before the last change, toggle count, time), not a frame ring.
  let prevQ = null;           // previous frame, quantised colours
  let mem = null;             // per-pixel decoration memory
  let live = new Map();       // key -> { hash, since }
  let changed = null;         // scratch list of changed pixel indices

  function alloc(w, h) {
    W = w; H = h;
    const N = w * h;
    mem = {
      prevVal: new Uint16Array(N).fill(NONE), // value before the last small change
      toggles: new Uint8Array(N),             // consecutive returns to that value
      moved: new Uint8Array(N),               // part of a moving object (cursor)
      lastSmall: new Float64Array(N).fill(-Infinity) // time of the last small change
    };
    changed = new Int32Array(N);
    prevQ = null; live = new Map();
  }

  function forget(r) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let p = y * W + r.x, e = p + r.w; p < e; p++) {
        mem.prevVal[p] = NONE; mem.toggles[p] = 0; mem.moved[p] = 0; mem.lastSmall[p] = -Infinity;
      }
    }
  }

  // Updates the decoration memory from what changed since the last frame.
  function learn(r, q, bgQ, t) {
    let n = 0, ink = 0, erased = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let p = y * W + r.x, e = p + r.w; p < e; p++) {
        const was = prevQ[p];
        if (was !== bgQ) ink++;
        if (q[p] !== was) {
          changed[n++] = p;
          if (q[p] === bgQ) erased++;
        }
      }
    }
    if (!n) return;
    // new page, scroll or map moved. Erasing most of the ink also counts,
    // however little there was: a short page ("Hm?") cleared for the next
    // one would otherwise read as a blink, and the next page's glyphs that
    // land on the old ones would be masked.
    if (n > Math.max(24, SMALL_EVENT * r.w * r.h) || (erased >= MIN_INK && erased >= PAGE_ERASE * ink)) {
      forget(r);
      return;
    }
    // a pixel stays "moving" only while moves are what changes it, so text
    // later printed where a cursor used to be is not hidden
    const move = isMove(changed, n, q, prevQ, bgQ, W) ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const p = changed[i];
      mem.moved[p] = move;
      mem.toggles[p] = q[p] === mem.prevVal[p] ? Math.min(255, mem.toggles[p] + 1) : 0;
      mem.prevVal[p] = prevQ[p];
      mem.lastSmall[p] = t;
    }
  }

  function maskFor(b, t) {
    const r = b, m = new Uint8Array(r.w * r.h);
    const arrow = b.kind === 'dialog' || b.kind === 'battle' || b.kind === 'zone';
    // the ▼ cell sits in the interior's bottom-right corner on GB/GBC
    const ax = r.x + r.w - 1.5 * CELL, ay = r.y + r.h - 1.5 * CELL;
    const { toggles, moved, lastSmall } = mem;
    let i = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x, p = y * W + r.x; x < r.x + r.w; x++, p++, i++) {
        const age = t - lastSmall[p];
        if (moved[p] || (toggles[p] && age <= TOGGLE_HOLD_MS) || (arrow && x >= ax && y >= ay && age <= ZONE_HOLD_MS)) m[i] = 1;
      }
    }
    for (const c of b.cursors || []) {
      for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) m[(y - r.y) * r.w + (x - r.x)] = 1;
    }
    return m;
  }

  function track(b, frame, q, t, seen) {
    const bgQ = quant(b.bg);
    const prev = live.get(b.key);
    if (!prev || !prevQ) forget(b);
    else learn(b, q, bgQ, t);
    const mask = maskFor(b, t);
    const hash = hashMasked(q, W, b, mask, bgQ);
    const since = prev && prev.hash === hash ? prev.since : t;
    seen.set(b.key, { hash, since });
    let cropped = null, cellList = null;
    const framed = b.kind !== 'zone' && b.kind !== 'free';
    const container = {
      key: b.key,
      kind: b.kind,
      x: b.x, y: b.y, w: b.w, h: b.h,
      hash,
      settledMs: Math.max(0, t - since), // a clock that steps back must not go negative
      bg: rgb(b.bg),
      fg: b.fg,
      crop() {
        if (!cropped) cropped = cropMasked(frame.img, b, mask, framed);
        return cropped;
      }
    };
    // extension (not in the pinned interface): text lines/cells of a framed
    // box, for line-by-line recognition without a detector
    if (framed) {
      container.cells = () => {
        if (!cellList) cellList = textCells(frame.img, b, mask);
        return cellList;
      };
    }
    return container;
  }

  return {
    update(frame) {
      const img = frame && frame.img;
      if (!img || !img.width || !img.height) return [];
      const t = Number.isFinite(frame.t) ? frame.t : now();
      if (img.width !== W || img.height !== H || !mem) alloc(img.width, img.height);
      const N = W * H;
      const col = packColours(img.data, N);
      const q = quantColours(col);
      let boxes;
      if (zoneNorm) boxes = [zoneBox(zoneNorm, col, W, H)];
      else {
        boxes = detect(col, W, H).map((b) => ({ ...b, key: `${b.kind}:${round4(b.x)},${round4(b.y)},${round4(b.w)},${round4(b.h)}` }));
        if (!boxes.length) boxes = [freeBox(col, W, H)];
      }
      const seen = new Map();
      const out = boxes.map((b) => track(b, frame, q, t, seen));
      live = seen;
      prevQ = q;
      return out;
    },
    setZone(norm) {
      zoneNorm = normZone(norm);
    },
    reset() {
      W = 0; H = 0; mem = null; prevQ = null; live = new Map(); changed = null;
    }
  };
}

// A moving object (menu cursor): the pixels that turned to background and
// the pixels that turned to ink have the same shape, shifted.
function isMove(changed, n, q, prevQ, bgQ, W) {
  const add = [], rem = [];
  let other = 0;
  for (let i = 0; i < n; i++) {
    const p = changed[i], was = prevQ[p] !== bgQ, is = q[p] !== bgQ;
    if (!was && is) add.push(p);
    else if (was && !is) rem.push(p);
    else other++;
  }
  if (!add.length || !rem.length || other > 0.1 * n) return false;
  if (Math.abs(add.length - rem.length) > 0.25 * Math.max(add.length, rem.length)) return false;
  const ba = bbox(add, W), br = bbox(rem, W);
  if (Math.abs(ba.w - br.w) > 1 || Math.abs(ba.h - br.h) > 1 || ba.w > 2 * CELL || ba.h > 2 * CELL) return false;
  const dx = ba.x - br.x, dy = ba.y - br.y;
  if (Math.abs(dx) + Math.abs(dy) < 2) return false;
  const set = new Set(add);
  let hit = 0;
  for (const p of rem) if (set.has(p + dy * W + dx)) hit++;
  return hit >= 0.8 * rem.length;
}

function bbox(list, W) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const p of list) {
    const y = (p / W) | 0, x = p - y * W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// FNV-1a of the masked interior: identical to fnv1a() in capture.js run on
// the masked crop (masked pixels painted with the background).
function hashMasked(q, W, r, mask, bgQ) {
  let h = 0x811c9dc5, i = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let p = y * W + r.x, e = p + r.w; p < e; p++, i++) {
      h ^= mask[i] ? bgQ : q[p];
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

function cropMasked(img, r, mask, framed) {
  const W = img.width, H = img.height;
  const x0 = Math.max(0, r.x - MARGIN), y0 = Math.max(0, r.y - MARGIN);
  const x1 = Math.min(W, r.x + r.w + MARGIN), y1 = Math.min(H, r.y + r.h + MARGIN);
  const cw = x1 - x0, ch = y1 - y0;
  const out = new Uint8ClampedArray(cw * ch * 4);
  const src = img.data;
  for (let y = y0; y < y1; y++) out.set(src.subarray((y * W + x0) * 4, (y * W + x1) * 4), (y - y0) * cw * 4);
  const [br, bgc, bb] = rgb(r.bg);
  const paint = (o) => { out[o] = br; out[o + 1] = bgc; out[o + 2] = bb; };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = ((y - y0) * cw + (x - x0)) * 4;
      const inside = x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
      // the margin of a framed box is frame, not text: blank it so the
      // detector cannot read rules as | or I
      if (inside ? mask[(y - r.y) * r.w + (x - r.x)] : framed) paint(o);
      out[o + 3] = 255;
    }
  }
  return { img: makeImageData(out, cw, ch), offset: { x: x0, y: y0 } };
}

// Text cells of a framed box, from the masked interior: rows are ink bands
// (≥ 3 px tall), split into cells at gaps wider than two row heights (menu
// columns; dialog lines stay whole). Each cell crops with the box background
// as padding (±4 px across, ±3 px down), masked pixels blanked.
// Cell = { row, col, x, y, w, h, crop() -> { img, offset } } in native px.
function textCells(img, r, mask) {
  const W = img.width, src = img.data;
  const bg = r.bg, [br, bgc, bb] = rgb(bg);
  const ink = new Uint8Array(r.w * r.h);
  for (let y = 0, i = 0; y < r.h; y++) {
    for (let x = 0, o = ((r.y + y) * W + r.x) * 4; x < r.w; x++, i++, o += 4) {
      if (!mask[i] && Math.abs(src[o] - br) + Math.abs(src[o + 1] - bgc) + Math.abs(src[o + 2] - bb) > TOL) ink[i] = 1;
    }
  }
  const rowOn = (y) => { for (let x = 0, i = y * r.w; x < r.w; x++, i++) if (ink[i]) return true; return false; };
  const rows = [];
  for (let y = 0; y < r.h;) {
    if (!rowOn(y)) { y++; continue; }
    let e = y;
    while (e + 1 < r.h && (rowOn(e + 1) || (e + 2 < r.h && rowOn(e + 2)))) e++;
    if (e - y + 1 >= 3) rows.push([y, e]);
    y = e + 1;
  }
  // menu columns: split at wide gaps (> 2 row heights), then also at
  // narrower gaps (≥ half a row) where another row has a column start
  const split = r.kind === 'menu' || r.kind === 'box';
  const segsOf = (y0, y1, starts) => {
    const rh = y1 - y0 + 1;
    const colOn = (x) => { for (let y = y0, i = y0 * r.w + x; y <= y1; y++, i += r.w) if (ink[i]) return true; return false; };
    const segs = [];
    let s = -1, last = -1;
    for (let x = 0; x < r.w; x++) {
      if (!colOn(x)) continue;
      const gap = x - last - 1;
      if (s >= 0 && split && (gap > 2 * rh || (gap >= Math.max(4, rh / 2) && starts.some((c) => Math.abs(c - x) <= 2)))) { segs.push([s, last]); s = -1; }
      if (s < 0) s = x;
      last = x;
    }
    if (s >= 0) segs.push([s, last]);
    return segs.filter(([a, b]) => b - a + 1 >= 2);
  };
  const starts = [];
  if (split) for (const [y0, y1] of rows) for (const [a] of segsOf(y0, y1, []).slice(1)) starts.push(a);
  const cells = [];
  rows.forEach(([y0, y1], row) => {
    segsOf(y0, y1, starts).forEach(([a, b], col) => {
      const cell = { row, col, x: r.x + a, y: r.y + y0, w: b - a + 1, h: y1 - y0 + 1 };
      let cached = null;
      cell.crop = () => cached || (cached = cellCrop(img, r, mask, cell));
      cells.push(cell);
    });
  });
  return cells;
}

function cellCrop(img, r, mask, cell) {
  const W = img.width, H = img.height, src = img.data;
  const ox = cell.x - 4, oy = cell.y - 3, cw = cell.w + 8, ch = cell.h + 6;
  const [br, bgc, bb] = rgb(r.bg);
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const sx = ox + x, sy = oy + y, o = (y * cw + x) * 4;
      const inside = sx >= r.x && sy >= r.y && sx < r.x + r.w && sy < r.y + r.h && sx < W && sy < H;
      if (inside && !mask[(sy - r.y) * r.w + (sx - r.x)]) {
        const i = (sy * W + sx) * 4;
        out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2];
      } else {
        out[o] = br; out[o + 1] = bgc; out[o + 2] = bb;
      }
      out[o + 3] = 255;
    }
  }
  return { img: makeImageData(out, cw, ch), offset: { x: ox, y: oy } };
}

// Free mode: the whole frame is one container.
function freeBox(col, W, H) {
  return { key: 'free', kind: 'free', x: 0, y: 0, w: W, h: H, bg: modeColour(col, W, 0, 0, W, H, 3), fg: null, cursors: [] };
}

function zoneBox(n, col, W, H) {
  const x = clampInt(Math.floor(n.x * W), 0, W - 1), y = clampInt(Math.floor(n.y * H), 0, H - 1);
  const w = clampInt(Math.ceil((n.x + n.w) * W) - x, 1, W - x), h = clampInt(Math.ceil((n.y + n.h) * H) - y, 1, H - y);
  const bg = modeColour(col, W, x, y, w, h, 1);
  const ink = inkStats(col, W, x, y, w, h, bg);
  return { key: `zone:${x},${y},${w},${h}`, kind: 'zone', x, y, w, h, bg, fg: ink.fg, cursors: [] };
}

function normZone(z) {
  if (!z) return null;
  const x = clamp01(+z.x), y = clamp01(+z.y);
  const w = Math.min(clamp01(+z.w), 1 - x), h = Math.min(clamp01(+z.h), 1 - y);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

// ---------------------------------------------------------------- helpers

// Labelling buffers are reused between frames (detection is synchronous and
// nothing keeps them), saving ~0.3 MB of garbage per GBA poll.
let scratchBufs = null;
function scratch(N) {
  if (!scratchBufs || scratchBufs.N !== N) scratchBufs = { N, lab: new Int32Array(N), stack: new Int32Array(N), col: new Uint32Array(N) };
  return scratchBufs;
}

function packColours(data, N) {
  const col = scratch(N).col;
  for (let i = 0, j = 0; i < N; i++, j += 4) col[i] = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
  return col;
}

// 12-bit colour (top 4 bits per channel), the same symbols fnv1a() hashes
function quantColours(col) {
  const q = new Uint16Array(col.length);
  for (let i = 0; i < col.length; i++) q[i] = quant(col[i]);
  return q;
}

function quant(c) {
  return ((c >>> 12) & 0xf00) | ((c >>> 8) & 0xf0) | ((c >>> 4) & 0xf);
}

function modeColour(col, W, x0, y0, w, h, step) {
  const counts = new Map();
  let best = 0, mode = 0;
  for (let y = y0; y < y0 + h; y += step) {
    for (let x = x0, p = y * W + x0; x < x0 + w; x += step, p += step) {
      const k = (counts.get(col[p]) || 0) + 1;
      counts.set(col[p], k);
      if (k > best) { best = k; mode = col[p]; }
    }
  }
  return mode;
}

function dist(a, b) {
  const dr = (a >>> 16) - (b >>> 16), dg = ((a >>> 8) & 255) - ((b >>> 8) & 255), db = (a & 255) - (b & 255);
  return (dr < 0 ? -dr : dr) + (dg < 0 ? -dg : dg) + (db < 0 ? -db : db);
}

function luma(c) {
  return 0.299 * (c >>> 16) + 0.587 * ((c >>> 8) & 255) + 0.114 * (c & 255);
}

function rgb(c) {
  return typeof c === 'number' ? [c >>> 16, (c >>> 8) & 255, c & 255] : c;
}

function round4(v) {
  return Math.round(v / 4) * 4;
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
