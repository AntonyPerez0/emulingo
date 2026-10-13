#!/usr/bin/env node
// Pure-JS Game Boy ROM builder for the Spritespeak end-to-end harness.
//
// Produces a 32 KiB ROM-only (MBC none) DMG cartridge whose SM83 machine code
// is assembled right here, byte by byte (tiny label/fixup helper, no external
// toolchain). The program draws a Pokémon-like scene:
//   * rows 0-11: overworld (trees, grass, tall grass, path, sign, flowers and
//     an ANIMATED pond - the water tile's pixels swap every 16 frames, so the
//     frame is never pixel-identical, like a real game)
//   * rows 12-17: a double-bordered dialog box; text lines at tile rows 14
//     and 16, starting at column 1 (18 columns max, like Gen 1/2)
//   * typewriter effect: one character every 2 frames
//   * when a page is fully typed, a ▼ arrow blinks at row 16 / col 18
//     (toggles every 32 frames)
//   * pressing A (edge-detected, only once the page is complete) advances to
//     the next page; after the last page it wraps to the first
//
// Header: valid header checksum + global checksum. The 48-byte "logo" area
// holds an ORIGINAL pattern (not Nintendo's logo): gambatte under EmulatorJS
// boots without a boot ROM, so nothing verifies it (validated in run-e2e).
//
//   node bench/e2e/make-gb-rom.mjs [outDir]
// writes <outDir>/spritespeak-ocr-test.gb, .json (expected text + layout) and
// expected-page-N.png renders (default outDir: bench/.cache/e2e).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_CHARS, glyphPixels, tilePixels } from './font.mjs';
import { indexToPng } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------- content
export const PAGES = [
  ['Hello there!', 'Welcome to the'],
  ['world of POKéMON!', 'My name is OAK.'],
  ['Hallo! Willkommen', 'in der Welt der'],
  ['POKéMON! Ich bin', 'Professor EICH.'],
  ['Möchtest du gegen', 'mich kämpfen?'],
  ['Die Straße führt', 'nach Süden.'],
  ['Übung macht den', 'Meister!'],
  ['Ärgere dich nicht!', 'Öffne das Menü.']
];
export const PAGE_LANG = ['en', 'en', 'de', 'de', 'de', 'de', 'de', 'de'];

export const LAYOUT = {
  native: [160, 144],
  box: { row0: 12, row1: 17, col0: 0, col1: 19 },
  textRows: [14, 16],
  textCol: 1,
  maxCols: 18,
  arrow: { row: 16, col: 18 },
  framesPerChar: 2,
  arrowBlinkFrames: 32,
  waterAnimFrames: 16
};

// ---------------------------------------------------------------- tiles
// index 0 = blank paper, then font glyphs, then scene tiles
const SCENE_ORDER = ['BOX_TL', 'BOX_TR', 'BOX_BL', 'BOX_BR', 'BOX_T', 'BOX_B', 'BOX_L', 'BOX_R',
  'ARROW', 'GRASS', 'TALL', 'TREE', 'PATH', 'FLOWER', 'WATER', 'WATER2', 'SIGN'];
export const TILE = { BLANK: 0 };
const tilePx = [new Array(64).fill(0)];
FONT_CHARS.forEach((ch) => { TILE['ch:' + ch] = tilePx.length; tilePx.push(glyphPixels(ch)); });
SCENE_ORDER.forEach((n) => { TILE[n] = tilePx.length; tilePx.push(tilePixels(n)); });
export const TILE_PIXELS = tilePx;

function tile2bpp(px) {
  const out = [];
  for (let y = 0; y < 8; y++) {
    let lo = 0, hi = 0;
    for (let x = 0; x < 8; x++) {
      const c = px[y * 8 + x];
      lo |= (c & 1) << (7 - x);
      hi |= ((c >> 1) & 1) << (7 - x);
    }
    out.push(lo, hi);
  }
  return out;
}

export function charTile(ch) {
  if (ch === ' ') return TILE.BLANK;
  const t = TILE['ch:' + ch];
  if (t == null) throw new Error('character not in font: ' + JSON.stringify(ch));
  return t;
}

// ---------------------------------------------------------------- map
// hud variant: adds a static location banner (like a Pokémon route sign) in
// the overworld, i.e. a SECOND text element far above the dialog box
export const HUD_TEXT = 'ROUTE 1';
export const HUD = { row0: 1, row1: 3, col0: 1, col1: 2 + HUD_TEXT.length, textRow: 2, textCol: 2 };
export function buildMap({ hud = false } = {}) {
  const W = 20, H = 18;
  const m = Array.from({ length: H }, () => new Array(W).fill(TILE.GRASS));
  for (let y = 0; y < 12; y++) { m[y][0] = TILE.TREE; m[y][19] = TILE.TREE; }
  for (let x = 0; x < W; x++) m[0][x] = TILE.TREE;
  for (let y = 1; y < 12; y++) { m[y][9] = TILE.PATH; m[y][10] = TILE.PATH; }
  for (let y = 2; y <= 5; y++) for (let x = 2; x <= 6; x++) m[y][x] = TILE.TALL;
  for (let y = 6; y <= 9; y++) for (let x = 13; x <= 17; x++) m[y][x] = TILE.WATER;
  for (const [y, x] of [[3, 12], [4, 15], [8, 3], [10, 6], [2, 16], [11, 14]]) m[y][x] = TILE.FLOWER;
  m[7][8] = TILE.SIGN;
  // dialog box
  for (let y = 12; y <= 17; y++) for (let x = 0; x < W; x++) m[y][x] = TILE.BLANK;
  for (let x = 1; x < 19; x++) { m[12][x] = TILE.BOX_T; m[17][x] = TILE.BOX_B; }
  for (let y = 13; y <= 16; y++) { m[y][0] = TILE.BOX_L; m[y][19] = TILE.BOX_R; }
  m[12][0] = TILE.BOX_TL; m[12][19] = TILE.BOX_TR; m[17][0] = TILE.BOX_BL; m[17][19] = TILE.BOX_BR;
  if (hud) {
    const { row0, row1, col0, col1, textRow, textCol } = HUD;
    for (let y = row0; y <= row1; y++) for (let x = col0; x <= col1; x++) m[y][x] = TILE.BLANK;
    for (let x = col0 + 1; x < col1; x++) { m[row0][x] = TILE.BOX_T; m[row1][x] = TILE.BOX_B; }
    for (let y = row0 + 1; y < row1; y++) { m[y][col0] = TILE.BOX_L; m[y][col1] = TILE.BOX_R; }
    m[row0][col0] = TILE.BOX_TL; m[row0][col1] = TILE.BOX_TR; m[row1][col0] = TILE.BOX_BL; m[row1][col1] = TILE.BOX_BR;
    [...HUD_TEXT].forEach((ch, i) => { m[textRow][textCol + i] = charTile(ch); });
  }
  return m;
}

// Expected native frame (160x144 colour indices) for a fully typed page.
// Water tiles are marked 255 (don't care: animated). arrow: true/false/null
// (null = don't care at the arrow cell).
export function renderExpected(pageIdx, { arrow = null, typedChars = Infinity, hud = false } = {}) {
  const m = buildMap({ hud }).map((r) => r.slice());
  const [l1, l2] = PAGES[pageIdx];
  let n = 0;
  [l1, l2].forEach((line, i) => {
    for (let c = 0; c < line.length; c++) {
      if (n++ >= typedChars) return;
      m[LAYOUT.textRows[i]][LAYOUT.textCol + c] = charTile(line[c]);
    }
  });
  const out = new Uint8Array(160 * 144);
  for (let ty = 0; ty < 18; ty++) for (let tx = 0; tx < 20; tx++) {
    let t = m[ty][tx];
    let dontCare = t === TILE.WATER;
    if (ty === LAYOUT.arrow.row && tx === LAYOUT.arrow.col) {
      if (arrow === true) t = TILE.ARROW;
      else if (arrow === null) dontCare = true;
    }
    const px = TILE_PIXELS[t];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      out[(ty * 8 + y) * 160 + tx * 8 + x] = dontCare ? 255 : px[y * 8 + x];
    }
  }
  return out;
}

// ---------------------------------------------------------------- assembler
class Asm {
  constructor(org) { this.org = org; this.bytes = []; this.labels = {}; this.fix = []; }
  get pc() { return this.org + this.bytes.length; }
  label(n) { if (n in this.labels) throw new Error('dup label ' + n); this.labels[n] = this.pc; }
  db(...b) { for (const x of b.flat()) { if (x < 0 || x > 255) throw new Error('byte ' + x); this.bytes.push(x); } }
  w16(v) { if (typeof v === 'string') { this.fix.push({ at: this.bytes.length, l: v, t: 'abs' }); this.db(0, 0); } else this.db(v & 255, v >> 8); }
  rel(op, l) { this.db(op); this.fix.push({ at: this.bytes.length, l, t: 'rel', from: this.pc + 1 }); this.db(0); }
  // mnemonics used by the program
  jr(l) { this.rel(0x18, l); } jrnz(l) { this.rel(0x20, l); } jrz(l) { this.rel(0x28, l); } jrc(l) { this.rel(0x38, l); }
  jp(l) { this.db(0xc3); this.w16(l); }
  call(l) { this.db(0xcd); this.w16(l); } callz(l) { this.db(0xcc); this.w16(l); } callnz(l) { this.db(0xc4); this.w16(l); }
  ldhl(v) { this.db(0x21); this.w16(v); } ldde(v) { this.db(0x11); this.w16(v); } ldbc(v) { this.db(0x01); this.w16(v); } ldsp(v) { this.db(0x31); this.w16(v); }
  lda(n) { this.db(0x3e, n); } ldb(n) { this.db(0x06, n); } ldd(n) { this.db(0x16, n); }
  ldaM(addr) { this.db(0xfa); this.w16(addr); }   // ld a,[nn]
  ldMa(addr) { this.db(0xea); this.w16(addr); }   // ld [nn],a
  ldhA(n) { this.db(0xf0, n); }                   // ldh a,[$ff00+n]
  ldhW(n) { this.db(0xe0, n); }                   // ldh [$ff00+n],a
  cp(n) { this.db(0xfe, n); } and(n) { this.db(0xe6, n); } xorn(n) { this.db(0xee, n); }
  xora() { this.db(0xaf); } ora() { this.db(0xb7); } ret() { this.db(0xc9); }
  link() {
    for (const f of this.fix) {
      const tgt = this.labels[f.l];
      if (tgt == null) throw new Error('undefined label ' + f.l);
      if (f.t === 'abs') { this.bytes[f.at] = tgt & 255; this.bytes[f.at + 1] = tgt >> 8; }
      else {
        const d = tgt - f.from;
        if (d < -128 || d > 127) throw new Error(`jr out of range to ${f.l} (${d})`);
        this.bytes[f.at] = d & 255;
      }
    }
    return Uint8Array.from(this.bytes);
  }
}

// ---------------------------------------------------------------- program
const LY = 0x44, LCDC = 0x40, BGP = 0x47, SCY = 0x42, SCX = 0x43, P1 = 0x00, NR52 = 0x26, IE = 0xff;
const V = { PAGE: 0xc000, FRAME: 0xc001, PREV: 0xc002, DONE: 0xc003, ARROW: 0xc004, PTRL: 0xc005, PTRH: 0xc006, DSTL: 0xc007, DSTH: 0xc008, NEWPAGE: 0xc009, WPH: 0xc00a };
const mapAddr = (row, col) => 0x9800 + row * 32 + col;

function assemble({ hud = false } = {}) {
  const a = new Asm(0x150);
  const L1 = mapAddr(LAYOUT.textRows[0], LAYOUT.textCol);
  const L2 = mapAddr(LAYOUT.textRows[1], LAYOUT.textCol);
  const ARROW_AT = mapAddr(LAYOUT.arrow.row, LAYOUT.arrow.col);

  a.label('Start');
  a.db(0xf3);                       // di
  a.ldsp(0xfffe);
  a.xora(); a.ldhW(IE);             // no interrupts
  a.label('WaitVB');                // LCD may only be switched off in VBlank
  a.ldhA(LY); a.cp(144); a.jrc('WaitVB');
  a.xora(); a.ldhW(LCDC);           // LCD off
  a.ldhW(NR52);                     // APU off (a = 0)
  a.ldhl('Tiles'); a.ldde(0x8000); a.ldbc('TilesLen'); a.call('MemCpy');
  a.ldhl('Map'); a.ldde(0x9800); a.ldbc(32 * 18); a.call('MemCpy');
  a.lda(0xe4); a.ldhW(BGP);         // 3=black 2=dark 1=light 0=white
  a.xora(); a.ldhW(SCY); a.ldhW(SCX);
  a.ldMa(V.PAGE); a.ldMa(V.FRAME); a.ldMa(V.PREV); a.ldMa(V.ARROW); a.ldMa(V.WPH); a.ldMa(V.DONE);
  a.lda(1); a.ldMa(V.NEWPAGE);
  a.lda(0x91); a.ldhW(LCDC);        // LCD on, BG on, tiles @8000, map @9800

  a.label('Main');
  a.call('WaitFrame');
  // ---- VBlank: all VRAM writes happen here
  a.ldaM(V.NEWPAGE); a.ora(); a.callnz('StartPage');
  a.ldaM(V.FRAME); a.db(0x3c); a.ldMa(V.FRAME);         // inc frame
  a.and(LAYOUT.waterAnimFrames - 1); a.callz('AnimWater');
  a.ldaM(V.DONE); a.ora(); a.jrnz('Typed');
  a.ldaM(V.FRAME); a.and(LAYOUT.framesPerChar - 1); a.callz('TypeChar');
  a.jr('Input');
  a.label('Typed');
  a.ldaM(V.FRAME); a.and(LAYOUT.arrowBlinkFrames - 1); a.jrnz('Input');
  a.ldaM(V.ARROW); a.xorn(1); a.ldMa(V.ARROW);
  a.ora(); a.jrz('ArrowWrite');     // a = 0 -> blank tile
  a.lda(TILE.ARROW);
  a.label('ArrowWrite');
  a.ldMa(ARROW_AT);
  // ---- input: advance on A press edge once the page is complete
  a.label('Input');
  a.call('ReadA'); a.db(0x47);                  // ld b,a
  a.ldaM(V.PREV); a.db(0x4f);                   // ld c,a
  a.db(0x78); a.ldMa(V.PREV);                   // ld a,b ; store
  a.db(0x79); a.ora(); a.jrnz('Main');          // was already held
  a.db(0x78); a.ora(); a.jrz('Main');           // not pressed
  a.ldaM(V.DONE); a.ora(); a.jrz('Main');       // still typing
  a.ldaM(V.PAGE); a.db(0x3c); a.cp(PAGES.length); a.jrc('PageOk'); a.xora();
  a.label('PageOk');
  a.ldMa(V.PAGE);
  a.lda(1); a.ldMa(V.NEWPAGE);
  a.jp('Main');

  // wait for the start of the next VBlank (LY 144), never twice per frame
  a.label('WaitFrame');
  a.label('WF1'); a.ldhA(LY); a.cp(144); a.jrz('WF1');
  a.label('WF2'); a.ldhA(LY); a.cp(144); a.jrnz('WF2');
  a.ret();

  a.label('MemCpy');                // hl=src de=dst bc=len
  a.db(0x2a, 0x12, 0x13, 0x0b, 0x78, 0xb1); a.jrnz('MemCpy');
  a.ret();

  a.label('StartPage');
  a.xora(); a.ldMa(V.NEWPAGE); a.ldMa(V.DONE); a.ldMa(V.ARROW);
  a.ldhl(L1); a.ldb(LAYOUT.maxCols);
  a.label('Clr1'); a.db(0x22, 0x05); a.jrnz('Clr1');   // ld [hl+],a ; dec b
  a.ldhl(L2); a.ldb(LAYOUT.maxCols);
  a.label('Clr2'); a.db(0x22, 0x05); a.jrnz('Clr2');
  a.lda(L1 & 255); a.ldMa(V.DSTL); a.lda(L1 >> 8); a.ldMa(V.DSTH);
  a.ldaM(V.PAGE); a.db(0x87, 0x5f); a.ldd(0);         // add a,a ; ld e,a
  a.ldhl('PageTable'); a.db(0x19);                     // add hl,de
  a.db(0x2a); a.ldMa(V.PTRL); a.db(0x7e); a.ldMa(V.PTRH);
  a.ret();

  a.label('TypeChar');
  a.ldaM(V.PTRL); a.db(0x6f); a.ldaM(V.PTRH); a.db(0x67);   // hl = ptr
  a.db(0x2a, 0x47);                                        // ld a,[hl+] ; ld b,a
  a.db(0x7d); a.ldMa(V.PTRL); a.db(0x7c); a.ldMa(V.PTRH);
  a.db(0x78); a.cp(0xff); a.jrz('TypeEnd');
  a.cp(0xfe); a.jrz('TypeNl');
  a.ldaM(V.DSTL); a.db(0x6f); a.ldaM(V.DSTH); a.db(0x67);
  a.db(0x78, 0x22);                                        // ld a,b ; ld [hl+],a
  a.db(0x7d); a.ldMa(V.DSTL); a.db(0x7c); a.ldMa(V.DSTH);
  a.ret();
  a.label('TypeNl');
  a.lda(L2 & 255); a.ldMa(V.DSTL); a.lda(L2 >> 8); a.ldMa(V.DSTH);
  a.ret();
  a.label('TypeEnd');                                      // page complete: arrow on now
  a.lda(1); a.ldMa(V.DONE); a.ldMa(V.ARROW);
  a.lda(TILE.ARROW); a.ldMa(ARROW_AT);
  a.xora(); a.ldMa(V.FRAME);
  a.ret();

  a.label('AnimWater');
  a.ldaM(V.WPH); a.xorn(1); a.ldMa(V.WPH);
  a.ldhl('WaterA'); a.ora(); a.jrz('AW1'); a.ldhl('WaterB');
  a.label('AW1');
  a.ldde(0x8000 + TILE.WATER * 16); a.ldbc(16); a.jp('MemCpy');

  a.label('ReadA');                 // a = 1 while A is held
  a.lda(0x10); a.ldhW(P1);          // select action buttons
  a.ldhA(P1); a.ldhA(P1); a.ldhA(P1); a.ldhA(P1);
  a.db(0x2f); a.and(1); a.db(0x47); // cpl ; and 1 ; ld b,a
  a.lda(0x30); a.ldhW(P1);
  a.db(0x78); a.ret();

  // ---------------- data
  a.label('PageTable');
  PAGES.forEach((_, i) => a.w16('Page' + i));
  PAGES.forEach(([l1, l2], i) => {
    for (const s of [l1, l2]) if (s.length > LAYOUT.maxCols) throw new Error('line too long: ' + s);
    if (l2.length >= LAYOUT.arrow.col) throw new Error('line 2 would overlap the arrow: ' + l2);
    a.label('Page' + i);
    a.db([...l1].map(charTile), 0xfe, [...l2].map(charTile), 0xff);
  });
  const tileBytes = TILE_PIXELS.flatMap(tile2bpp);
  a.label('Tiles'); a.db(tileBytes);
  a.labels.TilesLen = tileBytes.length;
  a.label('WaterA'); a.db(tile2bpp(TILE_PIXELS[TILE.WATER]));
  a.label('WaterB'); a.db(tile2bpp(TILE_PIXELS[TILE.WATER2]));
  a.label('Map');
  for (const row of buildMap({ hud })) a.db(row, new Array(12).fill(0));
  return a.link();
}

// ---------------------------------------------------------------- cartridge
export function buildRom({ hud = false } = {}) {
  const rom = new Uint8Array(0x8000).fill(0xff);
  rom.fill(0x00, 0, 0x100);
  // entry point: nop ; jp $0150
  rom.set([0x00, 0xc3, 0x50, 0x01], 0x100);
  // 0x104-0x133: original 48-byte pattern (NOT the Nintendo logo)
  for (let i = 0; i < 48; i++) rom[0x104 + i] = (i * 37 + 0x5a) & 0xff ^ (i & 1 ? 0xa5 : 0x3c);
  const title = hud ? 'SPRITESPEAK HUD' : 'SPRITESPEAK OCR';
  for (let i = 0; i < 15; i++) rom[0x134 + i] = i < title.length ? title.charCodeAt(i) : 0;
  rom[0x143] = 0x00;            // DMG only
  rom[0x144] = 0x30; rom[0x145] = 0x30; // new licensee "00"
  rom[0x146] = 0x00;            // no SGB
  rom[0x147] = 0x00;            // ROM ONLY
  rom[0x148] = 0x00;            // 32 KiB
  rom[0x149] = 0x00;            // no RAM
  rom[0x14a] = 0x01;            // overseas
  rom[0x14b] = 0x33;            // use new licensee
  rom[0x14c] = 0x00;
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff;
  rom[0x14d] = x;
  const code = assemble({ hud });
  if (0x150 + code.length > 0x8000) throw new Error('program too large');
  rom.set(code, 0x150);
  let sum = 0;
  for (let i = 0; i < rom.length; i++) if (i !== 0x14e && i !== 0x14f) sum = (sum + rom[i]) & 0xffff;
  rom[0x14e] = sum >> 8; rom[0x14f] = sum & 0xff;
  return { rom, codeSize: code.length };
}

export const romName = (hud) => hud ? 'spritespeak-ocr-test-hud.gb' : 'spritespeak-ocr-test.gb';
export function expectedJson({ hud = false } = {}) {
  return {
    rom: romName(hud),
    hud: hud ? { text: HUD_TEXT, ...HUD } : null,
    core: 'gb (gambatte)',
    layout: LAYOUT,
    keyA: 'z (EmulatorJS default keyboard mapping for RetroPad A = button index 8)',
    pages: PAGES.map(([l1, l2], i) => ({ index: i, lang: PAGE_LANG[i], lines: [l1, l2], text: l1 + ' ' + l2, chars: l1.length + l2.length }))
  };
}

export function writeAll(outDir = path.join(ROOT, 'bench', '.cache', 'e2e'), { hud = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const { rom, codeSize } = buildRom({ hud });
  const base = romName(hud).replace(/\.gb$/, '');
  const romPath = path.join(outDir, base + '.gb');
  fs.writeFileSync(romPath, rom);
  fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify(expectedJson({ hud }), null, 2));
  PAGES.forEach((_, i) => fs.writeFileSync(path.join(outDir, `${base}-expected-page-${i}.png`), indexToPng(renderExpected(i, { arrow: true, hud }), 160, 144, 2)));
  return { romPath, codeSize, size: rom.length, headerChecksum: rom[0x14d], globalChecksum: (rom[0x14e] << 8) | rom[0x14f] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : undefined;
  console.log(JSON.stringify([writeAll(outDir), writeAll(outDir, { hud: true })], null, 2));
}
