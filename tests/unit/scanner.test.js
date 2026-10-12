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
  'shaky': [L('Wild PIDGEY', 8, 112, 88, 8, 0.7), L('appeared!', 8, 128, 72, 8, 0.99)],
  'long1': [L('Hello there! Glad to', 8, 112, 144), L('meet you! Welcome to', 8, 128, 144)],
  'long2': [L('the world of POKéMON!', 8, 112, 144), L('My name is OAK!', 8, 128, 120)]
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
    zone: null,
    // main-thread cost of a grab, on a scripted CPU clock (desktop: ~1 ms)
    grabCost: 1,
    grabTimes: [],
    cpu: 0
  };
  world.cpuClock = () => world.cpu;
  const hashes = new Map();
  const hashOf = (s) => {
    if (!hashes.has(s)) hashes.set(s, hashes.size + 1);
    return hashes.get(s);
  };
  world.frameSource = {
    grab() {
      world.grabs++;
      if (!world.available) return null;
      world.cpu += typeof world.grabCost === 'function' ? world.grabCost(world.grabTimes.length) : world.grabCost;
      world.grabTimes.push(clock.now());
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
        reject(Object.assign(new Error('HTTP 429'), t.failCode ? { code: t.failCode } : {}));
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
    cpuClock: world.cpuClock,
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
    t.world.show([GB_MENU, 'start-menu']);
    READS['outside'] = [];
    t.scanner.start();
    await t.clock.advance(5000);
    const modes = t.engine.calls.map((c) => c.mode);
    expect(modes[0]).toBe('container');
    expect(modes).toContain('free');
    expect(t.engine.maxInFlight).toBe(1);
  });

  // A 160×144 frame with something drawn outside the boxes: `paint` changes it.
  function paintedScreen(t) {
    const W = 160, H = 144;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const grab = t.world.frameSource.grab;
    t.world.frameSource.grab = () => {
      const f = grab();
      if (f) f.img = { data: data.slice(), width: W, height: H };
      return f;
    };
    return (x, y, w, h, v) => {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set([v, v, v, 255], (yy * W + xx) * 4);
    };
  }

  it('waits long for the rest of the screen while a dialog or battle box is on screen, where whole-screen reads are slow (a phone)', async () => {
    for (const box of [GB_DIALOG, { ...GB_DIALOG, key: 'battle:0,96,160,48', kind: 'battle' }]) {
      const t = setup({}, { readAllText: true });
      paintedScreen(t)(16, 16, 24, 8, 0);
      // (no whole-screen read timed yet: taken for a slow one)
      t.scanner.start();
      ['p1', 'p2', 'p3'].forEach((p, i) => t.clock.at(i * 1500, () => t.world.show([box, p])));
      // the player lingers on the last page: a whole-screen read started
      // soon would hold up the next page's read, and that press is likely
      await t.clock.advance(3000 + 7900);
      expect(t.engine.calls.map((c) => c.mode), box.kind).toEqual(['container', 'container', 'container']);
      // still for 8 s: the rest of the screen is read after all
      await t.clock.advance(400);
      expect(t.engine.calls.map((c) => c.mode), box.kind).toEqual(['container', 'container', 'container', 'free']);
      expect(t.scanner.getState().stats.screenReads).toBe(1);
    }
  });

  it('reads the rest of the screen 2 s into a still dialog or battle where whole-screen reads are quick (a desktop)', async () => {
    const battle = { ...GB_DIALOG, key: 'battle:0,96,160,48', kind: 'battle' };
    const t = setup({}, { readAllText: true });
    const paint = paintedScreen(t);
    // a menu first: its scene is read in 300 ms (the fake engine's latency)
    t.world.show([GB_MENU, 'start-menu']);
    t.scanner.start();
    await t.clock.advance(3000);
    expect(t.engine.calls.map((c) => c.mode)).toEqual(['container', 'free']);
    // a battle: its box, and the foe's name and level above it
    const reads = [];
    const read = t.engine.read;
    t.engine.read = (job) => { reads.push([t.clock.now(), job.mode]); return read(job); };
    t.world.show([battle, 'wild']);
    paint(16, 16, 48, 8, 0);
    await t.clock.advance(4000);
    expect(reads.map(([, mode]) => mode)).toEqual(['container', 'free']);
    // once the box has been still for 2 s (it was first seen at 3000)
    expect(reads[1][0]).toBeGreaterThanOrEqual(3000 + 2000);
    expect(reads[1][0]).toBeLessThanOrEqual(3000 + 2000 + 400);
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

  it('lets a Retry during the automatic retry wait for its outcome, and shows the part as translating again', async () => {
    const t = setup();
    t.translate.failures = 1;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(1000);
    expect(t.last().dialog.status).toBe('error');
    // step to the moment the automatic retry starts
    for (let i = 0; i < 250 && t.translate.mock.calls.length < 2; i++) await t.clock.advance(20);
    expect(t.translate).toHaveBeenCalledTimes(2);
    expect(t.last().dialog.status).toBe('pending');
    const done = t.scanner.retryRegion('dialog');
    await t.clock.advance(200);
    await expect(done).resolves.toBe(true);
    expect(t.translate).toHaveBeenCalledTimes(2);
    expect(t.last().dialog).toMatchObject({ status: 'done', translation: '[de] Wild PIDGEY appeared!' });
  });

  it('says why translation failed: busy service or offline, not always the connection', async () => {
    const t = setup();
    t.translate.failures = 2;
    t.translate.failCode = 'rate-limited';
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(5000);
    expect(t.scanner.getState().status).toMatchObject({ state: 'error', message: expect.stringMatching(/busy/u) });
    t.translate.failures = 1;
    t.translate.failCode = 'offline';
    t.scanner.retryRegion('dialog');
    await t.clock.advance(200);
    expect(t.scanner.getState().status.message).toMatch(/offline/u);
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

  it('answers with the boxes first, then adds text found outside them', async () => {
    const t = setup({}, { readAllText: true });
    READS['sign-outside'] = [L('ROUTE 1', 16, 16, 56)];
    const grab = t.world.frameSource.grab;
    t.world.frameSource.grab = () => {
      const f = grab();
      if (f) f.img.content = 'sign-outside';
      return f;
    };
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(50);
    const p = t.scanner.scanNow();
    await t.clock.advance(350);
    // the box read (300 ms) is the answer; the whole-screen read follows
    const cap = await p;
    expect(cap).toMatchObject({ dialog: { text: 'Wild PIDGEY appeared!' }, others: [] });
    expect(t.engine.calls.map((c) => c.mode)).toEqual(['container', 'free']);
    await t.clock.advance(400);
    expect(t.last().id).toBe(cap.id);
    expect(t.last().others).toMatchObject([{ kind: 'label', text: 'ROUTE 1' }]);
    expect(t.captures()).toHaveLength(1);
    expect(t.engine.maxInFlight).toBe(1);
    // pressed again soon after: the boxes only (the next press would wait
    // seconds behind another whole-screen read)
    const q = t.scanner.scanNow();
    await t.clock.advance(350);
    expect((await q).dialog.text).toBe('Wild PIDGEY appeared!');
    expect(t.engine.calls.filter((c) => c.mode === 'free')).toHaveLength(1);
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

  it('flags a mismatch from one long line that continues on the next page', async () => {
    const detectLanguage = vi.fn(async () => 'de');
    const t = setup({ detectLanguage });
    t.scanner.start();
    t.world.show([GB_DIALOG, 'long1']);
    await t.clock.advance(2000);
    expect(t.scanner.getState().status.hint).toBe(null);
    t.world.show([GB_DIALOG, 'long2']);
    await t.clock.advance(2000);
    // one capture that grew: two checks with 60 letters of German text
    expect(t.captures()).toHaveLength(1);
    expect(detectLanguage).toHaveBeenCalledTimes(2);
    expect(t.scanner.getState().status.hint).toEqual({ type: 'language-mismatch', detected: 'de', expected: 'en' });
  });

  it('needs more than one short line in another language', async () => {
    const detectLanguage = vi.fn(async () => 'de');
    const t = setup({ detectLanguage });
    t.scanner.start();
    t.world.show([GB_DIALOG, 'wild']);
    await t.clock.advance(2000);
    t.world.show([GB_DIALOG, 'empty']);
    await t.clock.advance(2000);
    t.world.show([GB_DIALOG, 'wild+plus']);
    await t.clock.advance(2000);
    expect(detectLanguage).toHaveBeenCalledTimes(1);
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
    t.world.show([GB_MENU, 'start-menu']);
    t.scanner.start();
    await t.clock.advance(5000);
    expect(outsideReads()).toBe(1);
    t.world.show();
    await t.clock.advance(2000);
    t.world.show([GB_MENU, 'start-menu']);
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

describe('scanner: main-thread budget (slow phones)', () => {
  const gaps = (times) => times.slice(1).map((at, i) => at - times[i]);

  it('keeps the normal cadence when a poll is cheap (desktop)', async () => {
    const t = setup();
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(3000);
    expect(gaps(t.world.grabTimes).every((g) => g === 200)).toBe(true);
    expect(t.engine.calls).toHaveLength(1);
    expect(t.scanner.getState().stats).toMatchObject({ pollCostMs: 1, pollEveryMs: 200 });
  });

  it('spaces expensive polls so they take at most ~5 % of the main thread, and still reads', async () => {
    const t = setup();
    t.world.grabCost = 25; // a slow phone: frame grab + box tracking
    t.world.show([GB_MENU, 'start-menu']);
    t.scanner.start();
    await t.clock.advance(1000);
    // settled at 400 ms, read on the first poll the budget allows
    expect(t.world.grabTimes).toEqual([0, 500, 1000]);
    expect(t.engine.calls).toHaveLength(1);
    await t.clock.advance(5000);
    // 25 ms × 20 apart
    expect(gaps(t.world.grabTimes).every((x) => x === 500)).toBe(true);
    expect((25 * t.world.grabTimes.length) / 6000).toBeLessThanOrEqual(0.055);
    expect(t.scanner.getState().stats).toMatchObject({ pollCostMs: 25, pollEveryMs: 500 });
    expect(t.captures()).toHaveLength(1);
  });

  it('paces a dialog by what a poll of the still screen costs, once three are known', async () => {
    const t = setup();
    t.world.grabCost = 25;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(6000);
    // the first page is not held back while that is unknown (three polls
    // at the normal cadence, the page read when it settles at 400 ms), then
    // 25 ms × 20 apart
    expect(t.world.grabTimes.slice(0, 5)).toEqual([0, 200, 400, 600, 1100]);
    expect(gaps(t.world.grabTimes.slice(3)).every((x) => x === 500)).toBe(true);
    expect(t.scanner.getState().stats).toMatchObject({ pollCostMs: 25, pollEveryMs: 500 });
    expect(t.captures()).toHaveLength(1);
  });

  it('lets settle wake-ups through while the budget allows', async () => {
    // "wait for typing" off: a still box counts as settled after 250 ms; a
    // 6 ms poll owes 120 ms, so the wake-up 50 ms after the 200 ms poll runs
    const t = setup({}, { waitForTyping: false });
    t.world.grabCost = 6;
    t.world.show([GB_DIALOG, 'p1']);
    t.scanner.start();
    await t.clock.advance(250);
    expect(t.world.grabTimes).toEqual([0, 200, 250]);
    expect(t.engine.calls).toHaveLength(1);
  });

  it('reads a page the moment it has been still for 400 ms, between budget-paced polls', async () => {
    const t = setup();
    t.world.grabCost = 17.5; // 350 ms apart
    t.scanner.start();
    t.clock.at(1234, () => t.world.show([GB_DIALOG, 'wild']));
    await t.clock.advance(1799);
    // the box appears at the 1400 poll and is still at 1750: it settles at
    // 1800, before the next poll the budget allows (2100)
    expect(t.world.grabTimes).toEqual([0, 350, 700, 1050, 1400, 1750]);
    expect(t.engine.calls).toHaveLength(0);
    await t.clock.advance(1);
    expect(t.engine.calls).toHaveLength(1);
    // the early poll is paid back
    await t.clock.advance(1000);
    expect(t.world.grabTimes.slice(6)).toEqual([1800, 2450, 2800]);
  });

  it('keeps to the budget while a page is typed (every poll sees a change)', async () => {
    const t = setup();
    t.world.grabCost = 25;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    for (let i = 0; i < 60; i++) t.clock.at(2000 + i * 50, () => t.world.show([GB_DIALOG, `typing-${i}`]));
    t.clock.at(5000, () => t.world.show([GB_DIALOG, 'p1']));
    await t.clock.advance(8000);
    // a box that keeps changing borrows nothing: 500 ms apart throughout
    // (after the three polls that tell what a still poll costs), and the
    // page is read on the first poll after it settled
    expect(gaps(t.world.grabTimes.slice(3)).every((g) => g === 500)).toBe(true);
    expect(t.engine.calls).toHaveLength(2);
    expect(t.captures()[1].dialog.text).toBe('Hello there! Welcome to the');
  });

  it('does not hold back the first page at game start, before it knows what a still poll costs', async () => {
    const t = setup({}, { scanSpeed: 'relaxed' }); // a phone: 300 ms
    // the first poll is cold (120 ms), each one that sees the page typing
    // detects a new frame (40 ms), a still one costs 15 ms
    t.world.grabCost = (i) => (i === 0 ? 120 : t.clock.now() < 2000 ? 40 : 15);
    const reads = [];
    const read = t.engine.read;
    t.engine.read = (job) => { reads.push(t.clock.now()); return read(job); };
    t.scanner.start();
    for (let i = 0; i < 40; i++) t.clock.at(i * 50, () => t.world.show([GB_DIALOG, `typing-${i}`]));
    t.clock.at(2000, () => t.world.show([GB_DIALOG, 'p1']));
    await t.clock.advance(5000);
    // typed at 2000: seen within one 300 ms poll, read once still for 400 ms
    expect(reads).toHaveLength(1);
    expect(reads[0]).toBeLessThanOrEqual(2000 + 300 + 400);
    // and then the budget: 15 ms × 20 apart
    expect(t.scanner.getState().stats).toMatchObject({ pollCostMs: 15, pollEveryMs: 300 });
  });

  it('reads the first page after a run of new frames promptly, keeping to the budget during the run (walking, then a dialog)', async () => {
    const t = setup({}, { scanSpeed: 'relaxed' });
    // a poll that sees a new frame costs 40 ms (detected afresh), a still one 15 ms
    let lastKey = null;
    t.world.grabCost = () => {
      const key = JSON.stringify([t.world.boxes.map((b) => b.content), t.world.free]);
      const cost = key === lastKey ? 15 : 40;
      lastKey = key;
      return cost;
    };
    const reads = [];
    const read = t.engine.read;
    t.engine.read = (job) => { reads.push([t.clock.now(), job.offset && job.offset.y]); return read(job); };
    t.world.show([GB_MENU, 'start-menu']);
    t.scanner.start();
    // the menu closes and the player walks (no box, the map scrolls) for 4 s
    t.clock.at(2000, () => t.world.show());
    for (let i = 0; i < 80; i++) t.clock.at(2000 + i * 50, () => { t.world.free = `map-${i}`; });
    // then talks to someone: the page types for a second
    for (let i = 0; i < 20; i++) t.clock.at(6000 + i * 50, () => t.world.show([GB_DIALOG, `typing-${i}`]));
    t.clock.at(7000, () => t.world.show([GB_DIALOG, 'p1']));
    await t.clock.advance(9000);
    // walking: once the samples are all new frames, paced at 40 ms × 20
    const walking = t.world.grabTimes.filter((at) => at >= 3800 && at <= 6200);
    expect(walking.length).toBeGreaterThanOrEqual(3);
    expect(gaps(walking).every((g) => g === 800)).toBe(true);
    // the page: read within one 300 ms poll and 400 ms of being typed
    const dialogReads = reads.filter(([, y]) => y === GB_DIALOG.y - 4);
    expect(dialogReads).toHaveLength(1);
    expect(dialogReads[0][0]).toBeLessThanOrEqual(7000 + 300 + 400);
    expect(t.captures().at(-1).dialog.text).toBe('Hello there! Welcome to the');
  });

  it('does not slow down while a page is typed, when each poll costs more', async () => {
    const t = setup({}, { scanSpeed: 'relaxed' }); // a phone: 300 ms
    // 15 ms a poll (300 ms at 5 %), 30 ms while the page types (new frames)
    t.world.grabCost = () => (t.clock.now() >= 3000 && t.clock.now() <= 4200 ? 30 : 15);
    t.world.show([GB_DIALOG, 'p1']);
    t.scanner.start();
    for (let i = 0; i < 20; i++) t.clock.at(3000 + i * 50, () => t.world.show([GB_DIALOG, `typing-${i}`]));
    t.clock.at(4000, () => t.world.show([GB_DIALOG, 'p2']));
    await t.clock.advance(4399);
    // (p1 is read at 400 ms, on a wake-up between the 300 ms polls)
    expect(gaps(t.world.grabTimes.filter((at) => at >= 400)).every((g) => g === 300)).toBe(true);
    expect(t.scanner.getState().stats).toMatchObject({ pollCostMs: 15, pollEveryMs: 300 });
    expect(t.engine.calls).toHaveLength(1);
    // p2 is first seen at 4000 and read the moment it has been still 400 ms
    await t.clock.advance(1);
    expect(t.engine.calls).toHaveLength(2);
  });

  it('returns to the normal cadence once polls are cheap again', async () => {
    const t = setup();
    t.world.grabCost = 20;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(3000);
    expect(t.scanner.getState().stats.pollEveryMs).toBe(400);
    t.world.grabCost = 1;
    await t.clock.advance(3000);
    const recent = t.world.grabTimes.filter((at) => at >= 4500);
    expect(recent.length).toBeGreaterThanOrEqual(7);
    expect(gaps(recent).every((g) => g === 200)).toBe(true);
    expect(t.scanner.getState().stats).toMatchObject({ pollCostMs: 1, pollEveryMs: 200 });
  });

  it('is not slowed down by one slow poll', async () => {
    const t = setup();
    // a GC pause or a content-rect re-measure in the 6th poll
    t.world.grabCost = (i) => (i === 5 ? 60 : 1);
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(3000);
    expect(gaps(t.world.grabTimes).every((g) => g === 200)).toBe(true);
  });

  it('never waits longer than 800 ms between polls, however slow they are', async () => {
    const t = setup();
    t.world.grabCost = 100;
    t.world.show([GB_DIALOG, 'wild']);
    t.scanner.start();
    await t.clock.advance(6000);
    const g = gaps(t.world.grabTimes);
    expect(Math.max(...g)).toBe(800);
    // (after the three polls that tell what a still poll costs)
    expect(g.slice(3).every((x) => x === 800)).toBe(true);
    expect(t.scanner.getState().stats.pollEveryMs).toBe(800);
    expect(t.captures()).toHaveLength(1);
  });

  it('does not count polls without a frame as expensive ones', async () => {
    const t = setup();
    t.world.grabCost = 16;
    t.world.available = false;
    t.scanner.start();
    await t.clock.advance(2000);
    // no frame: the quiet 400 ms cadence, nothing charged
    expect(t.world.grabs).toBe(6);
    expect(t.scanner.getState().stats.pollCostMs).toBe(0);
    t.world.available = true;
    t.world.show([GB_DIALOG, 'wild']);
    await t.clock.advance(2000);
    expect(t.scanner.getState().stats.pollCostMs).toBe(16);
    expect(t.captures()).toHaveLength(1);
  });
});

describe('scanner: text outside the boxes', () => {
  it('reads the rest of the screen again only when pixels outside the boxes change', async () => {
    const t = setup({}, { readAllText: true });
    const W = 160, H = 144;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const paint = (x, y, v) => data.set([v, v, v, 255], (y * W + x) * 4);
    const grab = t.world.frameSource.grab;
    t.world.frameSource.grab = () => {
      const f = grab();
      if (f) f.img = { data: data.slice(), width: W, height: H };
      return f;
    };
    const outsideReads = () => t.engine.calls.filter((c) => c.mode === 'free').length;
    t.world.show([GB_MENU, 'start-menu']);
    t.scanner.start();
    await t.clock.advance(5000);
    expect(outsideReads()).toBe(1);
    // inside the menu box: the box tracker's business, not a new scene
    paint(100, 60, 0);
    await t.clock.advance(5000);
    expect(outsideReads()).toBe(1);
    // a 4-bit step outside the box is a new scene; less is filtering noise
    paint(20, 20, 247);
    await t.clock.advance(5000);
    expect(outsideReads()).toBe(1);
    paint(20, 20, 200);
    await t.clock.advance(5000);
    expect(outsideReads()).toBe(2);
  });

  // A 160×144 frame drawn for the poll's time: tiles that never repeat
  // (scrolled `scroll(now)` px), a pond whose two phases swap every 16
  // frames (the test ROM's), optionally flowers cycling three colours and an
  // NPC stepping back and forth, all outside GB_MENU (x 83-156); `extra`
  // draws more. A whole-screen read takes `freeMs` (a phone: 1-3 s).
  // Returns the engine's reads: [start time, mode].
  function animatedScreen(t, { pond = true, busy = false, scroll = () => 0, extra = null, freeMs = 0 } = {}) {
    const W = 160, H = 144;
    const grab = t.world.frameSource.grab;
    t.world.frameSource.grab = () => {
      const f = grab();
      if (!f) return f;
      const now = t.clock.now();
      const data = new Uint8ClampedArray(W * H * 4);
      const fill = (x0, y0, w, h, v) => {
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([v, v, v, 255], (y * W + x) * 4);
      };
      const off = scroll(now);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) fill(x, y, 1, 1, Math.imul(((x + off) >> 3) * 73856093 ^ (y >> 3) * 19349663, 0x9e3779b1) >>> 31 ? 96 : 208);
      }
      if (pond) fill(8, 72, 40, 32, Math.floor(now / (16000 / 60)) % 2 ? 64 : 160);
      if (busy) {
        fill(56, 24, 8, 8, [32, 128, 240][Math.floor(now / 400) % 3]);
        fill(Math.floor(now / 1500) % 2 ? 40 : 16, 112, 16, 16, 0);
      }
      if (extra) extra(fill, now);
      f.img = { data, width: W, height: H };
      return f;
    };
    const reads = [];
    const read = t.engine.read;
    t.engine.read = (job) => {
      reads.push([t.clock.now(), job.mode]);
      if (job.mode !== 'free' || !freeMs) return read(job);
      return new Promise((resolve) => t.clock.setTimeout(() => resolve({ lines: [], ms: freeMs, engine: 'neural' }), freeMs));
    };
    return reads;
  }

  it('takes an animated background for animation, not for text that settled, at phone cadences', async () => {
    // a phone under the main-thread budget polls 380-800 ms apart: a raw
    // hash sees the pond at the same phase twice in a row now and then, and
    // read the screen again for each phase (two reads, at 400-800 ms)
    for (const busy of [false, true]) {
      for (const every of [380, 440, 533, 600, 700, 800]) {
        const t = setup({}, { readAllText: true });
        t.world.grabCost = every / 20;
        const reads = animatedScreen(t, { busy });
        t.world.show([GB_MENU, 'start-menu']);
        t.scanner.start();
        await t.clock.advance(60000);
        // the still part of the scene is read once (at 533 ms the polls only
        // ever see one phase of the pond: still too), and the animation never
        // has it read again
        expect(reads.filter(([, mode]) => mode === 'free').length, `${every} ms${busy ? ', flowers and an NPC' : ''}`).toBe(1);
      }
    }
  });

  it('still reads new text outside the boxes while the background animates', async () => {
    for (const every of [200, 440, 800]) {
      const t = setup({}, { readAllText: true });
      t.world.grabCost = every / 20;
      const reads = animatedScreen(t, { busy: true, extra: (fill, now) => { if (now >= 20000) fill(16, 8, 48, 8, 0); } });
      t.world.show([GB_MENU, 'start-menu']);
      t.scanner.start();
      await t.clock.advance(40000);
      const free = reads.filter(([, mode]) => mode === 'free').map(([at]) => at);
      expect(free, `${every} ms`).toHaveLength(2);
      // read once the sign has stayed put for 2.5 polls and the rest of the
      // screen has been still for 700 ms: at most a poll to see it, the hold
      // and the 700 ms each rounded up to a poll (1.4 s at 200 ms polls)
      expect(free[1] - 20000, `${every} ms`).toBeGreaterThan(2.5 * every + 700);
      expect(free[1] - 20000, `${every} ms`).toBeLessThanOrEqual(5 * every + 700);
    }
  });

  it('does not take a new scene for animation (walking scrolls the map)', async () => {
    for (const every of [200, 440, 800]) {
      const t = setup({}, { readAllText: true });
      t.world.grabCost = every / 20;
      // scrolled 1 px a frame from 10 to 14 s
      const reads = animatedScreen(t, { scroll: (now) => Math.floor((Math.min(Math.max(now, 10000), 14000) - 10000) / (1000 / 60)) });
      t.world.show([GB_MENU, 'start-menu']);
      t.scanner.start();
      await t.clock.advance(30000);
      const free = reads.filter(([, mode]) => mode === 'free').map(([at]) => at);
      // the first scene, and the new one once it has stopped scrolling (held
      // 2.5 polls, then still for 700 ms); never the scrolling itself
      expect(free, `${every} ms`).toHaveLength(2);
      expect(free[0]).toBeLessThan(10000);
      expect(free[1] - 14000, `${every} ms`).toBeGreaterThan(2.5 * every + 700);
      expect(free[1] - 14000, `${every} ms`).toBeLessThanOrEqual(5 * every + 700);
    }
  });

  it('does not read a sign again once the pixels held under it settle to what was read (an NPC stood there)', async () => {
    for (const [every, count] of [[200, 3], [800, 2]]) {
      const t = setup({}, { readAllText: true });
      t.world.grabCost = every / 20;
      // an NPC stands at a spot from 7 to 9 s; a sign is drawn over it at 10 s
      const reads = animatedScreen(t, {
        pond: false,
        extra: (fill, now) => {
          if (now >= 7000 && now < 9000) fill(16, 8, 16, 16, 0);
          if (now >= 10000) fill(16, 8, 48, 8, 30);
        }
      });
      t.world.show([GB_MENU, 'start-menu']);
      t.scanner.start();
      await t.clock.advance(20000);
      // the scene, the NPC (at 200 ms: seen standing), the sign: once each
      const free = reads.filter(([, mode]) => mode === 'free').map(([at]) => at);
      expect(free, `${every} ms`).toHaveLength(count);
      expect(free.at(-1), `${every} ms`).toBeGreaterThan(10000);
    }
  });

  it('reads every page the moment it settles, with no whole-screen read in the way, at phone cadences', async () => {
    for (const every of [200, 500, 800]) {
      const t = setup({}, { readAllText: true });
      t.world.grabCost = every / 20;
      // the player reads each page for 4 s; the rest of the screen is still,
      // with something new on it for every page (an NPC walked up), and a
      // whole-screen read takes 3 s: started while the player reads, it would
      // still be running when the next page settles
      const reads = animatedScreen(t, { pond: false, freeMs: 3000, extra: (fill, now) => fill(16 + 16 * Math.floor(now / 4000), 16, 8, 8, 0) });
      t.scanner.start();
      const pages = ['p1', 'p2', 'p3', 'wild'];
      pages.forEach((p, i) => t.clock.at(i * 4000, () => t.world.show([GB_DIALOG, p])));
      await t.clock.advance(pages.length * 4000);
      expect(reads.map(([, mode]) => mode), `${every} ms`).toEqual(['container', 'container', 'container', 'container']);
      // each read starts on the first poll after the page has been still for
      // 400 ms since the scanner first saw it
      reads.forEach(([at], i) => {
        const seen = t.world.grabTimes.find((g) => g >= i * 4000);
        expect(at - seen, `${every} ms, page ${i + 1}`).toBeLessThanOrEqual(400 + every);
      });
    }
  });
});
