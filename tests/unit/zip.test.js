import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import {
  isZip, is7z, listZipEntries, findEntry, extractEntry, extOf, baseName, crc32, ZipError
} from '../../src/core/zip.js';
import { makeZip } from '../e2e-emu/fixtures.mjs';

const enc = new TextEncoder();
const rom = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff);
const readme = enc.encode('Thanks for downloading!\n');
const deflated = (data) => new Uint8Array(zlib.deflateRawSync(data));

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });
  it('matches zlib for binary data', () => {
    expect(crc32(rom)).toBe(zlib.crc32(rom));
  });
});

describe('signatures', () => {
  it('recognises zip and 7z', () => {
    const zip = makeZip([{ name: 'a.gb', data: rom }]);
    expect(isZip(zip)).toBe(true);
    expect(isZip(rom)).toBe(false);
    expect(isZip(new Uint8Array(2))).toBe(false);
    expect(is7z(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe(true);
    expect(is7z(zip)).toBe(false);
  });
});

describe('listZipEntries', () => {
  it('reads the central directory in archive order', () => {
    const zip = makeZip([
      { name: 'README.txt', data: readme },
      { name: 'Pokemon Test (USA).gba', data: rom, method: 8, compressed: deflated(rom) }
    ], { comment: 'scene release' });
    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['README.txt', 'Pokemon Test (USA).gba']);
    expect(entries[1]).toMatchObject({ method: 8, size: rom.length, crc: crc32(rom), encrypted: false, isDir: false });
    expect(entries[0].offset).toBe(0);
  });

  it('falls back to local headers when the directory is missing', () => {
    const zip = makeZip([
      { name: 'info.nfo', data: readme },
      { name: 'game.gb', data: rom }
    ], { central: false });
    expect(listZipEntries(zip).map((e) => e.name)).toEqual(['info.nfo', 'game.gb']);
  });

  it('understands zip64 extra fields', () => {
    const zip = makeZip([{ name: 'big.gba', data: rom }], { zip64: true });
    const [e] = listZipEntries(zip);
    expect(e).toMatchObject({ name: 'big.gba', size: rom.length, compressedSize: rom.length, offset: 0 });
  });

  it('rejects data that is not a zip', () => {
    expect(() => listZipEntries(rom)).toThrow(ZipError);
    try { listZipEntries(rom); } catch (e) { expect(e.code).toBe('not-zip'); }
  });

  it('marks folders', () => {
    const zip = makeZip([{ name: 'roms/', data: new Uint8Array(0) }, { name: 'roms/a.nes', data: rom }]);
    const entries = listZipEntries(zip);
    expect(entries[0].isDir).toBe(true);
    expect(findEntry(entries, (ext) => ext === 'nes').name).toBe('roms/a.nes');
  });
});

describe('findEntry', () => {
  it('skips readmes and picks the first accepted extension', () => {
    const entries = listZipEntries(makeZip([
      { name: 'README.txt', data: readme },
      { name: 'cover.png', data: readme },
      { name: 'Game.GBA', data: rom },
      { name: 'Other.gb', data: rom }
    ]));
    expect(findEntry(entries, (ext) => ['gb', 'gba'].includes(ext)).name).toBe('Game.GBA');
    expect(findEntry(entries, (ext) => ext === 'nds')).toBeNull();
  });
});

describe('extractEntry', () => {
  it('extracts stored entries', async () => {
    const zip = makeZip([{ name: 'r.txt', data: readme }, { name: 'a.gb', data: rom }]);
    const out = await extractEntry(zip, listZipEntries(zip)[1]);
    expect(out).toEqual(rom);
  });

  it('inflates deflate entries', async () => {
    const zip = makeZip([{ name: 'a.gba', data: rom, method: 8, compressed: deflated(rom) }]);
    const out = await extractEntry(zip, listZipEntries(zip)[0]);
    expect(out).toEqual(rom);
  });

  it('detects corruption by CRC', async () => {
    const zip = makeZip([{ name: 'a.gb', data: rom, crc: 1234 }]);
    await expect(extractEntry(zip, listZipEntries(zip)[0])).rejects.toMatchObject({ code: 'crc' });
  });

  it('refuses encrypted entries and unknown methods', async () => {
    const enc1 = makeZip([{ name: 'a.gb', data: rom, flags: 1 }]);
    await expect(extractEntry(enc1, listZipEntries(enc1)[0])).rejects.toMatchObject({ code: 'encrypted' });
    const bz = makeZip([{ name: 'a.gb', data: rom, method: 12 }]);
    await expect(extractEntry(bz, listZipEntries(bz)[0])).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('stops inflating at the declared size (damaged or hostile archives)', async () => {
    // declares 16 bytes but inflates to 1 MB
    const bomb = new Uint8Array(1024 * 1024);
    const small = new Uint8Array(16);
    const zip = makeZip([{ name: 'a.gb', data: small, method: 8, compressed: deflated(bomb) }]);
    await expect(extractEntry(zip, listZipEntries(zip)[0])).rejects.toMatchObject({ code: 'crc' });
  });

  it('reports truncated archives as corrupt', async () => {
    const zip = makeZip([{ name: 'a.gb', data: rom }]);
    const entry = listZipEntries(zip)[0];
    await expect(extractEntry(zip.subarray(0, 100), entry)).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('names', () => {
  it('extOf and baseName', () => {
    expect(extOf('dir/Pokemon Red (UE) [S].GB')).toBe('gb');
    expect(extOf('noext')).toBe('');
    expect(extOf('.hidden')).toBe('');
    expect(baseName('a/b\\c.gba')).toBe('c.gba');
  });
});
