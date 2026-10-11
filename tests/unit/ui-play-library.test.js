// @vitest-environment jsdom
// The game library (src/ui/views/play/library.js): importing a game links
// the game saves a backup restored before that game was on this device.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { idbGet, idbSet, idbKeys, idbClear } from '../../src/core/idb.js';

const RECORD = { id: 'rom-3333333333333333', name: 'gelb.gbc', title: 'gelb', core: 'gb', added: 1, saves: {} };

const fake = vi.hoisted(() => ({ persisted: true }));

vi.mock('../../src/core/rom.js', () => {
  const SYSTEMS = [{ core: 'gb', name: 'Game Boy and Game Boy Color', short: 'Game Boy', exts: ['gb', 'gbc'], aspect: 10 / 9 }];
  return {
    SYSTEMS,
    systemFor: (core) => SYSTEMS.find((s) => s.core === core) || null,
    listRoms: async () => [],
    acceptAttr: () => '.gb,.gbc',
    importRomFile: async () => ({ rom: { ...RECORD }, bytes: new Uint8Array([1, 2, 3]), duplicate: false, persisted: fake.persisted, warnings: [] }),
    deleteRom: async () => true
  };
});

const { createLibrary } = await import('../../src/ui/views/play/library.js');

const PENDING = { kind: 'sram', rom: 'gelb.gbc', suffix: '', value: { v: 1, files: { '/data/saves/gb/gelb.srm': { data: new Uint8Array([9, 8]), mtime: 1 } }, t: 1 } };

describe('createLibrary import', () => {
  beforeEach(async () => {
    document.body.innerHTML = '<section></section>';
    await idbClear();
    fake.persisted = true;
  });

  it('puts saves restored from a backup in place before the game starts', async () => {
    await idbSet('pendingsave:sram:x', PENDING);
    let sramAtStart = null;
    const onPlay = vi.fn(async (rec) => { sramAtStart = await idbGet('sram:' + rec.id); });
    const lib = createLibrary(document.querySelector('section'), { onPlay });
    await lib.importFile(new File([new Uint8Array([1, 2, 3])], 'gelb.gbc'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sramAtStart).toBeTruthy());
    expect(new Uint8Array(sramAtStart.files['/data/saves/gb/gelb.srm'].data)).toEqual(new Uint8Array([9, 8]));
    expect(await idbKeys('pendingsave:')).toEqual([]);
  });

  it('leaves waiting saves alone for a game kept only for this session', async () => {
    fake.persisted = false;
    await idbSet('pendingsave:sram:x', PENDING);
    const onPlay = vi.fn();
    const lib = createLibrary(document.querySelector('section'), { onPlay });
    await lib.importFile(new File([new Uint8Array([1, 2, 3])], 'gelb.gbc'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(await idbKeys('pendingsave:')).toEqual(['pendingsave:sram:x']);
    expect(await idbGet('sram:' + RECORD.id)).toBeUndefined();
  });
});
