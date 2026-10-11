// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { makeZip } from '../e2e-emu/fixtures.mjs';

// In-memory stand-in for src/core/idb.js (pinned API) with failure injection.
const kv = vi.hoisted(() => {
  const map = new Map();
  const state = { failSet: null, records: {} };
  const clone = (v) => (v instanceof ArrayBuffer ? v.slice(0) : v);
  return {
    map,
    state,
    api: {
      idbGet: vi.fn(async (k) => map.get(k)),
      idbSet: vi.fn(async (k, v) => {
        if (state.failSet && state.failSet(k)) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        map.set(k, clone(v));
      }),
      idbDel: vi.fn(async (k) => { map.delete(k); }),
      idbKeys: vi.fn(async (prefix = '') => [...map.keys()].filter((k) => String(k).startsWith(prefix))),
      idbClear: vi.fn(async () => map.clear()),
      idbGetAll: vi.fn(async (store) => state.records[store] || []),
      closeDb: vi.fn()
    }
  };
});
vi.mock('../../src/core/idb.js', () => kv.api);

const rom = await import('../../src/core/rom.js');
const {
  SUPPORTED, SYSTEMS, acceptAttr, coreForExt, resolveCore, detectCore, sha1Js, sha1Hex,
  importRomFile, listRoms, getRom, getRomBytes, deleteRom, sweepOrphans, updateRom, markPlayed,
  RomError, INDEX_KEY, supportedExtensionsLabel, isSupportedExt
} = rom;

function fakeFile(name, bytes) {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}
const gbRom = (seed = 1) => Uint8Array.from({ length: 32768 }, (_, i) => (i * seed + 13) & 0xff);
const sha1 = (b) => createHash('sha1').update(b).digest('hex');

beforeEach(() => {
  kv.map.clear();
  kv.state.failSet = null;
  kv.state.records = {};
  localStorage.clear();
  vi.clearAllMocks();
});

describe('supported formats', () => {
  it('maps every extension from one table', () => {
    expect(SUPPORTED.gb).toBe('gb');
    expect(SUPPORTED.gbc).toBe('gb');
    expect(SUPPORTED.gba).toBe('gba');
    expect(SUPPORTED.fds).toBe('nes');
    expect(SUPPORTED.smc).toBe('snes');
    expect(SUPPORTED.gen).toBe('segaMD');
    expect(SUPPORTED.sms).toBe('segaMS');
    expect(SUPPORTED.gg).toBe('segaGG');
    expect(SUPPORTED.nds).toBe('nds');
    expect(SUPPORTED.z64).toBe('n64');
    expect(SUPPORTED.vb).toBe('vb');
    expect(SUPPORTED.zip).toBe('detect');
    expect(SUPPORTED['7z']).toBe('detect');
    for (const s of SYSTEMS) for (const ext of s.exts) expect(SUPPORTED[ext]).toBe(s.core);
  });

  it('builds the accept attribute and copy from the table', () => {
    const accept = acceptAttr({ ios: false });
    expect(accept.split(',')).toEqual(Object.keys(SUPPORTED).map((e) => '.' + e));
    expect(acceptAttr({ ios: true })).toBe('');
    expect(supportedExtensionsLabel()).toMatch(/^\.gb, \.gbc, .* or \.7z$/);
  });

  it('ignores prototype keys', () => {
    expect(coreForExt('constructor')).toBeNull();
    expect(isSupportedExt('toString')).toBe(false);
    expect(coreForExt('GBA')).toBe('gba');
  });

  it('resolves the core: Settings override, then ROM record, then extension', () => {
    expect(resolveCore({ core: 'gba', ext: 'gba' }, 'auto')).toBe('gba');
    expect(resolveCore({ core: 'gba', ext: 'gba' }, 'gbc')).toBe('gb');
    expect(resolveCore({ core: 'gba' }, 'md')).toBe('segaMD');
    expect(resolveCore({ core: null, ext: 'nes' })).toBe('nes');
    expect(resolveCore({ core: 'bogus', ext: 'zip' })).toBeNull();
  });

  it('offers Settings values that store.js accepts and resolveCore understands', () => {
    const opts = rom.coreSettingOptions();
    expect(opts[0]).toEqual({ value: 'auto', label: 'Automatic (recommended)' });
    for (const o of opts.slice(1)) {
      expect(o.value).toMatch(/^[a-z0-9_]{1,40}$/);
      expect(resolveCore({ core: 'gb' }, o.value)).not.toBeNull();
    }
    expect(opts.map((o) => o.value)).toContain('md');
  });

  it('detects the core inside a zip', () => {
    const zip = makeZip([{ name: 'readme.txt', data: new Uint8Array(3) }, { name: 'x.gba', data: gbRom() }]);
    expect(detectCore(zip, 'whatever.zip')).toBe('gba');
    expect(detectCore(gbRom(), 'a.gbc')).toBe('gb');
  });
});

describe('sha1', () => {
  it('JS fallback matches Node for padding edge cases', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
      expect(sha1Js(b)).toBe(sha1(b));
    }
  });
  it('works on subarrays', async () => {
    const big = gbRom(3);
    const sub = big.subarray(100, 5000);
    expect(sha1Js(sub)).toBe(sha1(sub));
    expect(await sha1Hex(sub)).toBe(sha1(sub));
  });
});

describe('importRomFile', () => {
  it('stores a new ROM once with a content id and a unique save name', async () => {
    const bytes = gbRom();
    const persist = vi.fn(async () => true);
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { persisted: async () => false, persist } });
    const res = await importRomFile(fakeFile('Pokemon Red (UE) [S][!].gb', bytes));
    const hex = sha1(bytes);
    expect(res.duplicate).toBe(false);
    expect(res.persisted).toBe(true);
    expect(res.warnings).toEqual([]);
    expect(res.bytes).toEqual(bytes);
    expect(res.rom).toMatchObject({
      id: 'rom-' + hex.slice(0, 16), name: 'Pokemon Red (UE) [S][!].gb', title: 'Pokemon Red (UE) [S][!]',
      ext: 'gb', core: 'gb', size: bytes.length, sha1: hex, source: 'file'
    });
    expect(res.rom.gameName).toBe('Pokemon Red (UE) [S][]-' + hex.slice(0, 6));
    expect(res.rom.fileName).toBe(res.rom.gameName + '.gb');
    expect(res.rom.saveStem).toBe(res.rom.gameName);
    const stored = kv.map.get('rom:' + res.rom.id);
    expect(stored).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(stored)).toEqual(bytes);
    expect(kv.map.get(INDEX_KEY)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('dedupes by content and bumps the added time', async () => {
    const bytes = gbRom(5);
    const a = await importRomFile(fakeFile('a.gb', bytes));
    const before = (await getRom(a.rom.id)).added;
    await new Promise((r) => setTimeout(r, 5));
    const b = await importRomFile(fakeFile('renamed copy.gb', bytes));
    expect(b.duplicate).toBe(true);
    expect(b.rom.id).toBe(a.rom.id);
    expect(b.rom.name).toBe('a.gb');
    expect((await getRom(a.rom.id)).added).toBeGreaterThan(before);
    expect(await listRoms()).toHaveLength(1);
    expect(kv.api.idbSet.mock.calls.filter(([k]) => k.startsWith('rom:'))).toHaveLength(1);
  });

  it('unpacks a zip and uses the ROM inside', async () => {
    const gba = gbRom(9);
    const zip = makeZip([
      { name: 'README.txt', data: new TextEncoder().encode('hi') },
      { name: 'Pokemon Emerald (U).gba', data: gba, method: 8, compressed: new Uint8Array(zlib.deflateRawSync(gba)) }
    ]);
    const res = await importRomFile(fakeFile('Pokemon Emerald.zip', zip));
    expect(res.rom).toMatchObject({ core: 'gba', ext: 'gba', source: 'zip', size: gba.length, sha1: sha1(gba), name: 'Pokemon Emerald.zip' });
    expect(res.rom.fileName).toMatch(/^Pokemon Emerald-[0-9a-f]{6}\.gba$/);
    expect(res.bytes).toEqual(gba);
    expect(new Uint8Array(kv.map.get('rom:' + res.rom.id))).toEqual(gba);
    // same game as a plain file is a duplicate
    const again = await importRomFile(fakeFile('Emerald.gba', gba));
    expect(again.duplicate).toBe(true);
  });

  it('asks for the system when it cannot tell', async () => {
    const zip = makeZip([{ name: 'notes.txt', data: new Uint8Array(10) }]);
    await expect(importRomFile(fakeFile('stuff.zip', zip))).rejects.toMatchObject({ code: 'no-rom-in-archive' });
    const sevenZ = Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 1, 2, 3]);
    const err = await importRomFile(fakeFile('game.7z', sevenZ)).catch((e) => e);
    expect(err).toBeInstanceOf(RomError);
    expect(err.code).toBe('needs-system');
    expect(err.message).toBe('Choose which system this game is for.');
    const ok = await importRomFile(fakeFile('game.7z', sevenZ), { core: 'gba' });
    expect(ok.rom).toMatchObject({ core: 'gba', ext: '7z', source: 'archive', saveStem: null });
  });

  it('rejects unsupported, empty and damaged files with friendly messages', async () => {
    const e1 = await importRomFile(fakeFile('save.sav', gbRom())).catch((e) => e);
    expect(e1.code).toBe('unsupported');
    expect(e1.message).toBe('“save.sav” isn’t a game file Emulingo can play. Choose a ROM file such as .gb, .gba or .nes.');
    await expect(importRomFile(fakeFile('x.constructor', gbRom()))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(importRomFile(fakeFile('a.gb', new Uint8Array(0)))).rejects.toMatchObject({ code: 'empty' });
    await expect(importRomFile(fakeFile('a.zip', gbRom()))).rejects.toMatchObject({ code: 'corrupt' });
    const unreadable = { name: 'a.gb', size: 10, arrayBuffer: async () => { throw new Error('NotReadableError'); } };
    await expect(importRomFile(unreadable)).rejects.toMatchObject({ code: 'read-failed' });
    const huge = { name: 'a.nds', size: 2 * 1024 ** 3, arrayBuffer: async () => new ArrayBuffer(1) };
    await expect(importRomFile(huge)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('refuses a zip whose game is too large to unpack', async () => {
    const zip = makeZip([{ name: 'huge.nds', data: gbRom() }]);
    // claim 4 GB in the central directory
    const dv = new DataView(zip.buffer);
    for (let p = zip.length - 22; p >= 0; p--) {
      if (dv.getUint32(p, true) === 0x02014b50) { dv.setUint32(p + 24, 0xfffffff0, true); break; }
    }
    await expect(importRomFile(fakeFile('huge.zip', zip))).rejects.toMatchObject({ code: 'too-large' });
  });

  it('accepts unknown extensions once the user picked a system', async () => {
    const res = await importRomFile(fakeFile('mystery.bin', gbRom(2)), { core: 'segaMD' });
    expect(res.rom).toMatchObject({ core: 'segaMD', ext: 'bin' });
  });

  it('still returns playable bytes when storage is full', async () => {
    kv.state.failSet = (k) => k.startsWith('rom:');
    const bytes = gbRom(4);
    const res = await importRomFile(fakeFile('big.gba', bytes));
    expect(res.persisted).toBe(false);
    expect(res.warnings).toContain('not-saved');
    expect(res.warnings).toContain('storage-full');
    expect(res.bytes).toEqual(bytes);
    expect(res.rom.core).toBe('gba');
    expect(await listRoms()).toHaveLength(0);
  });

  it('removes the bytes again when the index cannot be written', async () => {
    kv.state.failSet = (k) => k === INDEX_KEY;
    const res = await importRomFile(fakeFile('a.gb', gbRom(6)));
    expect(res.persisted).toBe(false);
    expect([...kv.map.keys()].filter((k) => k.startsWith('rom:'))).toEqual([]);
  });

  it('warns about very large ROMs', async () => {
    const big = new Uint8Array(64 * 1024 * 1024 + 1);
    big[0] = 1;
    const res = await importRomFile(fakeFile('huge.nds', big));
    expect(res.warnings).toEqual(['large']);
  });

  it('serialises concurrent imports', async () => {
    const [a, b, c] = await Promise.all([
      importRomFile(fakeFile('a.gb', gbRom(11))),
      importRomFile(fakeFile('b.gb', gbRom(12))),
      importRomFile(fakeFile('a-again.gb', gbRom(11)))
    ]);
    expect(a.duplicate || c.duplicate).toBe(true);
    expect(b.duplicate).toBe(false);
    expect(await listRoms()).toHaveLength(2);
  });
});

describe('v1 migration', () => {
  const v1 = [
    { id: 'rom-1700000000000', name: 'Pokemon Red.gb', size: 32768, added: 10 },
    { id: 'rom-1700000000001', name: 'Radical Red v4.1.gba', size: 4, added: 20 },
    { id: 'x"><img src=x onerror=alert(1)>', name: 'evil.gb', size: 1, added: 30 },
    { id: 'rom-1700000000002', name: 'Zipped.zip', size: 4, added: 5 }
  ];

  it('moves the library to IndexedDB, keeping save names and the old state', async () => {
    localStorage.setItem('emulingo:roms', JSON.stringify(v1));
    const st = new Uint8Array([1, 2, 3]);
    kv.map.set('state:rom-1700000000000', st);
    const list = await listRoms();
    expect(list.map((r) => r.id)).toEqual(['rom-1700000000001', 'rom-1700000000000', 'rom-1700000000002']);
    const red = list.find((r) => r.id === 'rom-1700000000000');
    expect(red).toMatchObject({ v1: true, gameName: 'Pokemon Red', fileName: 'Pokemon Red.gb', saveStem: 'Pokemon Red', core: 'gb', sha1: null });
    const rr = list.find((r) => r.id === 'rom-1700000000001');
    // v1 wrote the ROM as "Radical Red v4.1" (no extension): RetroArch saved "Radical Red v4.srm"
    expect(rr).toMatchObject({ gameName: 'Radical Red v4.1', saveStem: 'Radical Red v4', fileName: 'Radical Red v4.gba', core: 'gba' });
    expect(list.find((r) => r.id === 'rom-1700000000002').core).toBeNull();
    expect(kv.map.get('state:rom-1700000000000:auto')).toEqual(st);
    expect(kv.map.has('state:rom-1700000000000')).toBe(false);
    expect(localStorage.getItem('emulingo:roms')).toBeNull();
    expect(kv.map.get(INDEX_KEY)).toHaveLength(3);
  });

  it('recovers the v1 list from db.js’s record store when localStorage was already cleared', async () => {
    kv.state.records.roms = [{ id: 'rom-1700000000000', name: 'Pokemon Red.gb', size: 32768, added: 10 }];
    const list = await listRoms();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'rom-1700000000000', v1: true, saveStem: 'Pokemon Red', core: 'gb' });
    expect(kv.map.get(INDEX_KEY)).toHaveLength(1);
  });

  it('dedupes a v1 ROM by content and backfills its hash', async () => {
    const bytes = gbRom(21);
    localStorage.setItem('emulingo:roms', JSON.stringify([{ id: 'rom-1', name: 'Gold.gbc', size: bytes.length, added: 1 }]));
    kv.map.set('rom:rom-1', bytes.slice().buffer);
    const res = await importRomFile(fakeFile('Pokemon Gold.gbc', bytes));
    expect(res.duplicate).toBe(true);
    expect(res.rom.id).toBe('rom-1');
    expect((await getRom('rom-1')).sha1).toBe(sha1(bytes));
  });

  it('reads legacy base64 ROM data once and moves it to IndexedDB', async () => {
    localStorage.setItem('emulingo:romdata:rom-9', JSON.stringify({ name: 'a.gb', b64: btoa('ABC') }));
    const bytes = await getRomBytes('rom-9');
    expect(Array.from(bytes)).toEqual([65, 66, 67]);
    expect(kv.map.has('rom:rom-9')).toBe(true);
    expect(localStorage.getItem('emulingo:romdata:rom-9')).toBeNull();
  });
});

describe('library maintenance', () => {
  it('updates metadata and save info', async () => {
    const { rom: r } = await importRomFile(fakeFile('a.gb', gbRom(31)));
    await updateRom(r.id, { saves: { auto: { t: 5, core: 'gambatte', ejs: '4.2.3' } } });
    await updateRom(r.id, { saves: { manual: { t: 6 } } });
    await markPlayed(r.id);
    const cur = await getRom(r.id);
    expect(cur.saves).toEqual({ auto: { t: 5, core: 'gambatte', ejs: '4.2.3' }, manual: { t: 6 } });
    expect(cur.lastPlayed).toBeGreaterThan(0);
    expect(await updateRom('rom-missing', { title: 'x' })).toBeNull();
  });

  it('sorts by most recent activity', async () => {
    const a = await importRomFile(fakeFile('a.gb', gbRom(41)));
    await importRomFile(fakeFile('b.gb', gbRom(42)));
    await new Promise((r) => setTimeout(r, 5));
    await markPlayed(a.rom.id);
    expect((await listRoms())[0].id).toBe(a.rom.id);
  });

  it('getRomBytes returns a Uint8Array or null', async () => {
    const { rom: r } = await importRomFile(fakeFile('a.gb', gbRom(51)));
    expect(await getRomBytes(r.id)).toEqual(gbRom(51));
    expect(await getRomBytes('rom-nope')).toBeNull();
  });

  it('deleteRom removes bytes, both slots, the mirror and EmulatorJS’s battery save', async () => {
    const { rom: r } = await importRomFile(fakeFile('Crystal.gbc', gbRom(61)));
    const other = await importRomFile(fakeFile('Gold.gbc', gbRom(62)));
    for (const k of [`state:${r.id}:manual`, `state:${r.id}:auto`, `state:${r.id}`, `sram:${r.id}`, `state:${r.id}:auto-prev`]) kv.map.set(k, 1);
    kv.map.set(`state:${other.rom.id}:auto`, 1);
    // EmulatorJS's IDBFS database
    await new Promise((resolve) => {
      const req = indexedDB.open('/data/saves', 21);
      req.onupgradeneeded = () => req.result.createObjectStore('FILE_DATA');
      req.onsuccess = () => {
        const tx = req.result.transaction('FILE_DATA', 'readwrite');
        const s = tx.objectStore('FILE_DATA');
        s.put({ contents: 1 }, `/data/saves/Gambatte/${r.saveStem}.srm`);
        s.put({ contents: 1 }, `/data/saves/Gambatte/${r.saveStem}.rtc`);
        s.put({ contents: 1 }, `/data/saves/Gambatte/${other.rom.saveStem}.srm`);
        s.put({ mode: 1 }, '/data/saves/Gambatte');
        tx.oncomplete = () => { req.result.close(); resolve(); };
      };
    });
    // a running emulator's in-memory copy goes too
    const unlinked = [];
    window.EJS_emulator = { gameManager: { FS: {
      readdir: (d) => (d === '/data/saves' ? ['.', '..', 'Gambatte'] : ['.', '..', `${r.saveStem}.srm`, `${other.rom.saveStem}.srm`]),
      unlink: (p) => unlinked.push(p)
    } } };
    try {
      expect(await deleteRom(r.id)).toBe(true);
    } finally {
      delete window.EJS_emulator;
    }
    expect([...kv.map.keys()].filter((k) => k.includes(r.id))).toEqual([]);
    expect(kv.map.has(`state:${other.rom.id}:auto`)).toBe(true);
    expect((await listRoms()).map((x) => x.id)).toEqual([other.rom.id]);
    expect(unlinked).toEqual([`/data/saves/Gambatte/${r.saveStem}.srm`]);
    const left = await new Promise((resolve) => {
      const req = indexedDB.open('/data/saves');
      req.onsuccess = () => {
        const k = req.result.transaction('FILE_DATA').objectStore('FILE_DATA').getAllKeys();
        k.onsuccess = () => { req.result.close(); resolve(k.result); };
      };
    });
    expect(left.sort()).toEqual(['/data/saves/Gambatte', `/data/saves/Gambatte/${other.rom.saveStem}.srm`]);
    expect(await deleteRom(r.id)).toBe(false);
  });

  it('sweepOrphans deletes keys of ROMs that are no longer in the library', async () => {
    const { rom: r } = await importRomFile(fakeFile('a.gb', gbRom(71)));
    kv.map.set(`state:${r.id}:auto`, 1);
    kv.map.set('rom:rom-1690000000000', 1);
    kv.map.set('state:rom-1690000000000', 1);
    kv.map.set('state:rom-dead:manual', 1);
    kv.map.set('sram:rom-dead', 1);
    kv.map.set('sram:rom-session', 1);
    kv.map.set('spelldict:de', 1);
    expect(await sweepOrphans({ keep: ['rom-session'] })).toBe(4);
    expect([...kv.map.keys()].sort()).toEqual([INDEX_KEY, `rom:${r.id}`, 'spelldict:de', 'sram:rom-session', `state:${r.id}:auto`].sort());
  });
});
