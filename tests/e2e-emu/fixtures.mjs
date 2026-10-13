// Test fixtures shared by the unit tests (tests/unit/{zip,rom}.test.js) and
// the real-emulator script (tests/e2e-emu/emu.e2e.mjs): a ZIP writer and two
// tiny homebrew ROMs. Pure JS, runs in Node and in the browser.

import { crc32 } from '../../src/core/zip.js';

const enc = new TextEncoder();

function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

// files: [{ name, data: Uint8Array, method = 0, compressed?: Uint8Array (for
// method 8 pass the raw deflate stream), flags = 0, crc? }]
// opts: { central = true, comment = '', zip64 = false }
export function makeZip(files, { central = true, comment = '', zip64 = false } = {}) {
  const chunks = [];
  const cd = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const body = f.method === 8 ? f.compressed : (f.compressed || f.data);
    const crc = f.crc ?? crc32(f.data);
    const flags = (f.flags || 0) | 0x800;
    const big = zip64;
    const extra = big ? [...u16(1), ...u16(24), ...u32(f.data.length), ...u32(0), ...u32(body.length), ...u32(0), ...u32(offset), ...u32(0)] : [];
    const local = [
      ...u32(0x04034b50), ...u16(big ? 45 : 20), ...u16(flags), ...u16(f.method || 0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(big ? 0xffffffff : body.length), ...u32(big ? 0xffffffff : f.data.length),
      ...u16(name.length), ...u16(extra.length)
    ];
    chunks.push(Uint8Array.from(local), name, Uint8Array.from(extra), body);
    cd.push([
      ...u32(0x02014b50), ...u16(20), ...u16(big ? 45 : 20), ...u16(flags), ...u16(f.method || 0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(big ? 0xffffffff : body.length), ...u32(big ? 0xffffffff : f.data.length),
      ...u16(name.length), ...u16(extra.length), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(big ? 0xffffffff : offset),
      ...name, ...extra
    ]);
    offset += local.length + name.length + extra.length + body.length;
  }
  if (central) {
    const cdBytes = Uint8Array.from(cd.flat());
    const commentBytes = enc.encode(comment);
    chunks.push(cdBytes);
    chunks.push(Uint8Array.from([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(cdBytes.length), ...u32(offset), ...u16(commentBytes.length)
    ]), commentBytes);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// 32 KiB DMG cartridge (MBC1 + RAM + battery, 8 KiB SRAM). Every boot it
// increments SRAM byte 0, copies it to WRAM 0xC000, draws that many solid
// tiles (mod 32) in the top row and a solid block at the bottom. Booting a
// persistent save N times shows N consecutive counter values; a save state
// restores the counter that was on screen when it was taken.
export function makeSramCounterGbRom() {
  const rom = new Uint8Array(32768);
  const put = (addr, bytes) => bytes.forEach((b, i) => { rom[addr + i] = b; });
  put(0x100, [0x00, 0xc3, 0x50, 0x01]); // nop; jp 0x0150
  const title = 'SPRITESPEAKSRAM';
  for (let i = 0; i < title.length; i++) rom[0x134 + i] = title.charCodeAt(i);
  rom[0x147] = 0x03; // MBC1+RAM+BATTERY
  rom[0x148] = 0x00; // 32 KiB ROM
  rom[0x149] = 0x02; // 8 KiB RAM
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff;
  rom[0x14d] = x;
  put(0x150, [
    0xf3, 0x31, 0xfe, 0xff, // di; ld sp, 0xfffe
    0x3e, 0x0a, 0xea, 0x00, 0x00, // ld a, 0x0a; ld (0x0000), a  (enable SRAM)
    0xfa, 0x00, 0xa0, 0x3c, 0xea, 0x00, 0xa0, // ld a, (0xa000); inc a; ld (0xa000), a
    0xea, 0x00, 0xc0, // ld (0xc000), a  (keep a copy in WRAM)
    0xf0, 0x44, 0xfe, 0x90, 0x20, 0xfa, // wait for vblank
    0xaf, 0xe0, 0x40, // lcd off
    0x21, 0x10, 0x80, 0x06, 0x10, 0x3e, 0xff, 0x22, 0x05, 0x20, 0xfc, // tile 1 = solid
    0x21, 0x00, 0x80, 0x06, 0x10, 0xaf, 0x22, 0x05, 0x20, 0xfc, // tile 0 = blank
    0x21, 0x00, 0x98, 0x01, 0x00, 0x04, 0xaf, 0x22, 0x0b, 0x78, 0xb1, 0x20, 0xf9, // clear map
    0x21, 0xa0, 0x99, 0x06, 0xa0, 0x3e, 0x01, 0x22, 0x05, 0x20, 0xfc, // rows 13+ solid
    // top row: (counter & 31) solid tiles, so the state is visible on screen
    0x21, 0x00, 0x98, // ld hl, 0x9800
    0xfa, 0x00, 0xc0, // ld a, (0xc000)
    0xe6, 0x1f, // and 0x1f
    0x28, 0x07, // jr z, +7
    0x47, // ld b, a
    0x3e, 0x01, 0x22, 0x05, 0x20, 0xfa, // loop: ld a, 1; ld (hl+), a; dec b; jr nz, loop
    0x3e, 0xe4, 0xe0, 0x47, // palette
    0xaf, 0xe0, 0x42, 0xe0, 0x43, // scroll 0
    0x3e, 0x91, 0xe0, 0x40, // lcd on
    0x18, 0xfe // jr -2 (spin)
  ]);
  let g = 0;
  for (let i = 0; i < rom.length; i++) if (i !== 0x14e && i !== 0x14f) g = (g + rom[i]) & 0xffff;
  rom[0x14e] = g >> 8;
  rom[0x14f] = g & 0xff;
  return rom;
}

// Minimal GBA cartridge: branch over the header, then spin. mGBA boots it
// without a BIOS; the screen stays blank, which is all the core test needs.
export function makeGbaRom() {
  const rom = new Uint8Array(0x200);
  const put32 = (addr, v) => { rom[addr] = v & 0xff; rom[addr + 1] = (v >>> 8) & 0xff; rom[addr + 2] = (v >>> 16) & 0xff; rom[addr + 3] = (v >>> 24) & 0xff; };
  put32(0x00, 0xea00002e); // b 0xc0
  const title = 'SPRITESPEAK';
  for (let i = 0; i < title.length; i++) rom[0xa0 + i] = title.charCodeAt(i);
  'ETST'.split('').forEach((c, i) => { rom[0xac + i] = c.charCodeAt(0); });
  rom[0xb0] = 0x30; rom[0xb1] = 0x31; // maker code '01'
  rom[0xb2] = 0x96; // fixed value
  let chk = 0;
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - rom[i]) & 0xff;
  rom[0xbd] = (chk - 0x19) & 0xff;
  put32(0xc0, 0xeafffffe); // b . (spin)
  return rom;
}
