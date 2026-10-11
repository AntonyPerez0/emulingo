// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createScanner, upscaleFactor } from '../../src/core/scanner.js';

// ---------------------------------------------------------------- fakes

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

// Deterministic clock: timers run in time order, promises settle in between.
function createClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn, id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const tm of timers.values()) {
          if (tm.at <= end && (!next || tm.at < next.at || (tm.at === next.at && tm.id < next.id))) next = tm;
        }
        if (!next) break;
        timers.delete(next.id);
        t = next.at;
        next.fn();
      }
      t = end;
      await flush();
    },
    // run fn at absolute time `at` (scripted screen changes)
    at(at, fn) {
      const id = ++seq;
      timers.set(id, { at, fn, id });
    }
  };
}

const L = (text, x, y, w, h = 8, score = 0.98) => ({ text, score, box: { x, y, w, h } });

const GB_DIALOG = { key: 'dialog:0,96,160,48', kind: 'dialog', x: 3, y: 99, w: 154, h: 42 };
const GB_MENU = { key: 'menu:80,0,80,128', kind: 'menu', x: 83, y: 3, w: 74, h: 122 };
const HUD_FOE = { key: 'box:8,8,96,24', kind: 'box', x: 8, y: 8, w: 96, h: 24 };
const HUD_OWN = { key: 'box:56,64,96,32', kind: 'box', x: 56, y: 64, w: 96, h: 32 };

// What the fake engine "reads" for each screen content id.
const READS = {
  'p1': [L('Hello there!', 8, 112, 96), L('Welcome to the', 8, 128, 112)],
  'p2': [L('Welcome to the', 8, 112, 112), L('world of POKéMON!', 8, 128, 136)],
  'p3': [L('world of POKéMON!', 8, 112, 136), L('My name is OAK!', 8, 128, 120)],
  'wild': [L('Wild PIDGEY', 8, 112, 88), L('appeared!', 8, 128, 72)],
  'wild+arrow': [L('Wild PIDGEY', 8, 112, 88), L('appeared! T', 8, 128, 88)],
  'wild+plus': [L('Wild PIDGEY', 8, 112, 88), L('appeared!+', 8, 128, 80)],
  'empty': [],
  'foe-hp20': [L('PIDGEY', 16, 10, 48), L(':L3', 64, 18, 24), L('HP:', 16, 24, 24)],
  'foe-hp19': [L('PIDGEY', 16, 10, 48), L(':L3', 64, 18, 24), L('HP:', 16, 24, 24)],
  'foe-hp18': [L('PIDIGEY', 16, 10, 56, 8, 0.7), L(':L3', 64, 18, 24)],
  'own-hp': [L('PIKAchU', 64, 66, 56), L(':L5', 120, 74, 24), L('19/ 20', 96, 88, 48)],
  'start-menu': [
    L('▶POKéDEX', 81, 16, 63), L('POKéMON', 88, 32, 56), L('ITEM', 88, 48, 32), L('RED', 88, 64, 24),
    L('SAvE', 88, 80, 32), L('OpTion', 88, 96, 48), L('EXIT', 88, 112, 32)
  ],
  'start-menu-jitter': [
    L('POKéDEX', 88, 16, 56), L('POKéMON', 88, 32, 56), L('ITEM', 88, 48, 32), L('RED', 88, 64, 24),
    L('▶SAVE', 81, 80, 39), L('OPTlON', 88, 96, 48), L('EXIT', 88, 112, 32)
  ],
  'start-menu-2': [
    L('POKéDEX', 88, 16, 56), L('POKéMON', 88, 32, 56), L('▶ITEM', 81, 48, 39), L('RED', 88, 64, 24),
    L('SAVE', 88, 80, 32), L('OPTION', 88, 96, 48), L('EXIT', 88, 112, 32)
  ],
  'save-q': [L('Would you like to', 8, 112, 136), L('SAVE the game?', 8, 128, 112)],
  'yes-no': [L('YES', 120, 16, 24), L('NO', 120, 32, 16)],
  'title': [L('PRESS START', 36, 120, 88)],
  'title-2': [L('PRESS START', 36, 120, 88), L('NEW GAME', 48, 40, 64)],
  'shaky': [L('Wild PIDGEY', 8, 112, 88, 8, 0.7), L('appeared!', 8, 128, 72, 8, 0.99)]
};

// A world of boxes whose content can change; the fake tracker mirrors
// createContainerTracker: per-key hash of the (masked) content and settle time.
function createWorld(clock) {
  const world = {
    boxes: [],
    free: null,
    available: true,
    cells: false,
    grabs: 0,
    resets: 0,
    zone: null
  };
  const hashes = new Map();
  const hashOf = (s) => {
    if (!hashes.has(s)) hashes.set(s, hashes.size + 1);
    return hashes.get(s);
  };
  world.frameSource = {
    grab() {
      world.grabs++;
      if (!world.available) return null;
      return { img: { data: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16 }, w: 160, h: 144, t: clock.now() };
    }
  };
  const live = new Map();
  world.tracker = {
    update() {
      const boxes = world.boxes.length ? world.boxes : [{ box: { key: 'free', kind: 'free', x: 0, y: 0, w: 160, h: 144 }, content: world.free }];
      return boxes.map(({ box, content }) => {
        const hash = hashOf(`${box.key}:${content}`);
        const prev = live.get(box.key);
        const since = prev && prev.hash === hash ? prev.since : clock.now();
        live.set(box.key, { hash, since });
        const container = {
          ...box,
          hash,
          settledMs: clock.now() - since,
          bg: [255, 255, 255],
          fg: [0, 0, 0],
          crop: () => ({ img: { width: box.w + 8, height: box.h + 8, content }, offset: { x: box.x - 4, y: box.y - 4 } })
        };
        // containers.js extension: one cell per text row/column of a framed box
        if (world.cells && box.kind !== 'free') {
          container.cells = () => (READS[content] || []).map((l, i) => ({
            row: i, col: 0, ...l.box,
            crop: () => ({ img: { width: l.box.w + 8, height: l.box.h + 6, content: `${content}#${i}` }, offset: { x: l.box.x - 4, y: l.box.y - 3 } })
          }));
        }
        return container;
      });
    },
    setZone(z) { world.zone = z; },
    reset() { world.resets++; live.clear(); }
  };
  world.show = (...boxes) => { world.boxes = boxes.map(([box, content]) => ({ box, content })); };
  return world;
}

function createEngine(clock, { latency = 300 } = {}) {
  let inFlight = 0;
  const engine = {
    calls: [],
    maxInFlight: 0,
    fail: 0,
    prepare: vi.fn(async () => {}),
    supports: vi.fn(() => 'neural'),
    read(job) {
      engine.calls.push(job);
      if (job.mode === 'lines' && engine.noLines) return Promise.reject(new TypeError('Unknown OCR mode “lines”.'));
      inFlight++;
      engine.maxInFlight = Math.max(engine.maxInFlight, inFlight);
      return new Promise((resolve, reject) => {
        clock.setTimeout(() => {
          inFlight--;
          if (engine.fail > 0) {
            engine.fail--;
            reject(new Error('worker crashed'));
            return;
          }
          if (job.mode === 'lines') {
            // recognition only: one line per strip, boxes are the strips'
            resolve({
              lines: job.strips.map((st) => {
                const [content, i] = st.img.content.split('#');
                const l = READS[content][Number(i)];
                return { text: l.text, score: l.score, box: { x: st.offset.x, y: st.offset.y, w: st.img.width / st.k, h: st.img.height / st.k } };
              }),
              ms: latency,
              engine: 'neural'
            });
            return;
          }
          // a whole-frame read (text outside the boxes) sees nothing here
          const lines = job.img && 'content' in job.img ? READS[job.img.content] : [];
          if (!lines) reject(new Error(`no fixture for ${job.img.content}`));
          else resolve({ lines: lines.map((l) => ({ ...l, box: { ...l.box } })), ms: latency, engine: 'neural' });
        }, latency);
      });
    }
  };
  return engine;
}

function createTranslate(clock, { latency = 100 } = {}) {
  const t = vi.fn((text, src, tgt) => new Promise((resolve, reject) => {
    clock.setTimeout(() => {
      if (t.failures > 0) {
        t.failures--;
        reject(new Error('HTTP 429'));
      } else {
        resolve(`[${tgt}] ${text}`);
      }
    }, latency);
  }));
  t.failures = 0;
  return t;
}

function setup(overrides = {}, settingsOverrides = {}) {
  const clock = createClock();
  const world = createWorld(clock);
  const engine = createEngine(clock, overrides.engine);
  const translate = createTranslate(clock);
  const settings = {
    source: 'en', target: 'de', waitForTyping: true, readAllText: false, scanSpeed: 'normal',
    spellCheck: true, ocrPaused: false, ...settingsOverrides
  };
  const settingsListeners = new Set();
  const correct = overrides.correct || vi.fn(async (text) => text);
  const scanner = createScanner({
    frameSource: world.frameSource,
    tracker: world.tracker,
    engine,
    correct,
    translate,
    getSettings: () => settings,
    clock,
    detectLanguage: overrides.detectLanguage,
    onSettingsChange: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn); },
    upscale: (img, k) => ({ ...img, width: img.width * k, height: img.height * k, k })
  });
  const events = [];
  const statuses = [];
  scanner.on('capture', (c) => events.push(['capture', c]));
  scanner.on('update', (c) => events.push(['update', c]));
  scanner.on('status', (s) => statuses.push(s));
  const change = (patch) => {
    Object.assign(settings, patch);
    for (const fn of settingsListeners) fn(Object.keys(patch)[0], Object.values(patch)[0]);
  };
  const captures = () => events.filter(([e]) => e === 'capture').map(([, c]) => c);
  const updates = () => events.filter(([e]) => e === 'update').map(([, c]) => c);
  const last = () => events.length ? events[events.length - 1][1] : null;
  return { clock, world, engine, translate, settings, scanner, events, statuses, change, captures, updates, last, correct };
}

// --------------------------------------------------------------- tests

describe('upscaleFactor', () => {
  it('uses ×4 for Game Boy-sized frames, ×3 above, capped at 1280 px', () => {
    expect(upscaleFactor(160, 168, 56)).toBe(4);
    expect(upscaleFactor(240, 248, 168)).toBe(4);
    expect(upscaleFactor(256, 264, 392)).toBe(3);
    expect(upscaleFactor(320, 328, 248)).toBe(3);
    expect(upscaleFactor(640, 648, 488)).toBe(1);
  });
});

describe('scanner: typewriter page', () => {
  it('waits for the text to settle, reads once and translates', async () => {
    const t = setup();
    t.scanner.start();
    // the page types for 1.8 s: the masked hash changes every 50 ms
    for (let i = 0; i < 36; i++) t.clock.at(i * 50, () => t.world.show([GB_DIALOG, `typing-${i}`]));
    t.clock.at(1800, () => t.world.show([GB_DIALOG, 'p1']));
    await t.clock.advance(2100);
    expect(t.engine.calls).toHaveLength(0);
    await t.clock.advance(600);
    expect(t.engine.calls).toHaveLength(1);
    const job = t.engine.calls[0];
    expect(job).toMatchObject({ k: 4, lang: 'en', mode: 'container', offset: { x: -1, y: 95 } });
    expect(t.captures()).toHaveLength(1);
    const cap = t.captures()[0];
    expect(cap).toMatchObject({ src: 'en', tgt: 'de', dialog: { text: 'Hello there! Welcome to the', status: 'pending' }, others: [] });
    expect(typeof cap.id).toBe('string');
    expect(cap.conf).toBeCloseTo(0.98);
    await t.clock.advance(200);
    expect(t.last()).toMatchObject({ id: cap.id, dialog: { translation: '[de] Hello there! Welcome to the', status: 'done' } });
    expect(t.scanner.getState().capture.dialog.status).toBe('done');
  });

  it('settles faster without "wait for typing"', async () => {
    const t = setup({}, { waitForTyping: false });
    t.world.show([GB_DIALOG, 'p1']);
    t.scanner.start();
    await t.clock.advance(250);
    expect(t.engine.calls).toHaveLength(1);
    const slow = setup();
    slow.world.show([GB_DIALOG, 'p1']);
    slow.scanner.start();
    await slow.clock.advance(250);
    expect(slow.engine.calls).toHaveLength(0);
    await slow.clock.advance(200);
    expect(slow.engine.calls).toHaveLength(1);
  });
});

describe('scanner: blinking ▼ arrow and duplicates', () => {
  it('reads a masked page once and never re-emits it while it stays for 30 s', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(30000);
    expect(t.engine.calls).toHaveLength(1);
    expect(t.captures()).toHaveLength(1);
    expect(t.captures()[0].dialog.text).toBe('Wild PIDGEY appeared!');
    expect(t.updates()).toHaveLength(1); // the translation
    expect(t.translate).toHaveBeenCalledTimes(1);
  });

  it('is robust when the arrow is not masked and read as "T" or "+"', async () => {
    const t = setup();
    t.scanner.start();
    const phases = ['wild', 'wild+arrow', 'wild', 'wild+plus'];
    for (let i = 0; i < 20; i++) t.clock.at(i * 500, () => t.world.show([GB_DIALOG, phases[i % 4]]));
    await t.clock.advance(11000);
    expect(t.captures()).toHaveLength(1);
    expect(t.captures()[0].dialog.text).toBe('Wild PIDGEY appeared!');
    for (const u of t.updates()) expect(u.dialog.text).toBe('Wild PIDGEY appeared!');
    // each blink phase is read once, then served from the per-box cache
    expect(t.engine.calls.length).toBeLessThanOrEqual(3);
  });

  it('does not re-emit the same text after the box closes and reopens', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1500);
    t.world.show();
    t.world.free = null;
    await t.clock.advance(3000);
    t.world.show([GB_DIALOG, 'wild']);
    await t.clock.advance(1500);
    expect(t.captures()).toHaveLength(1);
  });
});

describe('scanner: scrolling dialog', () => {
  it('merges three scrolled pages into one capture updated twice', async () => {
    const t = setup();
    t.scanner.start();
    t.world.show([GB_DIALOG, 'p1']);
    // pressing A scrolls: a few changing frames, then the next page types
    for (const [at, content] of [[2000, 'scroll-a'], [2080, 'scroll-b'], [2160, 'p2'], [4000, 'scroll-c'], [4080, 'scroll-d'], [4160, 'p3']]) {
      t.clock.at(at, () => t.world.show([GB_DIALOG, content]));
    }
    await t.clock.advance(6000);
    const caps = t.captures();
    expect(caps).toHaveLength(1);
    const texts = [...new Set(t.events.filter(([, c]) => c.id === caps[0].id).map(([, c]) => c.dialog.text))];
    expect(texts).toEqual([
      'Hello there! Welcome to the',
      'Hello there! Welcome to the world of POKéMON!',
      'Hello there! Welcome to the world of POKéMON! My name is OAK!'
    ]);
    for (const [, c] of t.events) expect(c.id).toBe(caps[0].id);
    expect(t.last().dialog).toEqual({
      text: 'Hello there! Welcome to the world of POKéMON! My name is OAK!',
      translation: '[de] Hello there! Welcome to the world of POKéMON! My name is OAK!',
      status: 'done'
    });
    expect(t.engine.calls).toHaveLength(3);
  });

  it('keeps the previous translation while the longer transcript is translated', async () => {
    const t = setup();
    t.scanner.start();
    t.world.show([GB_DIALOG, 'p1']);
    t.clock.at(2000, () => t.world.show([GB_DIALOG, 'p2']));
    await t.clock.advance(2700);
    const grown = t.updates().find((u) => u.dialog.text.endsWith('POKéMON!') && u.dialog.status === 'pending');
    expect(grown.dialog.translation).toBe('[de] Hello there! Welcome to the');
  });
});

describe('scanner: battle screens', () => {
  it('captures the battle dialog once while the HUD changes', async () => {
    const t = setup();
    t.scanner.start();
    t.world.show([GB_DIALOG, 'wild'], [HUD_FOE, 'foe-hp20'], [HUD_OWN, 'own-hp']);
    t.clock.at(1500, () => t.world.show([GB_DIALOG, 'wild'], [HUD_FOE, 'foe-hp19'], [HUD_OWN, 'own-hp']));
    t.clock.at(3000, () => t.world.show([GB_DIALOG, 'wild'], [HUD_FOE, 'foe-hp18'], [HUD_OWN, 'own-hp']));
    await t.clock.advance(6000);
    expect(t.captures()).toHaveLength(1);
    const cap = t.captures()[0];
    expect(cap.dialog.text).toBe('Wild PIDGEY appeared!');
    for (const u of t.updates()) expect(u.id).toBe(cap.id);
    const finalOthers = t.last().others.map((o) => [o.kind, o.text]);
    for (const [kind, text] of finalOthers) {
      expect(kind).toBe('label');
      expect(text).not.toMatch(/HP|:L|\d/u);
    }
  });

  it('never captures HUD labels on their own', async () => {
    const t = setup();
    t.scanner.start();
    t.world.show([GB_DIALOG, 'empty'], [HUD_FOE, 'foe-hp20'], [HUD_OWN, 'own-hp']);
    t.clock.at(1500, () => t.world.show([GB_DIALOG, 'empty'], [HUD_FOE, 'foe-hp19'], [HUD_OWN, 'own-hp']));
    t.clock.at(3000, () => t.world.show([GB_DIALOG, 'empty'], [HUD_FOE, 'foe-hp18'], [HUD_OWN, 'own-hp']));
    await t.clock.advance(6000);
    expect(t.events).toHaveLength(0);
    expect(t.engine.calls.length).toBeGreaterThan(0);
  });
});

describe('scanner: menus', () => {
  it('captures a menu with cleaned items and per-item translations', async () => {
    const t = setup();
    t.scanner.start();
    t.world.show([GB_MENU, 'start-menu']);
    await t.clock.advance(2000);
    expect(t.captures()).toHaveLength(1);
    const cap = t.captures()[0];
    expect(cap.dialog).toBe(null);
    expect(cap.others).toEqual([{
      key: 'menu:80,0,80,128:menu0', kind: 'menu', text: 'POKéDEX\nPOKéMON\nITEM\nRED\nSAVE\nOPTION\nEXIT', translation: '', status: 'pending'
    }]);
    // all-caps entries are translated one by one in title case
    const sent = t.translate.mock.calls.map((c) => c[0]);
    expect(sent).toEqual(['Pokédex', 'Pokémon', 'Item', 'Red', 'Save', 'Option', 'Exit']);
    expect(t.last().others[0]).toMatchObject({ status: 'done', translation: '[de] Pokédex\n[de] Pokémon\n[de] Item\n[de] Red\n[de] Save\n[de] Option\n[de] Exit' });
  });

  it('does not re-emit when only the cursor moves (or a letter is misread)', async () => {
    const t = setup();
    t.scanner.start();
    t.world.show([GB_MENU, 'start-menu']);
    t.clock.at(2000, () => t.world.show([GB_MENU, 'start-menu-2']));
    t.clock.at(4000, () => t.world.show([GB_MENU, 'start-menu-jitter']));
    await t.clock.advance(6000);
    expect(t.engine.calls).toHaveLength(3);
    expect(t.captures()).toHaveLength(1);
    expect(t.updates().every((u) => u.others.length === 1)).toBe(true);
  });

  it('adds a YES/NO menu to the dialog it belongs to', async () => {
    const t = setup();
    const YESNO = { key: 'menu:112,8,48,40', kind: 'menu', x: 112, y: 8, w: 48, h: 40 };
    t.scanner.start();
    t.world.show([GB_DIALOG, 'save-q']);
    t.clock.at(1500, () => t.world.show([GB_DIALOG, 'save-q'], [YESNO, 'yes-no']));
    await t.clock.advance(3500);
    expect(t.captures()).toHaveLength(1);
    expect(t.last().dialog.text).toBe('Would you like to SAVE the game?');
    expect(t.last().others.map((o) => o.text)).toEqual(['YES\nNO']);
    expect(t.last().id).toBe(t.captures()[0].id);
  });
});

describe('scanner: free text and settings', () => {
  it('reads the free frame only when allowed, after 700 ms, at most every 3 s', async () => {
    const t = setup({}, { readAllText: true });
    t.world.free = 'title';
    t.scanner.start();
    await t.clock.advance(650);
    expect(t.engine.calls).toHaveLength(0);
    await t.clock.advance(100);
    expect(t.engine.calls).toHaveLength(1);
    expect(t.engine.calls[0].mode).toBe('free');
    await t.clock.advance(400);
    expect(t.captures()[0].others[0]).toMatchObject({ kind: 'label', text: 'PRESS START' });
    t.world.free = 'title-2';
    await t.clock.advance(1500);
    expect(t.engine.calls).toHaveLength(1);
    await t.clock.advance(1500);
    expect(t.engine.calls).toHaveLength(2);
  });

  it('polls faster or slower with the scan speed setting', async () => {
    const grabsAt = async (scanSpeed) => {
      const t = setup({}, { scanSpeed });
      t.world.show([GB_DIALOG, 'wild']);
      t.scanner.start();
      await t.clock.advance(3000);
      return t.world.grabs;
    };
    const [relaxed, normal, fast] = [await grabsAt('relaxed'), await grabsAt('normal'), await grabsAt('fast')];
    expect(relaxed).toBeLessThan(normal);
    expect(normal).toBeLessThan(fast);
    expect(normal).toBeGreaterThanOrEqual(15);
  });

  it('never reads the free frame when "read text outside boxes" is off', async () => {
    const t = setup({}, { readAllText: false });
    t.world.free = 'title';
    t.scanner.start();
    await t.clock.advance(10000);
    expect(t.engine.calls).toHaveLength(0);
  });

  it('reads text outside the boxes at low priority when allowed', async () => {
    const t = setup({}, { readAllText: true });
    t.world.show([GB_DIALOG, 'wild']);
    READS['outside'] = [];
    t.scanner.start();
    await t.clock.advance(5000);
    const modes = t.engine.calls.map((c) => c.mode);
    expect(modes[0]).toBe('container');
    expect(modes).toContain('free');
    expect(t.engine.maxInFlight).toBe(1);
  });

  it('pauses on the settings toggle and when there is no game language', async () => {
    const t = setup({}, { ocrPaused: true });
    t.world.show([GB_DIALOG, 'p1']);
    t.scanner.start();
    await t.clock.advance(3000);
    expect(t.engine.calls).toHaveLength(0);
    expect(t.scanner.getState().status).toMatchObject({ state: 'paused', reason: 'user' });
    t.change({ ocrPaused: false, source: null });
    await t.clock.advance(1500);
    expect(t.scanner.getState().status).toMatchObject({ state: 'paused', reason: 'language' });
    t.change({ source: 'en' });
    await t.clock.advance(1500);
    expect(t.engine.calls).toHaveLength(1);
  });

  it('reports an unsupported language', async () => {
    const t = setup();
    t.engine.supports.mockReturnValue('none');
    t.scanner.start();
    await t.clock.advance(500);
    expect(t.scanner.getState().status.state).toBe('error');
    expect(t.world.grabs).toBe(0);
  });
});

describe('scanner: spell-correction', () => {
  it('corrects only uncertain lines and memoises the result', async () => {
    const correct = vi.fn(async (text) => text.replace('PIDGEY', 'PIDGEY'));
    const t = setup({ correct });
    t.world.show([GB_DIALOG, 'shaky']);
    t.scanner.start();
    await t.clock.advance(1500);
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct).toHaveBeenCalledWith('Wild PIDGEY', 'en', 0.7);
  });

  it('gives up after 2 s and does not memoise a timed-out correction', async () => {
    let slow = true;
    const correct = vi.fn((text) => (slow ? new Promise(() => {}) : Promise.resolve(text + ' (fixed)')));
    const t = setup({ correct });
    t.world.show([GB_DIALOG, 'shaky']);
    t.scanner.start();
    await t.clock.advance(1000);
    expect(t.captures()).toHaveLength(0);
    await t.clock.advance(2000);
    expect(t.captures()).toHaveLength(1);
    expect(t.captures()[0].dialog.text).toBe('Wild PIDGEY appeared!');
    // the same lines again (another blink phase): correction is retried
    slow = false;
    t.world.show([GB_DIALOG, 'wild+arrow']);
    READS['wild+arrow-shaky'] = READS.shaky;
    t.world.show([GB_DIALOG, 'wild+arrow-shaky']);
    await t.clock.advance(1500);
    expect(correct).toHaveBeenCalledTimes(2);
  });

  it('re-runs correction on the cached lines when spell-check is turned on', async () => {
    const correct = vi.fn(async (text) => text.replace('Wild', 'Wilde'));
    const t = setup({ correct }, { spellCheck: false });
    t.world.show([GB_DIALOG, 'shaky']);
    t.scanner.start();
    await t.clock.advance(1500);
    expect(correct).not.toHaveBeenCalled();
    expect(t.engine.calls).toHaveLength(1);
    t.change({ spellCheck: true });
    await t.clock.advance(1500);
    expect(correct).toHaveBeenCalledWith('Wild PIDGEY', 'en', 0.7);
    // no new read: the engine lines were cached
    expect(t.engine.calls).toHaveLength(1);
  });

  it('skips correction when spell-check is off', async () => {
    const t = setup({}, { spellCheck: false });
    t.world.show([GB_DIALOG, 'shaky']);
    t.scanner.start();
    await t.clock.advance(1500);
    expect(t.correct).not.toHaveBeenCalled();
  });
});

describe('scanner: translation failures', () => {
  it('marks the region as failed and retries once after 3 s', async () => {
    const t = setup();
    t.translate.failures = 1;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1000);
    expect(t.last().dialog.status).toBe('error');
    expect(t.scanner.getState().status).toMatchObject({ state: 'error' });
    expect(t.scanner.getState().status.message).toMatch(/3 seconds/u);
    await t.clock.advance(3200);
    expect(t.last().dialog).toMatchObject({ status: 'done', translation: '[de] Wild PIDGEY appeared!' });
    expect(t.scanner.getState().status.state).toBe('watching');
    expect(t.captures()).toHaveLength(1);
  });

  it('offers a manual retry after the automatic one fails', async () => {
    const t = setup();
    t.translate.failures = 2;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(5000);
    expect(t.last().dialog.status).toBe('error');
    expect(t.scanner.getState().status.message).toMatch(/Retry/u);
    expect(t.translate).toHaveBeenCalledTimes(2);
    const done = t.scanner.retryRegion('dialog');
    await t.clock.advance(200);
    await expect(done).resolves.toBe(true);
    expect(t.last().dialog.status).toBe('done');
    expect(await t.scanner.retryRegion('nope')).toBe(false);
  });
});

describe('scanner: settings changes reset the scanner', () => {
  it('re-reads the screen in the new game language', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1500);
    expect(t.engine.prepare).toHaveBeenLastCalledWith('en');
    const resets = t.world.resets;
    t.change({ source: 'de' });
    await t.clock.advance(1500);
    expect(t.engine.prepare).toHaveBeenLastCalledWith('de');
    expect(t.world.resets).toBeGreaterThan(resets);
    expect(t.engine.calls).toHaveLength(2);
    expect(t.engine.calls[1].lang).toBe('de');
    expect(t.captures()).toHaveLength(2);
    expect(t.captures()[1].src).toBe('de');
  });

  it('re-translates the visible capture into a new target language', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1500);
    t.change({ target: 'fr' });
    await t.clock.advance(1500);
    const caps = t.captures();
    expect(caps).toHaveLength(2);
    expect(caps[1]).toMatchObject({ tgt: 'fr', dialog: { text: 'Wild PIDGEY appeared!' } });
    expect(caps[1].id).not.toBe(caps[0].id);
    expect(t.last().dialog.translation).toBe('[fr] Wild PIDGEY appeared!');
  });

  it('resets on a new text zone', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1500);
    t.scanner.setZone({ x: 0, y: 0.6, w: 1, h: 0.4 });
    expect(t.world.zone).toEqual({ x: 0, y: 0.6, w: 1, h: 0.4 });
    await t.clock.advance(1500);
    expect(t.engine.calls).toHaveLength(2);
  });
});

describe('scanner: pause and resume', () => {
  it('stops polling while any reason holds and restarts after the last one', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(400);
    t.scanner.pause('view');
    t.scanner.pause('emulator');
    const grabs = t.world.grabs;
    await t.clock.advance(5000);
    expect(t.world.grabs).toBe(grabs);
    expect(t.scanner.getState()).toMatchObject({ paused: ['view', 'emulator'], status: { state: 'paused' } });
    t.scanner.resume('view');
    await t.clock.advance(1000);
    expect(t.world.grabs).toBe(grabs);
    t.scanner.resume('emulator');
    await t.clock.advance(1500);
    expect(t.world.grabs).toBeGreaterThan(grabs);
    expect(t.captures()).toHaveLength(1);
  });

  it('does not emit a read that finishes after a pause, and resumes it later', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(500); // read in flight
    t.scanner.pause('user');
    await t.clock.advance(2000);
    expect(t.captures()).toHaveLength(0);
    t.scanner.resume('user');
    await t.clock.advance(300);
    expect(t.captures()).toHaveLength(1);
    expect(t.engine.calls).toHaveLength(1);
  });

  it('lets "Translate now" work while auto-translate is paused', async () => {
    const t = setup({}, { ocrPaused: true });
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1000);
    const p = t.scanner.scanNow();
    await t.clock.advance(500);
    expect((await p).dialog.text).toBe('Wild PIDGEY appeared!');
    expect(t.captures()).toHaveLength(1);
  });

  it('waits quietly while the game screen is unavailable', async () => {
    const t = setup();
    t.world.available = false;
    t.scanner.start();
    await t.clock.advance(2000);
    expect(t.scanner.getState().status).toMatchObject({ state: 'paused', reason: 'frame' });
    expect(t.statuses.some((s) => s.state === 'error')).toBe(false);
    t.world.available = true;
    t.world.show([GB_DIALOG, 'wild']);
    await t.clock.advance(1500);
    expect(t.captures()).toHaveLength(1);
  });

  it('stop() turns it off', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    t.scanner.stop();
    await t.clock.advance(3000);
    expect(t.world.grabs).toBe(0);
    expect(t.scanner.getState().status.state).toBe('off');
  });
});

describe('scanner: Translate now', () => {
  it('waits for the read in flight, reads again and resolves with the capture', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(500); // settled at 400 ms: a read is in flight
    expect(t.engine.calls).toHaveLength(1);
    const p1 = t.scanner.scanNow();
    const p2 = t.scanner.scanNow();
    expect(p2).toBe(p1);
    expect(t.scanner.getState().busy).toBe(true);
    await t.clock.advance(1000);
    const cap = await p1;
    expect(cap).toMatchObject({ dialog: { text: 'Wild PIDGEY appeared!' } });
    expect(t.engine.calls).toHaveLength(2);
    expect(t.engine.maxInFlight).toBe(1);
    expect(t.captures()).toHaveLength(1);
  });

  it('reads an unsettled box right away', async () => {
    const t = setup();
    t.scanner.start();
    t.world.show([GB_DIALOG, 'p1']);
    await t.clock.advance(100);
    const p = t.scanner.scanNow();
    await t.clock.advance(500);
    expect((await p).dialog.text).toBe('Hello there! Welcome to the');
  });

  it('reads the free frame even when outside-box reading is off, and resolves null without text', async () => {
    const t = setup({}, { readAllText: false });
    t.world.free = 'title';
    t.scanner.start();
    const p = t.scanner.scanNow();
    await t.clock.advance(500);
    expect((await p).others[0].text).toBe('PRESS START');
    t.world.free = 'empty';
    const q = t.scanner.scanNow();
    await t.clock.advance(500);
    expect(await q).toBe(null);
  });

  it('resolves null when stopped', async () => {
    const t = setup();
    expect(await t.scanner.scanNow()).toBe(null);
  });
});

describe('scanner: robustness', () => {
  it('backs off after engine failures and recovers', async () => {
    const t = setup();
    t.engine.fail = 2;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(800);
    expect(t.scanner.getState().status.state).toBe('error');
    await t.clock.advance(5000);
    expect(t.captures()).toHaveLength(1);
    expect(t.scanner.getState().status.state).toBe('watching');
  });

  it('survives a throwing frame source and listener', async () => {
    const t = setup();
    t.scanner.on('capture', () => { throw new Error('listener bug'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const grab = t.world.frameSource.grab;
    t.world.frameSource.grab = () => (++n < 3 ? (() => { throw new Error('canvas lost'); })() : grab());
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(2000);
    expect(t.captures()).toHaveLength(1);
    err.mockRestore();
  });

  it('flags a language mismatch after three dialog captures', async () => {
    const detectLanguage = vi.fn(async () => 'de');
    const t = setup({ detectLanguage });
    t.scanner.start();
    const pages = ['wild', 'save-q', 'p3'];
    pages.forEach((p, i) => t.clock.at(i * 2000, () => t.world.show([GB_DIALOG, p])));
    await t.clock.advance(6500);
    expect(t.captures()).toHaveLength(3);
    expect(detectLanguage).toHaveBeenCalledTimes(3);
    expect(t.scanner.getState().status.hint).toEqual({ type: 'language-mismatch', detected: 'de', expected: 'en' });
    expect(t.statuses.at(-1).hint).toMatchObject({ type: 'language-mismatch' });
    t.scanner.dismissHint();
    expect(t.scanner.getState().status.hint).toBe(null);
  });

  it('forwards engine set-up progress', async () => {
    const t = setup();
    t.scanner.start();
    t.scanner.noteEngineStatus({ phase: 'download', progress: 0.5, message: 'Downloading text recognition (12 MB)…' });
    expect(t.scanner.getState().status).toMatchObject({ state: 'setup', progress: 0.5 });
    t.scanner.noteEngineStatus({ phase: 'ready', progress: 1 });
    await t.clock.advance(300);
    expect(t.scanner.getState().status.state).not.toBe('setup');
  });

  it('rejects unknown events', () => {
    const t = setup();
    expect(() => t.scanner.on('nope', () => {})).toThrow();
    const off = t.scanner.on('status', () => {});
    expect(typeof off).toBe('function');
    off();
  });
});

describe('scanner: text-row cells (lines mode)', () => {
  it('recognises the rows of framed boxes without the detector', async () => {
    const t = setup();
    t.world.cells = true;
    t.world.show([GB_DIALOG, 'wild+arrow'], [HUD_FOE, 'foe-hp20']);
    t.scanner.start();
    await t.clock.advance(1500);
    const modes = t.engine.calls.map((c) => c.mode);
    expect(modes).toEqual(['lines', 'lines']);
    expect(t.engine.calls[0].strips).toHaveLength(2);
    expect(t.engine.calls[0].strips[0]).toMatchObject({ k: 4, offset: { x: 4, y: 109 } });
    expect(t.captures()).toHaveLength(1);
    expect(t.captures()[0].dialog.text).toBe('Wild PIDGEY appeared!');
    // the HUD plate is read after the dialog (lower priority) and, being a
    // label, does not update the capture
    expect(t.events.map(([e]) => e)).toEqual(['capture', 'update']);
  });

  it('splits menu cells into items and skips empty boxes without a read', async () => {
    const t = setup();
    t.world.cells = true;
    t.world.show([GB_MENU, 'start-menu'], [GB_DIALOG, 'empty']);
    t.scanner.start();
    await t.clock.advance(1500);
    expect(t.engine.calls).toHaveLength(1);
    expect(t.captures()[0].others[0].text).toBe('POKéDEX\nPOKéMON\nITEM\nRED\nSAVE\nOPTION\nEXIT');
  });

  it('falls back to the detector when the engine has no line mode', async () => {
    const t = setup();
    t.world.cells = true;
    t.engine.noLines = true;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1500);
    expect(t.engine.calls.map((c) => c.mode)).toEqual(['lines', 'container']);
    expect(t.captures()[0].dialog.text).toBe('Wild PIDGEY appeared!');
  });
});

describe('scanner: review fixes', () => {
  it('passes the cells\' columns to the layout (narrow menu columns stay apart)', async () => {
    const t = setup();
    t.world.cells = true;
    const MENU = { key: 'menu:72,96,88,48', kind: 'menu', x: 75, y: 99, w: 82, h: 42 };
    READS['battle-menu'] = [L('FIGHT', 80, 112, 39, 7), L('ITEM', 80, 128, 31, 7), L('RUN', 128, 128, 23, 7)];
    t.world.show([MENU, 'battle-menu']);
    const cells = t.world.tracker.update;
    t.world.tracker.update = (frame) => cells(frame).map((c) => (c.cells
      ? { ...c, cells: () => [
        { row: 0, col: 0, x: 80, y: 112, w: 39, h: 7, crop: () => ({ img: { width: 47, height: 13, content: 'battle-menu#0' }, offset: { x: 76, y: 109 } }) },
        { row: 1, col: 0, x: 80, y: 128, w: 31, h: 7, crop: () => ({ img: { width: 39, height: 13, content: 'battle-menu#1' }, offset: { x: 76, y: 125 } }) },
        { row: 1, col: 1, x: 128, y: 128, w: 23, h: 7, crop: () => ({ img: { width: 31, height: 13, content: 'battle-menu#2' }, offset: { x: 124, y: 125 } }) }
      ] }
      : c));
    t.scanner.start();
    await t.clock.advance(1500);
    expect(t.captures()[0].others[0].text).toBe('FIGHT\nITEM\nRUN');
  });

  it('keeps line mode after a read error that is not about the mode', async () => {
    const t = setup();
    t.world.cells = true;
    const read = t.engine.read;
    let failed = false;
    t.engine.read = (job) => {
      if (!failed) {
        failed = true;
        t.engine.calls.push(job);
        return Promise.reject(new TypeError('Every strip needs an ImageData img.'));
      }
      return read(job);
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(3000);
    expect(t.engine.calls.map((c) => c.mode)).toEqual(['lines', 'lines']);
    expect(t.captures()[0].dialog.text).toBe('Wild PIDGEY appeared!');
    console.warn.mockRestore();
  });

  it('leaves the set-up state once a read succeeds, even without a "ready" report', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(450);
    expect(t.engine.calls).toHaveLength(1);
    // the read falls back to Tesseract, which reports its download but
    // never a failure
    t.scanner.noteEngineStatus({ phase: 'download', progress: 0.2, message: 'Downloading text data for this language…' });
    expect(t.scanner.getState().status.state).toBe('setup');
    await t.clock.advance(2000);
    expect(t.captures()).toHaveLength(1);
    expect(t.scanner.getState().status.state).toBe('watching');
  });

  it('does not chain another read after the player pauses auto-translate', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild'], [GB_MENU, 'start-menu']);
    t.scanner.start();
    await t.clock.advance(500);
    expect(t.engine.calls).toHaveLength(1);
    t.change({ ocrPaused: true });
    await t.clock.advance(3000);
    expect(t.engine.calls).toHaveLength(1);
    expect(t.scanner.getState().status.state).toBe('paused');
  });

  it('reuses the read of the scene around a box when the box opens again', async () => {
    const t = setup({}, { readAllText: true });
    t.world.free = 'empty';
    const outsideReads = () => t.engine.calls.filter((c) => c.mode === 'free' && !('content' in c.img)).length;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(5000);
    expect(outsideReads()).toBe(1);
    t.world.show();
    await t.clock.advance(2000);
    t.world.show([GB_DIALOG, 'wild']);
    await t.clock.advance(6000);
    expect(outsideReads()).toBe(1);
  });

  it('does not retry a failed translation after stop()', async () => {
    const t = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.translate.failures = 1;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1000);
    expect(t.translate).toHaveBeenCalledTimes(1);
    t.scanner.stop();
    await t.clock.advance(5000);
    expect(t.translate).toHaveBeenCalledTimes(1);
    console.warn.mockRestore();
  });

  it('shows a new page that differs from the shown one by a word or a number', async () => {
    const t = setup();
    READS['rattata'] = [L('Wild RATTATA', 8, 112, 96), L('appeared!', 8, 128, 72)];
    READS['raticate'] = [L('Wild RATICATE', 8, 112, 104), L('appeared!', 8, 128, 72)];
    READS['lv6'] = [L('PIKACHU grew to', 8, 112, 120), L('level 6!', 8, 128, 64)];
    READS['lv7'] = [L('PIKACHU grew to', 8, 112, 120), L('level 7!', 8, 128, 64)];
    t.scanner.start();
    const seq = ['rattata', null, 'raticate', null, 'lv6', null, 'lv7'];
    seq.forEach((c, i) => t.clock.at(i * 2000, () => (c ? t.world.show([GB_DIALOG, c]) : t.world.show())));
    await t.clock.advance(seq.length * 2000);
    expect(t.captures().map((c) => c.dialog.text)).toEqual([
      'Wild RATTATA appeared!', 'Wild RATICATE appeared!', 'PIKACHU grew to level 6!', 'PIKACHU grew to level 7!'
    ]);
  });

  it('memoises a translation that finished after the text grew', async () => {
    const t = setup();
    t.translate.mockImplementation((text, src, tgt) => new Promise((resolve) => {
      t.clock.setTimeout(() => resolve(`[${tgt}] ${text}`), 2000);
    }));
    t.scanner.start();
    t.world.show([GB_DIALOG, 'p1']);
    t.clock.at(500, () => t.world.show([GB_DIALOG, 'p2']));
    await t.clock.advance(4000);
    const texts = t.translate.mock.calls.map((c) => c[0]);
    expect(texts).toEqual(['Hello there! Welcome to the', 'Hello there! Welcome to the world of POKéMON!']);
    // the first page's translation arrived too late to show, but is cached:
    // seeing that page again costs no request
    t.world.show([GB_DIALOG, 'p1']);
    t.scanner.reset();
    await t.clock.advance(1500);
    expect(t.scanner.getState().capture.dialog).toMatchObject({ text: 'Hello there! Welcome to the', status: 'done' });
    expect(t.translate).toHaveBeenCalledTimes(2);
  });
});
