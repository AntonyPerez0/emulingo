// Minimal Game Boy Advance test ROM for the layout checks (mGBA core): mode 3
// (240×160 bitmap), a light-blue play field (rows 0-106), a black rule
// (rows 107-109) and a white "dialog box" (rows 110-159), then it spins.
// The ARM code is hand-assembled: no toolchain, no text.
//
//   import { writeGbaRom } from './make-gba-rom.mjs'; writeGbaRom('/tmp/x.gba')
import fs from 'node:fs';

// fill r2 halfwords at r0 with r1: strh r1,[r0],#2 / subs r2,r2,#1 / bne
const LOOP = [0xE0C010B2, 0xE2522001, 0x1AFFFFFC];

export function gbaRomBytes() {
  const code = [
    0xE3A00404, 0xE3A01B01, 0xE3811003, 0xE1C010B0, // DISPCNT (0x4000000) = 0x0403: mode 3, BG2 on
    0xE3A00406,                                     // r0 = VRAM (0x6000000)
    0xE3A01C7E, 0xE38110B5,                         // r1 = 0x7EB5 (light blue)
    0xE3A02C64, 0xE2822050, ...LOOP,                // 240 × 107 px
    0xE3A01000, 0xE3A02FB4, ...LOOP,                // black, 720 px (3 rows)
    0xE3A01C7F, 0xE38110FF,                         // r1 = 0x7FFF (white)
    0xE3A02C2E, 0xE28220E0, ...LOOP,                // 12000 px (50 rows)
    0xEAFFFFFE                                      // spin
  ];
  const rom = Buffer.alloc(1024, 0);
  rom.writeUInt32LE(0xEA00002E, 0); // b 0xC0 (over the header)
  rom.write('SPRITESPEAK', 0xA0, 'ascii');
  rom.write('AEMT', 0xAC, 'ascii');
  rom.write('01', 0xB0, 'ascii');
  rom[0xB2] = 0x96;
  let sum = 0;
  for (let i = 0xA0; i <= 0xBC; i++) sum += rom[i];
  rom[0xBD] = (-(sum + 0x19)) & 0xFF; // header complement check
  code.forEach((w, i) => rom.writeUInt32LE(w >>> 0, 0xC0 + i * 4));
  return rom;
}

export function writeGbaRom(file) {
  fs.writeFileSync(file, gbaRomBytes());
  return file;
}
