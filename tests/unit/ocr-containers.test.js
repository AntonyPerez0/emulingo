import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findContainers, createContainerTracker } from '../../src/core/ocr/containers.js';
import { fnv1a } from '../../src/core/ocr/capture.js';
import { decodePng } from '../fixtures/frames/png.mjs';

// Fixtures: native frames of the 42 bench scenes + where their text is
// (tests/fixtures/frames/generate.mjs renders them in Chromium).
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'frames');
const IDS = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const cache = new Map();
function scene(id) {
  if (!cache.has(id)) {
    cache.set(id, {
      img: decodePng(fs.readFileSync(path.join(DIR, id + '.png'))),
      truth: JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8'))
    });
  }
  const s = cache.get(id);
  return { img: clone(s.img), truth: s.truth };
}

const clone = (img) => ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
function fill(img, x, y, w, h, rgb) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) img.data.set(rgb, (j * img.width + i) * 4);
}
function copy(img, sx, sy, w, h, dx, dy) {
  const src = clone(img);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) img.data.set(src.data.subarray(((sy + j) * img.width + sx + i) * 4, ((sy + j) * img.width + sx + i) * 4 + 4), ((dy + j) * img.width + dx + i) * 4);
}
const inside = (t, b) => t.x >= b.x && t.y >= b.y && t.x + t.w <= b.x + b.w && t.y + t.h <= b.y + b.h;
const overlaps = (t, b) => t.x < b.x + b.w && b.x < t.x + t.w && t.y < b.y + b.h && b.y < t.y + t.h;
const frame = (img, t) => ({ img, w: img.width, h: img.height, t });

// Runs a frame sequence through a tracker at 200 ms polls; returns the
// container of `kind` per frame.
function run(frames, kind, tracker = createContainerTracker()) {
  return frames.map((img, i) => tracker.update(frame(img, i * 200)).find((c) => c.kind === kind));
}

// interior pixels of a crop equal to the frame's (nothing masked)
function cropMatches(c, img) {
  const { img: crop, offset } = c.crop();
  for (let y = c.y; y < c.y + c.h; y++) {
    for (let x = c.x; x < c.x + c.w; x++) {
      const a = px(crop, x - offset.x, y - offset.y), b = px(img, x, y);
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- detection

describe('findContainers on the 42 bench scenes', () => {
  const ALLOWED = { dialog: ['dialog', 'battle'], menu: ['menu'], sign: ['box', 'dialog'], boxed: ['box'] };

  it.each(IDS)('%s: text sits in a container of the right kind', (id) => {
    const { img, truth } = scene(id);
    const boxes = findContainers(img);
    for (const t of truth.text) {
      if (t.role === 'hud') continue;
      const box = boxes.find((b) => inside(t, b));
      expect(box, `${t.role} text at ${t.x},${t.y} ${t.w}x${t.h}`).toBeTruthy();
      expect(ALLOWED[t.role], `${t.role} text at ${t.x},${t.y} is in a ${box.kind}`).toContain(box.kind);
      expect(box.fg).not.toBeNull();
    }
    // unboxed Gen 1 battle HUD labels never fall inside a framed container
    for (const t of truth.text.filter((x) => x.role === 'hud')) {
      expect(boxes.some((b) => overlaps(t, b)), `HUD text at ${t.x},${t.y}`).toBe(false);
    }
  });

  it('finds no framed container on overworld maps without text', () => {
    for (const id of ['gb1-overworld-notext', 'gb2-overworld-notext', 'gba-overworld-notext']) {
      expect(findContainers(scene(id).img), id).toEqual([]);
    }
  });

  it('reports empty boxes (no ink) with fg = null', () => {
    const gb = findContainers(scene('gb1-battle-intro-notext').img);
    expect(gb).toHaveLength(1);
    expect(gb[0]).toMatchObject({ kind: 'dialog', fg: null });
    const gba = findContainers(scene('gba-battle-intro-notext').img);
    expect(gba.map((b) => b.kind)).toEqual(['battle']);
    expect(gba[0].fg).toBeNull();
  });

  it('classifies the Pokémon boxes', () => {
    const kinds = (id) => findContainers(scene(id).img).map((b) => b.kind);
    expect(kinds('gb1-oak-hello-en')).toEqual(['dialog']);
    expect(kinds('gb2-shorts-de')).toEqual(['dialog']);
    expect(kinds('gba-oak-hello-de')).toEqual(['dialog']);
    expect(kinds('gb1-yesno-save-en')).toEqual(['menu', 'dialog']);
    expect(kinds('gb1-mart-money-en')).toEqual(['box', 'dialog']);
    expect(kinds('gb2-mart-de')).toEqual(['box', 'menu', 'dialog']);
    expect(kinds('gb1-start-menu-de')).toEqual(['menu']);
    expect(kinds('gba-start-menu-en')).toEqual(['menu']);
    expect(kinds('gba-battle-appeared-en')).toContain('battle');
    expect(kinds('gba-battle-menu-en')).toEqual(expect.arrayContaining(['battle', 'menu']));
    expect(kinds('gba-route-sign-en')).toEqual(['box']);
  });

  it('gives exact interiors for the GB and GBA dialog boxes', () => {
    expect(findContainers(scene('gb1-oak-hello-en').img)[0]).toMatchObject({ x: 5, y: 101, w: 150, h: 38, bg: [255, 255, 255], fg: [0, 0, 0] });
    expect(findContainers(scene('gba-oak-hello-en').img)[0]).toMatchObject({ x: 5, y: 116, w: 230, h: 39, bg: [255, 255, 255] });
  });

  it('finds a box whose frame is one blended pixel away (smoothed phone picture)', () => {
    // bilinear scaling leaves a light blend between the white interior and
    // the frame line, too close to white to be the frame itself
    const { img } = scene('gba-oak-hello-en');
    const blend = [0xed, 0xf2, 0xfa];
    fill(img, 5, 116, 1, 39, blend);
    fill(img, 234, 116, 1, 39, blend);
    fill(img, 5, 116, 230, 1, blend);
    fill(img, 5, 154, 230, 1, blend);
    const boxes = findContainers(img);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ kind: 'dialog', x: 6, y: 117, w: 228, h: 37 });
  });

  it('accepts patterned frames (Gen 2/3 frame options)', () => {
    // repaint the GBA dialog's two inner frame rings with a 2+2 px pattern
    const { img } = scene('gba-oak-hello-en');
    const A = [0xc0, 0x30, 0x30], B = [0x30, 0x50, 0xc0];
    const paint = (x, y, i) => img.data.set(i % 4 < 2 ? A : B, (y * img.width + x) * 4);
    for (const inset of [1, 2]) {
      const x0 = 2 + inset, y0 = 113 + inset, x1 = 2 + 236 - 1 - inset, y1 = 113 + 45 - 1 - inset;
      for (let x = x0; x <= x1; x++) { paint(x, y0, x); paint(x, y1, x); }
      for (let y = y0; y <= y1; y++) { paint(x0, y, y); paint(x1, y, y); }
    }
    const boxes = findContainers(img);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ kind: 'dialog', x: 5, y: 116, w: 230, h: 39 });
  });

  it('is robust to other palettes of the same scene', () => {
    // swap the DMG greys for a sepia ramp: geometry must not change
    const { img } = scene('gb1-start-menu-en');
    const ramp = { 255: [248, 232, 200], 168: [200, 160, 112], 85: [120, 80, 48], 0: [40, 24, 16] };
    for (let i = 0; i < img.data.length; i += 4) {
      const v = ramp[img.data[i]];
      if (v) img.data.set(v, i);
    }
    const boxes = findContainers(img);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ kind: 'menu', x: 85, y: 5, w: 70, h: 118, bg: [248, 232, 200] });
  });
});

// ---------------------------------------------------------------- tracking

describe('createContainerTracker', () => {
  it('returns one free container covering the frame when there is no box', () => {
    const { img } = scene('gb1-overworld-notext');
    const tr = createContainerTracker();
    const out = [0, 200, 400].map((t) => tr.update(frame(img, t)));
    for (const cs of out) expect(cs).toHaveLength(1);
    const c = out[2][0];
    expect(c).toMatchObject({ kind: 'free', key: 'free', x: 0, y: 0, w: 160, h: 144, fg: null });
    expect(c.hash).toBe(fnv1a(img));
    expect(out.map((cs) => cs[0].settledMs)).toEqual([0, 200, 400]);
    const { img: crop, offset } = c.crop();
    expect([crop.width, crop.height, offset.x, offset.y]).toEqual([160, 144, 0, 0]);
  });

  it('keeps keys stable and measures settle time from frame.t', () => {
    const { img } = scene('gb1-yesno-save-en');
    const tr = createContainerTracker();
    const a = tr.update(frame(img, 1000));
    const b = tr.update(frame(clone(img), 1350));
    expect(b.map((c) => c.key)).toEqual(a.map((c) => c.key));
    expect(b.map((c) => c.settledMs)).toEqual([350, 350]);
    expect(new Set(a.map((c) => c.key)).size).toBe(2);
  });

  it('hashes exactly the masked interior returned by crop()', () => {
    const { img } = scene('gb2-mart-de');
    for (const c of createContainerTracker().update(frame(img, 0))) {
      const { img: crop, offset } = c.crop();
      expect(c.hash, c.key).toBe(fnv1a(crop, { x: c.x - offset.x, y: c.y - offset.y, w: c.w, h: c.h }));
    }
  });

  it('crops the interior plus a 4 px margin, blanking the frame lines', () => {
    const { img } = scene('gb1-oak-hello-en');
    const [c] = createContainerTracker().update(frame(img, 0));
    const { img: crop, offset } = c.crop();
    expect(offset).toEqual({ x: 1, y: 97 });
    expect([crop.width, crop.height]).toEqual([158, 46]);
    // the margin (where the double rule is) is plain background
    for (let x = 0; x < crop.width; x++) for (const y of [0, 1, 2, 3, crop.height - 1]) expect(px(crop, x, y)).toEqual(c.bg);
    // the text is untouched (no decoration has moved yet)
    expect(cropMatches(c, img)).toBe(true);
    // crop() is cached
    expect(c.crop()).toBe(c.crop());
  });

  it('finds exactly one ▶ per menu scene, on the cursor glyph', () => {
    for (const id of IDS) {
      const { img } = scene(id);
      for (const b of findContainers(img)) {
        if (b.kind !== 'menu') { expect(b.cursors ?? [], id).toEqual([]); continue; }
        expect(b.cursors, id).toHaveLength(1);
        // a cursor rect is narrow and one text row tall
        expect(b.cursors[0].w, id).toBeLessThanOrEqual(8);
        expect(b.cursors[0].h, id).toBeLessThanOrEqual(12);
      }
    }
  });

  it('masks a static ▶ cursor in menus', () => {
    const { img, truth } = scene('gb1-yesno-save-en');
    const menu = createContainerTracker().update(frame(img, 0)).find((c) => c.kind === 'menu');
    const cursor = truth.text.find((t) => t.role === 'menu' && t.w <= 6); // the ▶ glyph
    const { img: crop, offset } = menu.crop();
    for (let y = cursor.y; y < cursor.y + cursor.h; y++) {
      for (let x = cursor.x; x < cursor.x + cursor.w; x++) expect(px(crop, x - offset.x, y - offset.y)).toEqual(menu.bg);
    }
    // the item text next to it is kept
    const yes = truth.text.find((t) => t.role === 'menu' && t.x > cursor.x && t.y === cursor.y);
    let ink = 0;
    for (let y = yes.y; y < yes.y + yes.h; y++) for (let x = yes.x; x < yes.x + yes.w; x++) if (px(crop, x - offset.x, y - offset.y)[0] !== menu.bg[0]) ink++;
    expect(ink).toBeGreaterThan(10);
  });

  describe('cells() (extension: text lines/cells of framed boxes)', () => {
    const cellsOf = (id, kind) => createContainerTracker().update(frame(scene(id).img, 0)).find((c) => c.kind === kind).cells();

    it('gives one cell per dialog line', () => {
      const cells = cellsOf('gb1-nino-es', 'dialog');
      expect(cells.map((c) => [c.row, c.col])).toEqual([[0, 0], [1, 0]]);
      const { truth } = scene('gb1-nino-es');
      for (const t of truth.text) expect(cells.some((c) => inside(t, c)), `${t.x},${t.y}`).toBe(true);
      for (const c of cells) expect(c.h).toBeLessThanOrEqual(10);
      const gba = cellsOf('gba-oak-hello-de', 'dialog');
      expect(gba).toHaveLength(2);
    });

    it('splits menu columns and leaves the cursor out', () => {
      const start = cellsOf('gb1-start-menu-en', 'menu');
      expect(start).toHaveLength(7);
      expect(Math.min(...start.map((c) => c.x))).toBeGreaterThanOrEqual(96); // ▶ at x 88 is masked
      const battle = cellsOf('gba-battle-menu-en', 'menu');
      expect(battle.map((c) => [c.row, c.col])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    });

    it('crops each cell with background padding', () => {
      const [cell] = cellsOf('gb1-mart-money-en', 'box');
      const { img, offset } = cell.crop();
      expect(offset).toEqual({ x: cell.x - 4, y: cell.y - 3 });
      expect([img.width, img.height]).toEqual([cell.w + 8, cell.h + 6]);
      for (let x = 0; x < img.width; x++) expect(px(img, x, 0)).toEqual(px(img, 0, 0));
      expect(cell.crop()).toBe(cell.crop());
    });

    it('is not offered for free and zone containers', () => {
      const [free] = createContainerTracker().update(frame(scene('gb1-overworld-notext').img, 0));
      expect(free.cells).toBeUndefined();
    });
  });

  describe('blinking ▼ arrow (GB, bottom-right cell)', () => {
    const { img: on } = scene('gb1-oak-hello-en');
    const off = clone(on);
    fill(off, 144, 128, 8, 8, [255, 255, 255]);
    const offHash = createContainerTracker().update(frame(off, 0))[0].hash;
    // ~533 ms per phase at 200 ms polls
    const seq = [on, on, on, off, off, off, on, on, on, off, off, on, on, on, off, off, off, on, on];

    it('settles: the hash stops changing after the first blink', () => {
      const cs = run(seq, 'dialog');
      const hashes = cs.map((c) => c.hash);
      expect(new Set(hashes.slice(3)).size).toBe(1);
      expect(hashes[3]).toBe(offHash);
      // settled time grows from the first blink on
      expect(cs.at(-1).settledMs).toBe((seq.length - 1 - 3) * 200);
    });

    it('paints the arrow with the background in crops', () => {
      const cs = run(seq, 'dialog');
      const c = cs.at(-1); // arrow is on in the last frame
      const { img: crop, offset } = c.crop();
      for (let y = 128; y < 136; y++) for (let x = 144; x < 152; x++) expect(px(crop, x - offset.x, y - offset.y)).toEqual([255, 255, 255]);
      // everything else is the real frame
      const ref = run([off], 'dialog')[0];
      expect(c.hash).toBe(ref.hash);
      // and the second line's cell stops before the arrow
      expect(Math.max(...c.cells().map((k) => k.x + k.w))).toBeLessThanOrEqual(144);
    });

    it('does not mask an arrow-cell glyph that appears and stays (typewriter)', () => {
      const frames = [off, off, off, ...Array(10).fill(on)];
      const cs = run(frames, 'dialog');
      // masked right after it appears (could be a blink) ...
      expect(cs[3].hash).toBe(offHash);
      // ... and part of the content once it has been stable for a second
      const last = cs.at(-1);
      expect(last.hash).not.toBe(offHash);
      expect(cropMatches(last, on)).toBe(true);
      expect(last.settledMs).toBeGreaterThan(0);
      expect(last.settledMs).toBeLessThan(frames.length * 200 - 3 * 200);
    });

    // A phone under the scanner's main-thread budget polls up to 800 ms
    // apart: the holds last 2.5 polls, so a blink that two polls in a row
    // miss stays masked (1000 / 1500 ms holds would show it).
    const at = (frames, times, tracker = createContainerTracker()) =>
      frames.map((img, i) => tracker.update(frame(img, times[i])).find((c) => c.kind === 'dialog'));
    const every = (ms, n) => Array.from({ length: n }, (_, i) => i * ms);

    it('keeps the arrow masked at 800 ms polls when two polls in a row miss a blink', () => {
      const seq = [on, off, off, off, on, on, on, off, off, off, on, on, on, off];
      const cs = at(seq, every(800, seq.length));
      expect(new Set(cs.slice(1).map((c) => c.hash)).size).toBe(1);
      expect(cs[1].hash).toBe(offHash);
      // still since the first blink
      expect(cs.at(-1).settledMs).toBe((seq.length - 2) * 800);
    });

    it('shows an arrow-cell glyph that stays after 2.5 polls at 800 ms', () => {
      const seq = [off, off, ...Array(8).fill(on)];
      const cs = at(seq, every(800, seq.length));
      // it appears at 1600 ms: masked up to 2000 ms after, shown from 2400
      expect(cs.findIndex((c) => c.hash !== offHash)).toBe(5);
      expect(cropMatches(cs.at(-1), on)).toBe(true);
    });

    it('takes the holds from the polls, not from a pause between them', () => {
      // 200 ms polls, the game paused for 10 s, 200 ms polls again: the glyph
      // that appears after the pause is shown after the usual 1 s
      const seq = [off, off, off, off, ...Array(8).fill(on)];
      const times = [0, 200, 400, 600, ...every(200, 8).map((t) => 10600 + t)];
      const cs = at(seq, times);
      expect(cs.findIndex((c) => c.hash !== offHash)).toBe(4 + 6);
    });
  });

  describe('blinking arrow at the end of the text (GBA)', () => {
    const { img: on } = scene('gba-oak-hello-en');
    const off = clone(on);
    let red = 0;
    for (let i = 0; i < off.data.length; i += 4) {
      if (off.data[i] === 0xe0 && off.data[i + 1] === 0x38 && off.data[i + 2] === 0x28) { off.data.set([255, 255, 255], i); red++; }
    }

    it('is learned from its first blink and then left out of the hash', () => {
      expect(red).toBeGreaterThan(8);
      const seq = [on, on, off, off, on, on, on, off, off, on, on, off, on];
      const cs = run(seq, 'dialog');
      expect(new Set(cs.slice(2).map((c) => c.hash)).size).toBe(1);
      expect(cs[2].hash).toBe(run([off], 'dialog')[0].hash);
    });
  });

  describe('typewriter growth', () => {
    const { img: full } = scene('gb1-nino-es'); // no arrow
    const LINES = ['El niño de al lado', 'también entrena.'];
    const typed = (n) => {
      const img = clone(full);
      LINES.forEach((line, row) => {
        const shown = Math.max(0, Math.min(line.length, n - (row ? LINES[0].length : 0)));
        fill(img, 8 + shown * 8, 112 + row * 16, (18 - shown) * 8, 8, [255, 255, 255]);
      });
      return img;
    };
    const total = LINES[0].length + LINES[1].length;
    const steps = [];
    for (let n = 0; n <= total; n += 3) steps.push(typed(n));
    steps.push(typed(total));
    const seq = [...steps, ...Array(5).fill(full)];

    it('changes the hash while text is printed and keeps every glyph', () => {
      const cs = run(seq, 'dialog');
      for (let i = 1; i < steps.length; i++) {
        const grew = fnv1a(steps[i], { x: 5, y: 101, w: 150, h: 38 }) !== fnv1a(steps[i - 1], { x: 5, y: 101, w: 150, h: 38 });
        expect(cs[i].hash !== cs[i - 1].hash, `step ${i}`).toBe(grew);
        expect(cs[i].settledMs === 0, `step ${i}`).toBe(grew);
        expect(cropMatches(cs[i], steps[i]), `step ${i}`).toBe(true);
      }
      const last = cs.at(-1);
      expect(cropMatches(last, full)).toBe(true);
      expect(last.hash).toBe(fnv1a(full, { x: 5, y: 101, w: 150, h: 38 }));
      // settled since the last glyph appeared
      const lastGrowth = cs.findLastIndex((c) => c.settledMs === 0);
      expect(last.settledMs).toBe((cs.length - 1 - lastGrowth) * 200);
      expect(last.settledMs).toBeGreaterThanOrEqual(1000);
    });

    it('does not mask the next page’s glyphs after a short page is cleared', () => {
      // "El" (too little ink for a big change) is cleared, a poll sees the
      // empty box, then "El niño" is typed over it: the returning "El"
      // pixels are a new page, not a blink
      const seq = [typed(2), typed(2), typed(2), typed(0), typed(2), typed(4), typed(7), typed(7), typed(7), typed(7)];
      const cs = run(seq, 'dialog');
      for (let i = 4; i < seq.length; i++) {
        expect(cs[i].hash, `poll ${i}`).toBe(fnv1a(seq[i], { x: 5, y: 101, w: 150, h: 38 }));
        expect(cropMatches(cs[i], seq[i]), `poll ${i}`).toBe(true);
      }
      expect(cs.at(-1).settledMs).toBe(3 * 200);
    });

    it('does not mask a new page typed where the old text was', () => {
      // page 1 typed, cleared at once, page 2 typed over the same cells
      const { img: other } = scene('gb1-oak-hello-en');
      fill(other, 144, 128, 8, 8, [255, 255, 255]);
      const blank = typed(0);
      const cs = run([...steps, full, full, blank, other, other, other, other, other, other], 'dialog');
      expect(cropMatches(cs.at(-1), other)).toBe(true);
      expect(cs.at(-1).hash).toBe(fnv1a(other, { x: 5, y: 101, w: 150, h: 38 }));
    });
  });

  describe('moving ▶ cursor', () => {
    it('keeps the GBA battle menu hash constant as the cursor moves', () => {
      const { img: a } = scene('gba-battle-menu-en');
      const b = clone(a);
      // move the cursor (glyph + shadow) from FIGHT to BAG
      copy(b, 127, 121, 7, 11, 183, 121);
      fill(b, 127, 121, 7, 11, [0xf8, 0xf8, 0xf8]);
      const cs = run([a, a, b, b, b, a, a, b, a], 'menu');
      expect(new Set(cs.map((c) => c.key)).size).toBe(1);
      expect(new Set(cs.map((c) => c.hash)).size).toBe(1);
      // and the cursor is not in the crop at either position
      for (const c of [cs[3], cs[6]]) {
        const { img: crop, offset } = c.crop();
        for (const x0 of [127, 183]) for (let y = 121; y < 132; y++) for (let x = x0; x < x0 + 7; x++) expect(px(crop, x - offset.x, y - offset.y)).toEqual([0xf8, 0xf8, 0xf8]);
      }
    });

    it('learns a cursor of any shape from its first move', () => {
      // a block cursor (no triangle): blanked by position only when it is
      // left of every item, so the move to the second column must be learned
      const { img } = scene('gba-battle-menu-en');
      const a = clone(img);
      fill(a, 127, 121, 7, 11, [0xf8, 0xf8, 0xf8]);
      const b = clone(a);
      fill(a, 127, 122, 4, 7, [0x48, 0x48, 0x48]);
      fill(b, 183, 122, 4, 7, [0x48, 0x48, 0x48]);
      const cs = run([a, a, b, b, a, b], 'menu');
      expect(new Set(cs.map((c) => c.hash)).size).toBe(1);
      const { img: crop, offset } = cs.at(-1).crop();
      for (let y = 122; y < 129; y++) for (let x = 183; x < 187; x++) expect(px(crop, x - offset.x, y - offset.y)).toEqual([0xf8, 0xf8, 0xf8]);
    });

    it('stops hiding a cursor’s old place once something else is drawn there', () => {
      // the block cursor moves from BAG back to FIGHT, then a glyph-like
      // mark is printed where it was (a change that is not a move)
      const { img } = scene('gba-battle-menu-en');
      const a = clone(img);
      fill(a, 127, 121, 7, 11, [0xf8, 0xf8, 0xf8]);
      const b = clone(a);
      fill(a, 183, 122, 4, 7, [0x48, 0x48, 0x48]);
      fill(b, 127, 122, 4, 7, [0x48, 0x48, 0x48]);
      const c = clone(b);
      fill(c, 184, 123, 2, 6, [0x48, 0x48, 0x48]);
      const cs = run([a, a, b, b, ...Array(12).fill(c)], 'menu');
      const mark = (k) => {
        const { img: crop, offset } = cs[k].crop();
        return px(crop, 184 - offset.x, 125 - offset.y);
      };
      // masked at first (it could be the cursor blinking back) ...
      expect(mark(4)).toEqual([0xf8, 0xf8, 0xf8]);
      // ... and shown once it has stayed put
      expect(mark(cs.length - 1)).toEqual([0x48, 0x48, 0x48]);
      expect(cs.at(-1).settledMs).toBeGreaterThan(0);
      // the cursor at its new place is still hidden
      const { img: crop, offset } = cs.at(-1).crop();
      for (let y = 122; y < 129; y++) for (let x = 127; x < 131; x++) expect(px(crop, x - offset.x, y - offset.y)).toEqual([0xf8, 0xf8, 0xf8]);
    });

    it('keeps the GB START menu hash constant as the cursor moves', () => {
      const { img: a } = scene('gb1-start-menu-en');
      const b = clone(a);
      copy(b, 88, 16, 8, 8, 88, 32);
      fill(b, 88, 16, 8, 8, [255, 255, 255]);
      const cs = run([a, b, b, a, b], 'menu');
      expect(new Set(cs.map((c) => c.hash)).size).toBe(1);
    });
  });

  it('masks a toggling patch in free mode (animated water)', () => {
    const { img: a } = scene('gb1-overworld-notext');
    const b = clone(a);
    fill(b, 40, 40, 8, 8, [85, 85, 85]);
    const cs = run([a, b, a, b, a, b, a], 'free');
    expect(new Set(cs.slice(2).map((c) => c.hash)).size).toBe(1);
    expect(cs.at(-1).settledMs).toBe(4 * 200);
  });

  it('a manual zone replaces detection with exactly one zone container', () => {
    const { img } = scene('gb1-oak-hello-en');
    const tr = createContainerTracker({ zone: { x: 0, y: 96 / 144, w: 1, h: 48 / 144 } });
    let cs = tr.update(frame(img, 0));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: 'zone', x: 0, y: 96, w: 160, h: 48, bg: [255, 255, 255], fg: [0, 0, 0] });
    const { img: crop, offset } = cs[0].crop();
    expect(offset).toEqual({ x: 0, y: 92 });
    expect([crop.width, crop.height]).toEqual([160, 52]);
    expect(cropMatches(cs[0], img)).toBe(true);
    tr.setZone({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 });
    cs = tr.update(frame(img, 200));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: 'zone', x: 80, y: 72, w: 40, h: 36, settledMs: 0 });
    tr.setZone(null);
    expect(tr.update(frame(img, 400)).map((c) => c.kind)).toEqual(['dialog']);
  });

  it('reuses the boxes of frames it has seen, and only of exactly those frames', () => {
    const ids = ['gb1-oak-hello-en', 'gb1-yesno-save-en', 'gb1-overworld-notext', 'gb2-mart-de', 'gba-battle-menu-en', 'gba-oak-hello-en'];
    const imgs = ids.map((id) => scene(id).img);
    // one pixel of the GB dialog's frame line and one of its text changed
    const edge = clone(imgs[0]);
    fill(edge, 40, 98, 1, 1, [255, 255, 255]);
    const ink = clone(imgs[0]);
    fill(ink, 60, 114, 2, 2, [255, 255, 255]);
    const all = [...imgs, edge, ink];
    const shape = (cs) => cs.filter((c) => c.kind !== 'free').map((c) => [c.kind, c.x, c.y, c.w, c.h, String(c.fg)]);
    const tr = createContainerTracker();
    // more distinct frames than are kept, revisited in a scrambled order
    const order = [0, 6, 0, 7, 0, 1, 2, 3, 4, 5, 6, 7, 0, 7, 6, 3, 3, 1, 5, 0, 2, 4, 7];
    order.forEach((k, i) => {
      const img = all[k];
      expect(shape(tr.update(frame(img, i * 200))), `frame ${i} (${k})`).toEqual(shape(findContainers(img)));
    });
    // a frame changed in place after it was seen is detected again
    const live = clone(imgs[0]);
    expect(tr.update(frame(live, 9000)).map((c) => c.kind)).toEqual(['dialog']);
    live.data.set(imgs[2].data);
    expect(tr.update(frame(live, 9200)).map((c) => c.kind)).toEqual(['free']);
  });

  it('never reports a negative settle time when the clock steps back', () => {
    const { img } = scene('gb1-oak-hello-en');
    const tr = createContainerTracker();
    tr.update(frame(img, 5000));
    expect(tr.update(frame(clone(img), 4000))[0].settledMs).toBe(0);
  });

  it('handles flat and tiny frames, and trackers of different sizes side by side', () => {
    const flat = { data: new Uint8ClampedArray(160 * 144 * 4).fill(255), width: 160, height: 144 };
    const [c] = createContainerTracker().update(frame(flat, 0));
    expect(c).toMatchObject({ kind: 'free', fg: null, bg: [255, 255, 255] });
    expect(createContainerTracker().update(frame({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, 0))).toHaveLength(1);
    // detection shares scratch buffers between trackers
    const gb = createContainerTracker(), gba = createContainerTracker();
    const a = scene('gb1-yesno-save-en').img, b = scene('gba-battle-menu-en').img;
    for (let i = 0; i < 3; i++) {
      expect(gb.update(frame(a, i * 200)).map((k) => k.kind)).toEqual(['menu', 'dialog']);
      expect(gba.update(frame(b, i * 200)).map((k) => k.kind)).toEqual(['box', 'box', 'battle', 'menu']);
    }
  });

  it('ignores bad input and survives size changes and reset()', () => {
    const tr = createContainerTracker();
    expect(tr.update(null)).toEqual([]);
    expect(tr.update({})).toEqual([]);
    expect(tr.update(frame({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 0))).toEqual([]);
    const gb = scene('gb1-oak-hello-en').img, gba = scene('gba-oak-hello-en').img;
    expect(tr.update(frame(gb, 0))[0].kind).toBe('dialog');
    expect(tr.update(frame(gba, 200))[0]).toMatchObject({ kind: 'dialog', w: 230, settledMs: 0 });
    expect(tr.update(frame(gba, 400))[0].settledMs).toBe(200);
    tr.reset();
    expect(tr.update(frame(gba, 600))[0].settledMs).toBe(0);
    // degenerate zones are ignored
    tr.setZone({ x: 0.2, y: 0.2, w: 0, h: 0.5 });
    expect(tr.update(frame(gba, 800))[0].kind).toBe('dialog');
  });
});
