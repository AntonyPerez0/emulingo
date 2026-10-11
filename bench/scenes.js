// Procedural Pokemon-style test scenes rendered at NATIVE resolution
// (GB/GBC 160x144, GBA 240x160) with exact ground truth.
//
// All art is original and generated from code (seeded PRNG): grass, tall
// grass, trees, water, paths, flowers, fences, houses, signs, sprites and
// battle creatures. Text is drawn with the bitmap fonts in ./fonts.js.
//
// renderScene(id) -> { canvas, truth } where truth is
//   { id, platform: 'gb'|'gba', lang, frameKind, partial, nativeW, nativeH,
//     regions: [{ kind: 'dialog'|'menu'|'hud'|'sign', lines: [...], text }] }
// Regions are listed in reading order (top-to-bottom, left-to-right).
// `text` joins the lines with a space; a line ending in "<lowercase>-"
// followed by a lowercase line is a typewriter word wrap and is joined
// without the hyphen ("zeich-" + "net" -> "zeichnet").
//
// Works in the browser (default canvas factory) and in Node with a canvas
// implementation injected via setCanvasFactory().

import {
  GB_THIN, GB_BOLD, GBA_FONT, TILE_PK, TILE_MN, TILE_LV, TILE_HP,
  drawTileText, drawPropText, measurePropText, textForGroundTruth
} from './fonts.js';

export const GB_W = 160, GB_H = 144, GBA_W = 240, GBA_H = 160;

let canvasFactory = (w, h) => {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
};
export function setCanvasFactory(fn) { canvasFactory = fn; }
export function newCanvas(w, h) { return canvasFactory(w, h); }

// ---------------------------------------------------------------- PRNG ---

function hashStr(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (r, n) => Math.floor(r() * n);

// ------------------------------------------------------------ palettes ---
// GB palettes: [lightest, light, dark, darkest]

const GB_PALETTES = {
  'dmg-gray': ['#ffffff', '#a8a8a8', '#555555', '#000000'],
  'dmg-green': ['#e0f8d0', '#88c070', '#346856', '#081820'],
  // GBC boot-ROM style colourisations of monochrome games
  'gbc-red': ['#ffffff', '#ff8484', '#943a3a', '#000000'],
  'gbc-blue': ['#ffffff', '#63a5ff', '#0000ff', '#000000']
};

// Gen 2 style per-tile GBC palettes (day / night)
const GBC_DAY = {
  grass: ['#d8f8a0', '#98d858', '#489028', '#183010'],
  tallGrass: ['#d8f8a0', '#70c040', '#307818', '#102808'],
  tree: ['#d8f8a0', '#58b030', '#206818', '#101808'],
  path: ['#f8e8b8', '#e0c888', '#a88850', '#382810'],
  water: ['#c0e8f8', '#68a0f0', '#3060b8', '#102048'],
  roof: ['#f8d8c8', '#e86850', '#982818', '#301008'],
  wall: ['#f8f8f0', '#d8d0b8', '#908870', '#282018'],
  flower: ['#d8f8a0', '#f8f050', '#e84040', '#183010'],
  rock: ['#d8f8a0', '#c0b8a8', '#787060', '#202018'],
  floor: ['#f8f0d8', '#e0d0a8', '#a89060', '#302010'],
  sprite: ['#f8f8f8', '#f8b888', '#d83828', '#101010'],
  creature: ['#f8f8f8', '#88c8f8', '#3070c0', '#101828'],
  text: ['#f8f8f8', '#a8a8a8', '#585858', '#080808']
};
function nightOf(pals) {
  // darken + push towards blue; the text box keeps its palette
  const shade = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const f = (v, k) => Math.max(0, Math.min(255, Math.round(v * k)));
    return '#' + [f(r, 0.45), f(g, 0.5), f(b, 0.8) + 20].map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('');
  };
  const out = {};
  for (const [k, p] of Object.entries(pals)) out[k] = k === 'text' ? p : p.map(shade);
  return out;
}
const GBC_NIGHT = nightOf(GBC_DAY);

function uniformPals(pal) {
  const out = {};
  for (const k of Object.keys(GBC_DAY)) out[k] = pal;
  return out;
}

// GBA (Gen 3 style) palettes: richer, 4 shades + accent where useful
const GBA_PALS = {
  grass: ['#98d870', '#78c058', '#58a040', '#306828'],
  tallGrass: ['#88d060', '#60b040', '#408828', '#205818'],
  tree: ['#98d870', '#48a038', '#287020', '#103810'],
  path: ['#e8d8a0', '#d0b878', '#a88c50', '#584020'],
  water: ['#a8d8f8', '#5898e8', '#3068c0', '#183878'],
  roof: ['#f8a888', '#d85840', '#a03020', '#501810'],
  roofBlue: ['#a8c8f8', '#5880d8', '#3050a0', '#182850'],
  wall: ['#f8f0e0', '#e0d0b0', '#a89878', '#483828'],
  flower: ['#98d870', '#f8e858', '#f05050', '#306828'],
  rock: ['#98d870', '#c8c0b0', '#888070', '#383028'],
  floor: ['#f8f0d8', '#e0d0a8', '#a89060', '#302010'],
  sprite: ['#f8f8f8', '#f8c8a0', '#e04838', '#202020'],
  creature: ['#f8f8f8', '#f8a048', '#c86020', '#402010'],
  text: ['#ffffff', '#d0d0c8', '#686870', '#484848']
};

// --------------------------------------------------------- primitives ---

function rect(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
function px(ctx, x, y, c) { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); }
function drawPattern(ctx, rows, x, y, pal, scale = 1, flipX = false) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[flipX ? row.length - 1 - c : c];
      if (ch === '.') continue;
      rect(ctx, x + c * scale, y + r * scale, scale, scale, pal[+ch]);
    }
  }
}
function flipRowsV(rows) { return rows.slice().reverse(); }
function flipRowsH(rows) { return rows.map((r) => r.split('').reverse().join('')); }

// --------------------------------------------------- overworld tiles ---
// 16x16 metatiles; pal = [lightest, light, dark, darkest]

const BLADES = [
  '..3...3.',
  '.323.323',
  '.2.2.2.2',
  '3.2.3.2.',
  '23.323.3',
  '2.2.2.2.',
  '.2...2..',
  '........'
];
const FLOWER = ['.2.', '232', '.2.'];

const PLAYER = [
  '.....333333.....',
  '....32222223....',
  '...3222222223...',
  '...3333333333...',
  '...3100000013...',
  '...3103003013...',
  '....30000003....',
  '.....333333.....',
  '....31122113....',
  '...3311221133...',
  '...3011221103...',
  '...3311111133...',
  '....32222223....',
  '....32233223....',
  '....333..333....',
  '................'
];
const NPC = [
  '....33333333....',
  '...3333333333...',
  '..333333333333..',
  '..330000000033..',
  '..330300003033..',
  '...3000000003...',
  '....30033003....',
  '.....333333.....',
  '....32211223....',
  '...3222112223...',
  '...3022112203...',
  '...3322222233...',
  '....32222223....',
  '....32233223....',
  '....333..333....',
  '................'
];

const TILES = {
  grass(ctx, x, y, pal, r) {
    rect(ctx, x, y, 16, 16, pal[0]);
    const n = 2 + ri(r, 3);
    for (let i = 0; i < n; i++) {
      const tx = x + 1 + ri(r, 12), ty = y + 2 + ri(r, 11);
      px(ctx, tx, ty + 1, pal[2]); px(ctx, tx + 1, ty, pal[2]); px(ctx, tx + 2, ty + 1, pal[2]);
    }
    if (r() < 0.5) px(ctx, x + ri(r, 16), y + ri(r, 16), pal[1]);
  },
  tallGrass(ctx, x, y, pal) {
    rect(ctx, x, y, 16, 16, pal[1]);
    for (let by = 0; by < 16; by += 8) for (let bx = 0; bx < 16; bx += 8) drawPattern(ctx, BLADES, x + bx, y + by, pal);
  },
  tree(ctx, x, y, pal) {
    rect(ctx, x, y, 16, 16, pal[0]);
    for (let j = 0; j < 13; j++) {
      for (let i = 0; i < 16; i++) {
        const dx = i - 7.5, dy = j - 6.2;
        const d = Math.sqrt((dx * dx) / 56 + (dy * dy) / 42);
        if (d < 0.84) {
          let c = pal[1];
          if (dx + dy > 3.5) c = pal[2];
          if ((i * 7 + j * 3) % 11 === 0) c = pal[2];
          if (dx + dy < -6 && (i + j) % 3 === 0) c = pal[0];
          px(ctx, x + i, y + j, c);
        } else if (d < 1.0) px(ctx, x + i, y + j, pal[3]);
      }
    }
    rect(ctx, x + 6, y + 12, 4, 4, pal[2]);
    rect(ctx, x + 6, y + 12, 1, 4, pal[3]);
    rect(ctx, x + 9, y + 12, 1, 4, pal[3]);
    rect(ctx, x + 5, y + 15, 6, 1, pal[3]);
  },
  water(ctx, x, y, pal, r, phase = 0) {
    rect(ctx, x, y, 16, 16, pal[1]);
    for (const row of [2, 7, 12]) {
      for (let i = 0; i < 16; i++) {
        const k = (x + i + phase + row * 3) % 8;
        if (k < 3) px(ctx, x + i, y + row, pal[0]);
        else if (k < 5) px(ctx, x + i, y + row + 1, pal[2]);
      }
    }
  },
  path(ctx, x, y, pal, r) {
    rect(ctx, x, y, 16, 16, pal[0]);
    for (let i = 0; i < 6; i++) rect(ctx, x + ri(r, 15), y + ri(r, 16), 2, 1, pal[1]);
    if (r() < 0.5) px(ctx, x + ri(r, 16), y + ri(r, 16), pal[2]);
  },
  flowers(ctx, x, y, pal, r) {
    TILES.grass(ctx, x, y, pal, r);
    drawPattern(ctx, FLOWER, x + 2 + ri(r, 3), y + 2 + ri(r, 3), pal);
    drawPattern(ctx, FLOWER, x + 9 + ri(r, 3), y + 9 + ri(r, 3), pal);
  },
  fence(ctx, x, y, pal, r, grassPal) {
    TILES.grass(ctx, x, y, grassPal || pal, r);
    rect(ctx, x, y + 6, 16, 2, pal[3]);
    rect(ctx, x, y + 11, 16, 2, pal[3]);
    rect(ctx, x + 2, y + 4, 3, 11, pal[2]);
    rect(ctx, x + 11, y + 4, 3, 11, pal[2]);
    rect(ctx, x + 2, y + 4, 3, 1, pal[3]);
    rect(ctx, x + 11, y + 4, 3, 1, pal[3]);
  },
  rock(ctx, x, y, pal, r) {
    TILES.grass(ctx, x, y, pal, r);
    for (let j = 3; j < 15; j++) {
      for (let i = 1; i < 15; i++) {
        const dx = (i - 7.5) / 6.5, dy = (j - 9) / 6;
        const d = dx * dx + dy * dy;
        if (d < 0.75) px(ctx, x + i, y + j, dx + dy > 0.4 ? pal[2] : pal[1]);
        else if (d < 1) px(ctx, x + i, y + j, pal[3]);
      }
    }
  },
  ledge(ctx, x, y, pal, r) {
    TILES.grass(ctx, x, y, pal, r);
    rect(ctx, x, y + 11, 16, 2, pal[2]);
    rect(ctx, x, y + 13, 16, 1, pal[3]);
    for (let i = 0; i < 16; i += 4) px(ctx, x + i + 1, y + 10, pal[3]);
  },
  sign(ctx, x, y, pal, r, grassPal) {
    TILES.grass(ctx, x, y, grassPal || pal, r);
    rect(ctx, x + 7, y + 10, 2, 5, pal[3]);
    rect(ctx, x + 2, y + 3, 12, 8, pal[3]);
    rect(ctx, x + 3, y + 4, 10, 6, pal[1]);
    // wood grain, not letters
    rect(ctx, x + 4, y + 6, 8, 1, pal[2]);
    rect(ctx, x + 5, y + 8, 5, 1, pal[2]);
  },
  floor(ctx, x, y, pal) {
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      rect(ctx, x + i * 8, y + j * 8, 8, 8, (i + j) % 2 ? pal[1] : pal[0]);
      px(ctx, x + i * 8, y + j * 8, pal[2]);
    }
  },
  shelf(ctx, x, y, pal, r) {
    rect(ctx, x, y, 16, 16, pal[2]);
    rect(ctx, x, y + 7, 16, 1, pal[3]);
    rect(ctx, x, y + 15, 16, 1, pal[3]);
    for (let k = 0; k < 4; k++) {
      rect(ctx, x + 1 + k * 4, y + 2 + ri(r, 2), 3, 5 - ri(r, 2), k % 2 ? pal[0] : pal[1]);
      rect(ctx, x + 1 + k * 4, y + 10 + ri(r, 2), 3, 5 - ri(r, 2), k % 2 ? pal[1] : pal[0]);
    }
  },
  counter(ctx, x, y, pal) {
    rect(ctx, x, y, 16, 16, pal[1]);
    rect(ctx, x, y, 16, 3, pal[0]);
    rect(ctx, x, y + 3, 16, 1, pal[3]);
    rect(ctx, x, y + 15, 16, 1, pal[3]);
    for (let i = 2; i < 16; i += 5) rect(ctx, x + i, y + 6, 1, 7, pal[2]);
  }
};

// 64x48 house (4x3 metatiles)
function drawHouse(ctx, x, y, roofPal, wallPal) {
  rect(ctx, x, y + 2, 64, 22, roofPal[2]);
  for (let j = 0; j < 22; j += 4) rect(ctx, x, y + 2 + j, 64, 1, roofPal[3]);
  for (let j = 0; j < 22; j += 4) for (let i = (j / 4) % 2 ? 0 : 4; i < 64; i += 8) rect(ctx, x + i, y + 3 + j, 1, 3, roofPal[1]);
  rect(ctx, x, y + 2, 64, 1, roofPal[3]);
  rect(ctx, x + 46, y, 8, 8, roofPal[3]);
  rect(ctx, x + 47, y + 1, 6, 6, roofPal[1]);
  rect(ctx, x, y + 23, 64, 2, roofPal[3]);
  rect(ctx, x + 2, y + 25, 60, 23, wallPal[0]);
  rect(ctx, x + 2, y + 25, 1, 23, wallPal[3]);
  rect(ctx, x + 61, y + 25, 1, 23, wallPal[3]);
  for (let j = 28; j < 48; j += 5) rect(ctx, x + 3, y + j, 58, 1, wallPal[1]);
  for (const wx of [8, 44]) {
    rect(ctx, x + wx, y + 29, 12, 10, wallPal[3]);
    rect(ctx, x + wx + 1, y + 30, 10, 8, wallPal[1]);
    rect(ctx, x + wx + 5, y + 30, 1, 8, wallPal[3]);
    rect(ctx, x + wx + 1, y + 33, 10, 1, wallPal[3]);
  }
  rect(ctx, x + 26, y + 32, 12, 16, wallPal[3]);
  rect(ctx, x + 27, y + 33, 10, 15, wallPal[2]);
  px(ctx, x + 35, y + 41, wallPal[0]);
}

function drawCreature(ctx, r, x, y, size, pal, { back = false, scale = 1 } = {}) {
  const s = size;
  const cx = s / 2, cy = s * 0.56;
  const rx = s * (0.3 + 0.1 * r()), ry = s * (0.27 + 0.1 * r());
  const k = 3 + ri(r, 4), amp = 0.06 + 0.08 * r(), ph = r() * 6.28;
  const earW = 0.18 + 0.1 * r(), earH = 0.2 + 0.15 * r();
  const map = new Uint8Array(s * s);
  const inside = (i, j) => {
    const dx = (i - cx) / rx, dy = (j - cy) / ry;
    const a = Math.atan2(dy, dx);
    if (Math.sqrt(dx * dx + dy * dy) < 1 + amp * Math.sin(k * a + ph)) return true;
    // ears
    for (const side of [-1, 1]) {
      const ex = cx + side * rx * 0.55, ey = cy - ry * 0.8;
      const u = (i - ex) / (s * earW / 2), v = (ey - j) / (s * earH);
      if (v >= 0 && v <= 1 && Math.abs(u) <= 1 - v) return true;
    }
    // feet
    if (j > cy + ry * 0.75 && j < cy + ry * 1.15 && (Math.abs(i - (cx - rx * 0.5)) < s * 0.07 || Math.abs(i - (cx + rx * 0.5)) < s * 0.07)) return true;
    return false;
  };
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) if (inside(i + 0.5, j + 0.5)) map[j * s + i] = 1;
  const out = new Uint8Array(s * s);
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      if (!map[j * s + i]) continue;
      const edge = i === 0 || j === 0 || i === s - 1 || j === s - 1 ||
        !map[j * s + i - 1] || !map[j * s + i + 1] || !map[(j - 1) * s + i] || !map[(j + 1) * s + i];
      if (edge) out[j * s + i] = 3;
      else if ((i - cx) / rx + (j - cy) / ry > 0.7) out[j * s + i] = 2;
      else if ((i - cx) / rx + (j - cy) / ry < -1.1 && (i + j) % 2 === 0) out[j * s + i] = 4;
      else out[j * s + i] = 1;
      // belly pattern
      if (!edge && Math.abs(i - cx) < rx * 0.35 && j > cy && (i + j) % 3 === 0) out[j * s + i] = 4;
    }
  }
  if (!back) {
    for (const side of [-1, 1]) {
      const ex = Math.round(cx + side * rx * 0.38), ey = Math.round(cy - ry * 0.25);
      for (let dj = 0; dj < 3; dj++) for (let di = 0; di < 2; di++) out[(ey + dj) * s + ex + di] = 3;
      out[ey * s + ex] = 4;
    }
    const my = Math.round(cy + ry * 0.2);
    for (let i = Math.round(cx - 2); i <= Math.round(cx + 2); i++) out[my * s + i] = 3;
  }
  const colors = [null, pal[1], pal[2], pal[3], pal[0]];
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      const v = out[j * s + i];
      if (v) rect(ctx, x + i * scale, y + j * scale, scale, scale, colors[v]);
    }
  }
}

// Random overworld map. cols x rows metatiles. Returns the occupancy grid.
function drawOverworld(ctx, r, pals, cols, rows, opts = {}) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill('grass'));
  const free = (c, rr, w, h) => {
    for (let j = rr; j < rr + h; j++) for (let i = c; i < c + w; i++) {
      if (j < 0 || i < 0 || j >= rows || i >= cols || grid[j][i] !== 'grass') return false;
    }
    return true;
  };
  const fill = (c, rr, w, h, t) => { for (let j = rr; j < rr + h; j++) for (let i = c; i < c + w; i++) grid[j][i] = t; };
  // tree border with a few gaps
  for (let j = 0; j < rows; j++) { if (r() < 0.85) grid[j][0] = 'tree'; if (r() < 0.85) grid[j][cols - 1] = 'tree'; }
  for (let i = 0; i < cols; i++) if (r() < 0.8) grid[0][i] = 'tree';
  // path
  if (r() < 0.5) { const pc = 2 + ri(r, cols - 4); for (let j = 1; j < rows; j++) grid[j][pc] = 'path'; }
  else { const pr = 2 + ri(r, rows - 3); for (let i = 1; i < cols - 1; i++) grid[pr][i] = 'path'; }
  // house
  if (opts.house !== false) {
    for (let tries = 0; tries < 30; tries++) {
      const c = 1 + ri(r, cols - 5), rr = 1 + ri(r, Math.max(1, rows - 4));
      if (free(c, rr, 4, 3)) { fill(c, rr, 4, 3, 'house'); grid[rr][c] = 'house@'; break; }
    }
  }
  // pond
  for (let tries = 0; tries < 30; tries++) {
    const w = 2 + ri(r, 2), h = 2, c = 1 + ri(r, cols - w - 1), rr = 1 + ri(r, rows - h - 1);
    if (free(c, rr, w, h)) { fill(c, rr, w, h, 'water'); break; }
  }
  // tall grass patches
  for (let p = 0; p < 2; p++) {
    for (let tries = 0; tries < 30; tries++) {
      const w = 2 + ri(r, 2), h = 1 + ri(r, 2), c = 1 + ri(r, cols - w - 1), rr = 1 + ri(r, rows - h - 1);
      if (free(c, rr, w, h)) { fill(c, rr, w, h, 'tallGrass'); break; }
    }
  }
  // scatter
  const scatter = ['flowers', 'flowers', 'flowers', 'rock', 'fence', 'fence', 'sign', 'ledge', 'tree'];
  for (let n = 0; n < Math.round(cols * rows * 0.12); n++) {
    const c = 1 + ri(r, cols - 2), rr = 1 + ri(r, rows - 2);
    if (grid[rr][c] === 'grass') grid[rr][c] = scatter[ri(r, scatter.length)];
  }
  const phase = ri(r, 8);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const t = grid[j][i], x = i * 16, y = j * 16;
      switch (t) {
        case 'grass': TILES.grass(ctx, x, y, pals.grass, r); break;
        case 'tallGrass': TILES.tallGrass(ctx, x, y, pals.tallGrass, r); break;
        case 'tree': TILES.tree(ctx, x, y, pals.tree, r); break;
        case 'water': TILES.water(ctx, x, y, pals.water, r, phase); break;
        case 'path': TILES.path(ctx, x, y, pals.path, r); break;
        case 'flowers': TILES.flowers(ctx, x, y, pals.flower, r); break;
        case 'rock': TILES.rock(ctx, x, y, pals.rock, r); break;
        case 'fence': TILES.fence(ctx, x, y, pals.wall, r, pals.grass); break;
        case 'sign': TILES.sign(ctx, x, y, pals.wall, r, pals.grass); break;
        case 'ledge': TILES.ledge(ctx, x, y, pals.grass, r); break;
        default: break;
      }
    }
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    if (grid[j][i] === 'house@') drawHouse(ctx, i * 16, j * 16, opts.roofPal || pals.roof, pals.wall);
  }
  // sprites on walkable tiles
  const spots = [];
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) if (['grass', 'path'].includes(grid[j][i])) spots.push([i, j]);
  const nSprites = opts.sprites ?? 2;
  for (let n = 0; n < nSprites && spots.length; n++) {
    const [i, j] = spots.splice(ri(r, spots.length), 1)[0];
    drawPattern(ctx, n === 0 ? PLAYER : NPC, i * 16, j * 16 - 4, pals.sprite, 1, r() < 0.5);
  }
  return grid;
}

function drawInterior(ctx, r, pals, cols, rows) {
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) TILES.floor(ctx, i * 16, j * 16, pals.floor);
  for (let i = 0; i < cols; i++) TILES.shelf(ctx, i * 16, 0, pals.wall, r);
  for (let j = 2; j < rows - 1; j += 2) for (let i = cols - 4; i < cols - 1; i++) TILES.shelf(ctx, i * 16, j * 16, pals.wall, r);
  for (let j = 2; j < 5; j++) TILES.counter(ctx, 16, j * 16, pals.wall);
  drawPattern(ctx, NPC, 0, 3 * 16 - 4, pals.sprite);
  drawPattern(ctx, PLAYER, 3 * 16, 4 * 16 - 4, pals.sprite, 1, true);
}

// ------------------------------------------------------ GB text boxes ---

const BOX_STYLES = {
  // double rule (Gen 1 feel)
  double: {
    tl: ['........', '........', '..333333', '..3.....', '..3.3333', '..3.3...', '..3.3...', '..3.3...'],
    t: ['........', '........', '33333333', '........', '33333333', '........', '........', '........'],
    l: ['..3.3...', '..3.3...', '..3.3...', '..3.3...', '..3.3...', '..3.3...', '..3.3...', '..3.3...']
  },
  // rounded thick rule with a soft outer line (Gen 2 feel)
  rounded: {
    tl: ['........', '...22222', '..233333', '.233....', '.23.....', '.23.....', '.23.....', '.23.....'],
    t: ['........', '22222222', '33333333', '........', '........', '........', '........', '........'],
    l: ['.23.....', '.23.....', '.23.....', '.23.....', '.23.....', '.23.....', '.23.....', '.23.....']
  }
};

// box covering tile cols c0..c1, rows r0..r1 (inclusive)
function drawTileBox(ctx, c0, r0, c1, r1, style, pal) {
  const st = BOX_STYLES[style];
  const tl = st.tl, tr = flipRowsH(st.tl), bl = flipRowsV(st.tl), br = flipRowsH(flipRowsV(st.tl));
  const t = st.t, b = flipRowsV(st.t), l = st.l, rr = flipRowsH(st.l);
  rect(ctx, c0 * 8, r0 * 8, (c1 - c0 + 1) * 8, (r1 - r0 + 1) * 8, pal[0]);
  const tile = (rows, c, r) => drawPattern(ctx, rows.map((row) => row.replace(/\./g, '0')), c * 8, r * 8, pal);
  tile(tl, c0, r0); tile(tr, c1, r0); tile(bl, c0, r1); tile(br, c1, r1);
  for (let c = c0 + 1; c < c1; c++) { tile(t, c, r0); tile(b, c, r1); }
  for (let r = r0 + 1; r < r1; r++) { tile(l, c0, r); tile(rr, c1, r); }
}

function joinGT(lines) {
  let out = '';
  for (const l of lines) {
    if (!out) { out = l; continue; }
    if (/\p{Ll}-$/u.test(out) && /^\p{Ll}/u.test(l)) out = out.slice(0, -1) + l;
    else out += ' ' + l;
  }
  return out;
}

function region(kind, rawLines) {
  const lines = rawLines.map(textForGroundTruth).filter(Boolean);
  return { kind, lines, text: joinGT(lines) };
}

// items: [{ text, col, row }] -> GT lines grouped by row, ordered by col
function gtLinesFromItems(items) {
  const rows = new Map();
  for (const it of items) {
    if (!rows.has(it.row)) rows.set(it.row, []);
    rows.get(it.row).push(it);
  }
  return [...rows.keys()].sort((a, b) => a - b)
    .map((k) => rows.get(k).sort((a, b) => a.col - b.col).map((it) => it.text).join(' '));
}

function tileText(ctx, font, text, col, row, color, maxChars) {
  if (col + [...text].length > 20) throw new Error(`text ${JSON.stringify(text)} at col ${col} overflows the 20-tile screen`);
  return drawTileText(ctx, font, text, col * 8, row * 8, color, maxChars);
}

// Gen 1/2 dialog box (rows 12-17). lines: up to 2 strings (max 18 chars).
// opts: { arrow, typed: [n1, n2] (typewriter prefix lengths) }
function gbDialog(ctx, font, pal, style, lines, opts = {}) {
  drawTileBox(ctx, 0, 12, 19, 17, style, pal);
  const typed = opts.typed || [];
  const shown = [];
  lines.forEach((line, i) => {
    if ([...line].length > 18) throw new Error(`dialog line too long for a GB box: ${JSON.stringify(line)}`);
    const n = typed[i] ?? Infinity;
    tileText(ctx, font, line, 1, 14 + i * 2, pal[3], n);
    shown.push([...line].slice(0, n).join(''));
  });
  if (opts.arrow) tileText(ctx, font, '▼', 18, 16, pal[3]);
  return shown;
}

function gbMenu(ctx, font, pal, style, box, items, cursor) {
  drawTileBox(ctx, box[0], box[1], box[2], box[3], style, pal);
  for (const it of items) {
    if (it.col + [...it.text].length > box[2]) throw new Error(`menu item ${JSON.stringify(it.text)} overflows its box`);
    tileText(ctx, font, it.text, it.col, it.row, pal[3]);
  }
  if (cursor) tileText(ctx, font, '▶', cursor[0], cursor[1], pal[3]);
  return gtLinesFromItems(items);
}

function hpBarGB(ctx, pal, x, y, tiles, frac) {
  const w = tiles * 8;
  rect(ctx, x, y + 2, 1, 4, pal[3]);
  rect(ctx, x + w - 1, y + 1, 1, 6, pal[3]);
  rect(ctx, x, y + 5, w, 1, pal[3]);
  rect(ctx, x + 1, y + 2, w - 2, 1, pal[3]);
  rect(ctx, x + 2, y + 3, Math.round((w - 4) * frac), 2, pal[2]);
}

// Gen 1 style battle HUDs + sprites; returns [enemyRegion, playerRegion]
function gbBattle(ctx, r, font, pal, b, { hud = true, creaturePal = pal } = {}) {
  rect(ctx, 0, 0, GB_W, GB_H, pal[0]);
  drawCreature(ctx, r, 100, 2, 52, creaturePal);
  drawCreature(ctx, r, 8, 42, 27, creaturePal, { back: true, scale: 2 });
  if (!hud) return [];
  // enemy: name row 0, level row 1, HP row 2, L-shaped frame
  tileText(ctx, font, b.enemy, 1, 0, pal[3]);
  tileText(ctx, font, TILE_LV + b.enemyLv, 5, 1, pal[3]);
  tileText(ctx, font, TILE_HP + ':', 2, 2, pal[3]);
  hpBarGB(ctx, pal, 32, 16, 6, b.enemyHp ?? 1);
  rect(ctx, 8, 12, 1, 15, pal[3]);
  rect(ctx, 8, 26, 76, 1, pal[3]);
  rect(ctx, 84, 25, 2, 3, pal[3]);
  // player: name row 7, level row 8, HP row 9, numbers row 10, frame
  tileText(ctx, font, b.player, 10, 7, pal[3]);
  tileText(ctx, font, TILE_LV + b.playerLv, 14, 8, pal[3]);
  tileText(ctx, font, TILE_HP + ':', 10, 9, pal[3]);
  hpBarGB(ctx, pal, 96, 72, 6, b.hp / b.maxHp);
  const nums = `${String(b.hp).padStart(2, ' ')}/${String(b.maxHp).padStart(3, ' ')}`;
  tileText(ctx, font, nums, 11, 10, pal[3]);
  rect(ctx, 152, 64, 1, 27, pal[3]);
  rect(ctx, 76, 90, 77, 1, pal[3]);
  rect(ctx, 74, 89, 2, 3, pal[3]);
  return [
    region('hud', [b.enemy, TILE_LV + b.enemyLv, TILE_HP + ':']),
    region('hud', [b.player, TILE_LV + b.playerLv, TILE_HP + ':', nums])
  ];
}

// ---------------------------------------------------------- GBA boxes ---

function roundRect(ctx, x, y, w, h, c, rad = 2) {
  rect(ctx, x + rad, y, w - rad * 2, h, c);
  rect(ctx, x, y + rad, w, h - rad * 2, c);
  if (rad >= 2) { rect(ctx, x + 1, y + 1, w - 2, h - 2, c); }
}

// layered frame: [[color, inset], ...] outermost first, then fill
function gbaFrame(ctx, x, y, w, h, layers, fill) {
  let i = 0;
  for (const c of layers) { roundRect(ctx, x + i, y + i, w - i * 2, h - i * 2, c, i === 0 ? 3 : 2); i++; }
  roundRect(ctx, x + i, y + i, w - i * 2, h - i * 2, fill, 1);
}

const GBA_DIALOG = { x: 2, y: 113, w: 236, h: 45, textX: 11, textY: 118, pitch: 16 };
const GBA_INK = { text: '#484848', shadow: '#d0d0c8' };

function propText(ctx, text, x, y, color, shadow, maxX, maxChars) {
  const w = measurePropText(GBA_FONT, text);
  if (maxX != null && x + w > maxX) throw new Error(`GBA text ${JSON.stringify(text)} (${w}px) overflows its box`);
  return drawPropText(ctx, GBA_FONT, text, x, y, color, shadow, maxChars);
}

function gbaDialog(ctx, lines, opts = {}) {
  const d = GBA_DIALOG;
  gbaFrame(ctx, d.x, d.y, d.w, d.h, ['#384868', '#7890c0', '#c8d8f0'], '#ffffff');
  const typed = opts.typed || [];
  const shown = [];
  let endX = 0;
  lines.forEach((line, i) => {
    const n = typed[i] ?? Infinity;
    endX = propText(ctx, line, d.textX, d.textY + i * d.pitch, GBA_INK.text, GBA_INK.shadow, d.x + d.w - 12, n);
    shown.push([...line].slice(0, n).join(''));
  });
  if (opts.arrow) {
    const ay = d.textY + (lines.length - 1) * d.pitch + 3;
    const ax = endX + 3;
    for (let k = 0; k < 4; k++) rect(ctx, ax + k, ay + k, 7 - k * 2, 1, '#e03828');
  }
  return shown;
}

function hpBarGBA(ctx, x, y, w, frac) {
  rect(ctx, x - 16, y - 1, w + 18, 5, '#404850');
  // tiny "HP" label (3x3 letters, yellow) - graphic, like the games
  const H = ['#.#', '###', '#.#'], P = ['##.', '##.', '#..'];
  drawPattern(ctx, H.map((r) => r.replace(/#/g, '0')), x - 14, y, ['#f8d830']);
  drawPattern(ctx, P.map((r) => r.replace(/#/g, '0')), x - 10, y, ['#f8d830']);
  rect(ctx, x, y, w, 3, '#506058');
  rect(ctx, x, y, Math.round(w * frac), 3, frac > 0.5 ? '#58d080' : frac > 0.2 ? '#f8c830' : '#f05838');
  rect(ctx, x, y, Math.round(w * frac), 1, frac > 0.5 ? '#98f8b0' : '#f8e888');
}

function gbaBattleBackground(ctx, r) {
  for (let y = 0; y < 112; y++) {
    const t = y / 112;
    const c = `rgb(${Math.round(200 + 40 * t)},${Math.round(232 - 20 * t)},${Math.round(200 - 60 * t)})`;
    rect(ctx, 0, y, GBA_W, 1, c);
    if (y % 6 === 0) for (let x = (y * 7) % 13; x < GBA_W; x += 13) rect(ctx, x, y, 4, 1, '#d8e8b8');
  }
  const ellipse = (cx, cy, rx, ry, fill, edge) => {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d <= 1) px(ctx, x, y, d > 0.8 ? edge : ((x + y) % 5 === 0 ? edge : fill));
      }
    }
  };
  ellipse(178, 66, 48, 11, '#88c060', '#609840');
  ellipse(64, 108, 60, 12, '#88c060', '#609840');
  for (let i = 0; i < 25; i++) {
    const x = ri(r, GBA_W), y = 30 + ri(r, 80);
    rect(ctx, x, y, 1, 2, '#78a850');
  }
}

function gbaHud(ctx, x, y, w, h, nameRow, lvText, extraRows = []) {
  gbaFrame(ctx, x, y, w, h, ['#384030', '#f8f8d8'], '#f8f8e0');
  rect(ctx, x + 3, y + h - 3, w - 6, 1, '#c8c8a0');
  propText(ctx, nameRow.name, x + 7, y + 3, GBA_INK.text, GBA_INK.shadow, x + w);
  const nameEnd = x + 7 + measurePropText(GBA_FONT, nameRow.name);
  if (nameRow.gender) propText(ctx, nameRow.gender, nameEnd + 1, y + 3, nameRow.gender === '♂' ? '#4060d8' : '#e04848', '#d0d0c8');
  propText(ctx, lvText, x + w - 8 - measurePropText(GBA_FONT, lvText), y + 3, GBA_INK.text, GBA_INK.shadow, x + w);
  for (const row of extraRows) propText(ctx, row.text, row.x, row.y, GBA_INK.text, GBA_INK.shadow, x + w);
}

// Gen 3 style battle: background, creatures, HUDs. Returns hud regions.
function gbaBattle(ctx, r, b, { hud = true } = {}) {
  gbaBattleBackground(ctx, r);
  const cpal = ['#f8f8f8', b.enemyColor || '#a0a0b8', '#606078', '#282838'];
  drawCreature(ctx, r, 154, 14, 50, cpal);
  drawCreature(ctx, r, 30, 54, 30, GBA_PALS.creature, { back: true, scale: 2 });
  if (!hud) return [];
  gbaHud(ctx, 13, 14, 100, 30, { name: b.enemy, gender: b.enemyGender }, 'Lv' + b.enemyLv);
  hpBarGBA(ctx, 60, 34, 48, b.enemyHp ?? 1);
  const nums = `${String(b.hp).padStart(2, ' ')}/${String(b.maxHp).padStart(3, ' ')}`;
  gbaHud(ctx, 126, 72, 108, 40, { name: b.player, gender: b.playerGender }, 'Lv' + b.playerLv,
    [{ text: nums, x: 196, y: 98 }]);
  hpBarGBA(ctx, 178, 92, 48, b.hp / b.maxHp);
  rect(ctx, 150, 109, 80, 2, '#4870c0');
  return [
    region('hud', [b.enemy + ' Lv' + b.enemyLv, 'HP']),
    region('hud', [b.player + ' Lv' + b.playerLv, 'HP', nums])
  ];
}

function gbaBattleMessage(ctx, lines, { menu = null, typed = [] } = {}) {
  gbaFrame(ctx, 0, 112, GBA_W, 48, ['#202838', '#d8d8d0', '#486078'], '#28506a');
  const maxX = menu ? 118 : GBA_W - 8;
  const shown = [];
  lines.forEach((line, i) => {
    const n = typed[i] ?? Infinity;
    propText(ctx, line, 11, 120 + i * 16, '#f8f8f8', '#685868', maxX, n);
    shown.push([...line].slice(0, n).join(''));
  });
  let menuLines = null;
  if (menu) {
    gbaFrame(ctx, 120, 112, 120, 48, ['#202838', '#6878a8', '#c8d0e8'], '#f8f8f8');
    const cols = [136, 192];
    menu.items.forEach((it, i) => {
      propText(ctx, it, cols[i % 2], 121 + Math.floor(i / 2) * 16, GBA_INK.text, GBA_INK.shadow, 238);
    });
    propText(ctx, '▶', cols[menu.cursor % 2] - 9, 121 + Math.floor(menu.cursor / 2) * 16, GBA_INK.text, GBA_INK.shadow);
    menuLines = [menu.items.slice(0, 2).join(' '), menu.items.slice(2, 4).join(' ')];
  }
  return { shown, menuLines };
}

function gbaOverworld(ctx, r, opts = {}) {
  drawOverworld(ctx, r, GBA_PALS, 15, 10, { roofPal: r() < 0.5 ? GBA_PALS.roof : GBA_PALS.roofBlue, sprites: 3, ...opts });
}

// ------------------------------------------------------------- scenes ---
// build(ctx, r) draws the frame and returns the GT regions.

const S = [];
function scene(def) { S.push(def); }

function gb1(def) {
  scene({ platform: 'gb', font: 'gb-bold', palette: 'dmg-gray', ...def });
}
function gb2(def) {
  scene({ platform: 'gb', font: 'gb-thin', palette: 'gbc-day', ...def });
}
function gba(def) {
  scene({ platform: 'gba', font: 'gba', palette: 'gba', ...def });
}

function gb1Pals(name) { return uniformPals(GB_PALETTES[name]); }

function gb1DialogScene({ id, lang, palette = 'dmg-gray', lines, arrow = false, typed, partial = false, kind = 'dialog', frameKind = 'overworld-dialog', interior = false }) {
  gb1({
    id, lang, palette, frameKind, partial,
    build(ctx, r) {
      const pals = gb1Pals(palette);
      if (interior) drawInterior(ctx, r, pals, 10, 9); else drawOverworld(ctx, r, pals, 10, 9);
      const shown = gbDialog(ctx, GB_BOLD, GB_PALETTES[palette], 'double', lines, { arrow, typed });
      return [region(kind, shown)];
    }
  });
}

function gb2DialogScene({ id, lang, night = false, lines, arrow = false, kind = 'dialog' }) {
  gb2({
    id, lang, palette: night ? 'gbc-night' : 'gbc-day', frameKind: 'overworld-dialog',
    build(ctx, r) {
      const pals = night ? GBC_NIGHT : GBC_DAY;
      drawOverworld(ctx, r, pals, 10, 9);
      const shown = gbDialog(ctx, GB_THIN, pals.text, 'rounded', lines, { arrow });
      return [region(kind, shown)];
    }
  });
}

// --- Gen 1 style overworld dialog ---
gb1DialogScene({ id: 'gb1-oak-hello-en', lang: 'en', lines: ['Hello there!', 'Welcome to the'], arrow: true });
gb1DialogScene({ id: 'gb1-oak-world-en', lang: 'en', palette: 'dmg-green', lines: ['world of POKéMON!'] });
gb1DialogScene({ id: 'gb1-oak-hello-de', lang: 'de', palette: 'gbc-red', lines: ['Hallo! Willkommen', 'in der Welt der'], arrow: true });
gb1DialogScene({ id: 'gb1-oak-world-de', lang: 'de', palette: 'gbc-blue', lines: ['POKéMON!'] });
gb1DialogScene({ id: 'gb1-grass-warning-de', lang: 'de', palette: 'dmg-green', lines: ['Vorsicht! Im Gras', 'lauern POKéMON!'] });
gb1DialogScene({ id: 'gb1-draussen-de', lang: 'de', lines: ['Draußen im Gras', 'ist es gefährlich!'], arrow: true });
gb1DialogScene({ id: 'gb1-pokedex-hyphen-de', lang: 'de', palette: 'gbc-red', lines: ['Der POKéDEX zeich-', 'net Daten auf.'], arrow: true });
gb1DialogScene({ id: 'gb1-hello-fr', lang: 'fr', palette: 'gbc-blue', lines: ['Bonjour! Bienvenue', 'dans le monde des'], arrow: true });
gb1DialogScene({ id: 'gb1-hola-es', lang: 'es', palette: 'dmg-green', lines: ['¡Hola! ¡Bienvenido', 'al mundo de los'], arrow: true });
gb1DialogScene({ id: 'gb1-nino-es', lang: 'es', lines: ['El niño de al lado', 'también entrena.'] });

// --- Gen 1 style battle ---
function gb1BattleScene({ id, lang, palette = 'dmg-gray', battle, dialog, menu }) {
  gb1({
    id, lang, palette, frameKind: menu ? 'battle-menu' : 'battle-dialog',
    build(ctx, r) {
      const pal = GB_PALETTES[palette];
      const regions = gbBattle(ctx, r, GB_BOLD, pal, battle);
      if (dialog) {
        const shown = gbDialog(ctx, GB_BOLD, pal, 'double', dialog.lines, { arrow: dialog.arrow });
        regions.push(region('dialog', shown));
      }
      if (menu) {
        drawTileBox(ctx, 0, 12, 19, 17, 'double', pal);
        const lines = gbMenu(ctx, GB_BOLD, pal, 'double', menu.box, menu.items, menu.cursor);
        regions.push(region('menu', lines));
      }
      return regions;
    }
  });
}
const BATTLE_EN = { enemy: 'PIDGEY', enemyLv: '3', player: 'BULBASAUR', playerLv: '5', hp: 19, maxHp: 20, enemyHp: 1 };
const BATTLE_DE = { enemy: 'TAUBSI', enemyLv: '3', player: 'BISASAM', playerLv: '5', hp: 19, maxHp: 20, enemyHp: 1 };
gb1BattleScene({ id: 'gb1-battle-wild-en', lang: 'en', battle: BATTLE_EN, dialog: { lines: ['Wild PIDGEY', 'appeared!'], arrow: true } });
gb1BattleScene({ id: 'gb1-battle-wild-de', lang: 'de', palette: 'gbc-red', battle: BATTLE_DE, dialog: { lines: ['Ein wildes TAUBSI', 'erscheint!'], arrow: true } });
gb1BattleScene({
  id: 'gb1-battle-menu-en', lang: 'en', palette: 'dmg-green', battle: { ...BATTLE_EN, enemyHp: 0.6 },
  menu: {
    box: [8, 12, 19, 17], cursor: [9, 14],
    items: [{ text: 'FIGHT', col: 10, row: 14 }, { text: TILE_PK + TILE_MN, col: 16, row: 14 }, { text: 'ITEM', col: 10, row: 16 }, { text: 'RUN', col: 16, row: 16 }]
  }
});
gb1BattleScene({
  id: 'gb1-battle-menu-de', lang: 'de', palette: 'gbc-blue', battle: { ...BATTLE_DE, hp: 7, enemyHp: 0.4 },
  menu: {
    box: [5, 12, 19, 17], cursor: [6, 14],
    items: [{ text: 'KAMPF', col: 7, row: 14 }, { text: 'POKé', col: 13, row: 14 }, { text: 'ITEM', col: 7, row: 16 }, { text: 'FLUCHT', col: 13, row: 16 }]
  }
});

// --- Gen 1 style START menu ---
function gb1StartMenu({ id, lang, palette, box, items, cursorRow }) {
  gb1({
    id, lang, palette, frameKind: 'start-menu',
    build(ctx, r) {
      const pal = GB_PALETTES[palette];
      drawOverworld(ctx, r, uniformPals(pal), 10, 9);
      const col = box[0] + 2;
      const its = items.map((t, i) => ({ text: t, col, row: 2 + i * 2 }));
      const lines = gbMenu(ctx, GB_BOLD, pal, 'double', box, its, [col - 1, cursorRow]);
      return [region('menu', lines)];
    }
  });
}
gb1StartMenu({ id: 'gb1-start-menu-en', lang: 'en', palette: 'dmg-gray', box: [10, 0, 19, 15], items: ['POKéDEX', 'POKéMON', 'ITEM', 'RED', 'SAVE', 'OPTION', 'EXIT'], cursorRow: 2 });
gb1StartMenu({ id: 'gb1-start-menu-de', lang: 'de', palette: 'gbc-red', box: [9, 0, 19, 15], items: ['POKéDEX', 'POKéMON', 'ITEM', 'ROT', 'SICHERN', 'OPTIONEN', 'ZURÜCK'], cursorRow: 4 });

// --- Gen 1 style YES/NO over dialog ---
function gb1YesNo({ id, lang, palette, lines, box, yes, no }) {
  gb1({
    id, lang, palette, frameKind: 'yes-no',
    build(ctx, r) {
      const pal = GB_PALETTES[palette];
      drawOverworld(ctx, r, uniformPals(pal), 10, 9);
      const shown = gbDialog(ctx, GB_BOLD, pal, 'double', lines);
      const col = box[0] + 2;
      const menuLines = gbMenu(ctx, GB_BOLD, pal, 'double', box, [{ text: yes, col, row: box[1] + 1 }, { text: no, col, row: box[1] + 3 }], [col - 1, box[1] + 1]);
      return [region('menu', menuLines), region('dialog', shown)];
    }
  });
}
gb1YesNo({ id: 'gb1-yesno-save-en', lang: 'en', palette: 'dmg-gray', lines: ['Would you like to', 'SAVE the game?'], box: [14, 7, 19, 11], yes: 'YES', no: 'NO' });
gb1YesNo({ id: 'gb1-yesno-save-de', lang: 'de', palette: 'dmg-green', lines: ['Möchtest du das', 'Spiel SICHERN?'], box: [13, 7, 19, 11], yes: 'JA', no: 'NEIN' });

// --- Gen 1 style mart with money box ---
gb1({
  id: 'gb1-mart-money-en', lang: 'en', palette: 'gbc-blue', frameKind: 'mart',
  build(ctx, r) {
    const pal = GB_PALETTES['gbc-blue'];
    drawInterior(ctx, r, uniformPals(pal), 10, 9);
    drawTileBox(ctx, 11, 0, 19, 2, 'double', pal);
    tileText(ctx, GB_BOLD, '$3000', 13, 1, pal[3]);
    const shown = gbDialog(ctx, GB_BOLD, pal, 'double', ['Hi there!', 'May I help you?'], { arrow: true });
    return [region('hud', ['$3000']), region('dialog', shown)];
  }
});

// --- Gen 2 style (GBC colours, thin font) ---
gb2DialogScene({ id: 'gb2-shorts-en', lang: 'en', lines: ['Hi, I like shorts!', "They're comfy and"], arrow: true });
gb2DialogScene({ id: 'gb2-shorts-de', lang: 'de', night: true, lines: ['Ich trage gern', 'kurze Hosen!'], arrow: true });
gb2DialogScene({ id: 'gb2-sign-en', lang: 'en', lines: ['NEW BARK TOWN', 'The Town Where the'], kind: 'sign', arrow: true });
gb2DialogScene({ id: 'gb2-recu-fr', lang: 'fr', lines: ['Voilà! Tu as reçu', 'une POKé BALL.'] });
gb2DialogScene({ id: 'gb2-aqui-es', lang: 'es', night: true, lines: ['Aquí está tu', 'POKéMON. ¡Cuídalo!'] });
gb2({
  id: 'gb2-mart-de', lang: 'de', palette: 'gbc-day', frameKind: 'mart',
  build(ctx, r) {
    const pals = GBC_DAY;
    drawInterior(ctx, r, pals, 10, 9);
    drawTileBox(ctx, 8, 0, 19, 2, 'rounded', pals.text);
    tileText(ctx, GB_THIN, 'GELD 3000¥', 9, 1, pals.text[3]);
    const menu = gbMenu(ctx, GB_THIN, pals.text, 'rounded', [0, 3, 11, 9],
      [{ text: 'KAUFEN', col: 2, row: 4 }, { text: 'VERKAUFEN', col: 2, row: 6 }, { text: 'TSCHÜSS!', col: 2, row: 8 }], [1, 4]);
    const shown = gbDialog(ctx, GB_THIN, pals.text, 'rounded', ['Hallo! Willkommen', 'im POKéMON-MARKT!']);
    return [region('hud', ['GELD 3000¥']), region('menu', menu), region('dialog', shown)];
  }
});

// --- GBA Gen 3 style ---
function gbaDialogScene({ id, lang, lines, arrow = true, typed, partial = false }) {
  gba({
    id, lang, frameKind: 'overworld-dialog', partial,
    build(ctx, r) {
      gbaOverworld(ctx, r);
      const shown = gbaDialog(ctx, lines, { arrow: arrow && !partial, typed });
      return [region('dialog', shown)];
    }
  });
}
gbaDialogScene({ id: 'gba-oak-hello-en', lang: 'en', lines: ['Hello there! Glad to meet you!', 'Welcome to the world of POKéMON!'] });
gbaDialogScene({ id: 'gba-oak-hello-de', lang: 'de', lines: ['Hallo! Schön, dich kennen zu lernen!', 'Willkommen in der Welt der POKéMON!'] });
gbaDialogScene({ id: 'gba-oak-hello-es', lang: 'es', lines: ['¡Hola! ¡Encantado de conocerte!', '¡Bienvenido al mundo de los POKéMON!'] });
gbaDialogScene({ id: 'gba-oak-hello-fr', lang: 'fr', lines: ['Bonjour! Ravi de te rencontrer!', 'Bienvenue dans le monde des POKéMON!'], arrow: false });

function gbaBattleScene({ id, lang, battle, message, menu }) {
  gba({
    id, lang, frameKind: menu ? 'battle-menu' : 'battle-dialog',
    build(ctx, r) {
      const regions = gbaBattle(ctx, r, battle);
      const { shown, menuLines } = gbaBattleMessage(ctx, message, { menu });
      regions.push(region('dialog', shown));
      if (menuLines) regions.push(region('menu', menuLines));
      return regions;
    }
  });
}
const GBA_BATTLE_EN = { enemy: 'POOCHYENA', enemyGender: '♂', enemyLv: '2', player: 'TORCHIC', playerGender: '♂', playerLv: '5', hp: 19, maxHp: 20, enemyHp: 1, enemyColor: '#8890a8' };
const GBA_BATTLE_DE = { enemy: 'FIFFYEN', enemyGender: '♀', enemyLv: '2', player: 'FLEMMLI', playerGender: '♂', playerLv: '5', hp: 19, maxHp: 20, enemyHp: 0.7, enemyColor: '#9888a0' };
gbaBattleScene({ id: 'gba-battle-menu-en', lang: 'en', battle: GBA_BATTLE_EN, message: ['What will', 'TORCHIC do?'], menu: { items: ['FIGHT', 'BAG', 'POKéMON', 'RUN'], cursor: 0 } });
gbaBattleScene({ id: 'gba-battle-menu-de', lang: 'de', battle: GBA_BATTLE_DE, message: ['Was soll', 'FLEMMLI tun?'], menu: { items: ['KAMPF', 'BEUTEL', 'POKéMON', 'FLUCHT'], cursor: 1 } });
gbaBattleScene({ id: 'gba-battle-appeared-en', lang: 'en', battle: GBA_BATTLE_EN, message: ['Wild POOCHYENA appeared!'] });

gba({
  id: 'gba-route-sign-en', lang: 'en', frameKind: 'location-sign',
  build(ctx, r) {
    gbaOverworld(ctx, r);
    const label = 'ROUTE 101';
    gbaFrame(ctx, 0, 0, 92, 24, ['#583818', '#b88848'], '#e0c088');
    for (let x = 4; x < 88; x += 6) rect(ctx, x, 4, 3, 1, '#d0a868');
    const w = measurePropText(GBA_FONT, label);
    propText(ctx, label, Math.round((92 - w) / 2), 6, '#403020', '#f8e0b0', 90);
    return [region('sign', [label])];
  }
});

gba({
  id: 'gba-start-menu-en', lang: 'en', frameKind: 'start-menu',
  build(ctx, r) {
    gbaOverworld(ctx, r);
    const items = ['POKéDEX', 'POKéMON', 'BAG', 'MAY', 'SAVE', 'OPTION', 'EXIT'];
    gbaFrame(ctx, 176, 2, 62, 8 + items.length * 16, ['#384868', '#7890c0', '#c8d8f0'], '#ffffff');
    items.forEach((t, i) => propText(ctx, t, 192, 8 + i * 16, GBA_INK.text, GBA_INK.shadow, 236));
    propText(ctx, '▶', 183, 8 + 16, GBA_INK.text, GBA_INK.shadow);
    return [region('menu', items)];
  }
});

// --- partial (typewriter) frames: text half printed, flagged partial ---
gb1DialogScene({ id: 'gb1-partial-hello-en', lang: 'en', lines: ['Hello there!', 'Welcome to the'], typed: [Infinity, 4], partial: true });
gb1DialogScene({ id: 'gb1-partial-hello-de', lang: 'de', palette: 'gbc-red', lines: ['Hallo! Willkommen', 'in der Welt der'], typed: [12, 0], partial: true });
gbaDialogScene({ id: 'gba-partial-hello-en', lang: 'en', lines: ['Hello there! Glad to meet you!', 'Welcome to the world of POKéMON!'], typed: [23, 0], partial: true });

// --- NO-TEXT frames (false-positive measurement) ---
gb1({
  id: 'gb1-overworld-notext', lang: 'en', palette: 'dmg-gray', frameKind: 'no-text',
  build(ctx, r) { drawOverworld(ctx, r, gb1Pals('dmg-gray'), 10, 9, { sprites: 3 }); return []; }
});
gb2({
  id: 'gb2-overworld-notext', lang: 'de', palette: 'gbc-day', frameKind: 'no-text',
  build(ctx, r) { drawOverworld(ctx, r, GBC_DAY, 10, 9, { sprites: 3 }); return []; }
});
gb1({
  id: 'gb1-battle-intro-notext', lang: 'en', palette: 'dmg-green', frameKind: 'no-text',
  build(ctx, r) {
    const pal = GB_PALETTES['dmg-green'];
    gbBattle(ctx, r, GB_BOLD, pal, BATTLE_EN, { hud: false });
    drawTileBox(ctx, 0, 12, 19, 17, 'double', pal);
    return [];
  }
});
gba({
  id: 'gba-overworld-notext', lang: 'en', frameKind: 'no-text',
  build(ctx, r) { gbaOverworld(ctx, r, { sprites: 4 }); return []; }
});
gba({
  id: 'gba-battle-intro-notext', lang: 'en', frameKind: 'no-text',
  build(ctx, r) {
    gbaBattle(ctx, r, GBA_BATTLE_EN, { hud: false });
    gbaBattleMessage(ctx, []);
    return [];
  }
});

export const SCENES = S;

export function getScene(id) {
  const s = S.find((x) => x.id === id);
  if (!s) throw new Error('unknown scene ' + id);
  return s;
}

export function renderScene(idOrScene) {
  const s = typeof idOrScene === 'string' ? getScene(idOrScene) : idOrScene;
  const w = s.platform === 'gba' ? GBA_W : GB_W;
  const h = s.platform === 'gba' ? GBA_H : GB_H;
  const canvas = newCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const r = mulberry32(hashStr(s.id));
  const regions = s.build(ctx, r) || [];
  return {
    canvas,
    truth: {
      id: s.id, platform: s.platform, lang: s.lang, frameKind: s.frameKind,
      partial: !!s.partial, palette: s.palette, font: s.font,
      nativeW: w, nativeH: h, regions
    }
  };
}

// ground truth for every scene (renders each once)
export function allTruths() { return S.map((s) => renderScene(s).truth); }
