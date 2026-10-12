// The live-translation loop (DOM-free; every dependency is injected).
//
// One explicit state machine replaces the old flag soup (PLAY-01..03,
// PLAY-16..22, PLAY-M1..M5):
// - a cheap poll every ~200 ms grabs the native frame and asks the
//   container tracker for text boxes with masked hashes and settle times;
// - a box is read once, when its hash has been still for 400 ms (250 ms
//   without "wait for typing"), and never again while its pixels stay the
//   same (per-box LRU of hash -> lines); at most one engine job runs;
// - pages of one conversation are merged by the dialog tracker, so a
//   scrolling box becomes one capture that grows ('update') instead of a
//   stream of overlapping fragments;
// - a capture is only emitted when its text differs from what is shown;
//   HUD labels never trigger one on their own;
// - translation is per region, cached, retried once after 3 s on failure.
//
// createScanner({ frameSource, tracker, engine, correct, translate,
//   getSettings, clock, cpuClock?, detectLanguage?, onSettingsChange?, upscale? })
//   -> { start, stop, pause, resume, scanNow, setZone, reset, retryRegion,
//        dismissHint, noteEngineStatus, getState, on }

import { upscaleNearest } from './ocr/capture.js';
import { buildRegions, joinLines } from './ocr/layout.js';
import { createDialogTracker, normalizeForCompare, similarText } from './ocr/dialog.js';
import { letterCount, isCapsish } from './ocr/lexicon.js';

const POLL_MS = { relaxed: 300, normal: 200, fast: 150 };
const SETTLE_MS = 400;
const SETTLE_QUICK_MS = 250;
const FREE_SETTLE_MS = 700;
const FREE_INTERVAL_MS = 3000;
// A whole-screen read takes 1–3 s on a phone, and the engine runs one job
// at a time in one worker: a job that has started cannot be cut short, and
// any read that comes after waits for it. So text outside the boxes is read
// only once the boxes have been still this long. While a box the player
// pages through (PAGED) is on screen the next A press is near certain, and
// its page must not wait behind an optional read: there the box must have
// been still for PAGED_QUIET_MS, unless whole-screen reads are known to be
// quick (the last one took at most FREE_QUICK_MS: a fast desktop), so the
// names in a battle HUD are still read. Until one has been timed it counts
// as slow: a desktop's engine can take 4 s too, and the main thread's speed
// doesn't tell. "Translate now" reads the rest of the screen anyway.
const BOX_QUIET_MS = 2000;
const PAGED_QUIET_MS = 8000;
const FREE_QUICK_MS = 1000;
const PAGED = new Set(['dialog', 'battle']);
// Temporal masking of the text outside the boxes (see createOutsideMemory):
// a pixel that changed is held for this many polls at the actual cadence,
// one that changes again within ANIMATED_MS is animation, and a poll that
// sees this share of the outside change is a new scene.
const OUTSIDE_HOLD_POLLS = 2.5;
const ANIMATED_MS = 4000;
const SCENE_SHARE = 0.25;
const CADENCE_SAMPLES = 4;
const IDLE_POLL_MS = 1000;
// A poll (frame grab + box tracking) runs on the main thread, next to the
// emulator: on a phone it costs 15-20 ms and every one drops a frame. The
// scanner keeps its average share of the main thread under 1 / PAYBACK (5 %)
// with a leaky bucket: a poll that typically costs c ms owes PAYBACK × c ms,
// and the regular polls wait until that is paid, never longer than
// SLOWEST_POLL_MS (at 20 ms a poll they stay 400 ms apart, as long as a page
// takes to settle). A box already seen still that is about to settle may
// borrow one poll's worth, so a page is still read the moment it has been
// still for 400 ms; the polls after it pay that back. A box that just
// changed may be typing on: it waits for the next poll the budget allows.
// A desktop poll costs 1-3 ms: its cadence and wake-ups are never held back.
const PAYBACK = 20;
const SLOWEST_POLL_MS = 800;
const COST_SAMPLES = 9;
const CORRECT_BELOW = 0.85;
const TESSERACT_MIN_SCORE = 0.3;
const CORRECT_BUDGET_MS = 2000;
const RETRY_MS = 3000;
// translate() rejects with { code: 'offline' | 'rate-limited' | 'failed' }
const TRANSLATE_ERRORS = {
  offline: 'You’re offline. Reconnect, then select Retry.',
  'rate-limited': 'The translation service is busy. Wait a minute, then select Retry.',
  failed: 'Couldn’t translate. Check your connection, then select Retry.'
};
const MAX_SIDE = 1280;
const LRU_SIZE = 64;
const MEMO_SIZE = 400;
const RECENT_CAPTURES = 30;
const MENU_ITEMS_EACH = 12;
const READ_BACKOFF_MS = [1000, 2000, 5000, 10000, 15000];
// Across captures a re-read may differ by a letter, but a changed word is
// new text ("Wild RATTATA" vs "Wild RATICATE"), so allow less than within
// one transcript.
const SAME_READ = 0.08;
const KIND_PRIORITY = { dialog: 0, battle: 1, menu: 2, zone: 3, box: 4, free: 5 };
const TRIGGER_FRAMES = new Set(['dialog', 'battle', 'menu']);
const FRAMED = new Set(['dialog', 'battle', 'menu', 'box']);

const PAUSE_MESSAGES = {
  user: 'Auto-translate is paused',
  hidden: 'Paused while the app is in the background',
  view: 'Paused while you’re away from the game',
  emulator: 'Paused while the game is paused',
  zone: 'Paused while you edit the text area',
  loading: 'Waiting for the game to start'
};

const defaultClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id)
};

// Measures how long a poll keeps the main thread: injected apart from
// `clock`, so tests with a scripted clock script poll costs too.
const defaultCpuClock = defaultClock.now;

// What a poll typically costs: the lower quartile of the recent samples. A
// slow poll now and then (a GC pause, a content-rect re-measure, a capture's
// listeners) does not move it, and neither do the dearer polls while a page
// is typed (each new frame is detected afresh), so the cadence does not
// slow down just before a page settles, when a prompt read matters most.
// While a box the player pages through is on screen, only polls of an
// unchanged screen count (the ones that wait for a page to settle): a run of
// new frames before it (walking, a transition, the game starting) would
// fill the samples and slow down the read of the first page after it.
function lowerQuartile(samples) {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[(s.length - 1) >> 2];
}

// Bounded Map with least-recently-used eviction.
function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// ×4 nearest for Game Boy-sized frames, ×3 above, never past 1280 px.
export function upscaleFactor(frameW, w, h) {
  let k = frameW <= 256 ? 4 : 3;
  while (k > 1 && Math.max(w, h) * k > MAX_SIDE) k--;
  return k;
}

// The text outside the boxes is read again only when that part of the
// screen changes: update() returns an FNV-1a hash of it, with temporal
// masking. Animation there (water, flowers, a walking NPC) changes pixels
// all the time, and polls 400-800 ms apart (a phone) can see an animated
// pixel at the same phase twice in a row, so a raw hash would count it as
// still. Each pixel adds the value it settled at:
// - a pixel that changes keeps its old value for OUTSIDE_HOLD_POLLS polls,
//   and while one is held the outside is not settled (`pendingUntil`): it
//   may be animation;
// - one that changes again within ANIMATED_MS is animation: it keeps its old
//   value until it has been still for ANIMATED_MS, and holds nothing up;
// - one that stays put for its hold is new content: its new value counts.
// A poll that sees SCENE_SHARE of the outside change is a new scene
// (walking, a transition, `scene`): what changed is held, and its next
// change is not taken for animation.
// It runs on every poll: each pixel is one 32-bit word (the top 4 bits of
// each channel, 0xf0 in every byte), the runs of pixels outside the rects
// are cached (boxes rarely move), and the pass over them has no branch per
// pixel (one costs 4x in V8): changes are looked for only in the 32-pixel
// blocks that have one, and held pixels are kept in a list.
const BYTE_TOPS = 0xf0f0f0f0;
const BLOCK = 32;
function createOutsideMemory() {
  let W = 0, H = 0;
  let t0 = 0;              // times below are ms since t0 (Float32: 1 ms steps for hours)
  let settled = null;      // value each pixel adds to the hash (signed, like px & BYTE_TOPS)
  let seen = null;         // its value at the last poll
  let changedAt = null;    // time of its last change (-Infinity: none, or a new scene)
  let heldUntil = null;    // its new value counts from then, if it stays
  let held = null;         // pixels whose seen and settled values may differ
  let heldCount = 0;
  let listed = null;       // 1: in `held`
  let changed = null;      // scratch: pixels that changed this poll
  let spanKey = '';
  let spans = null;
  let count = 0;           // pixels outside the rects

  // the first frame (of this size) is the scene as it stands
  function alloc(w, h, px, now) {
    W = w; H = h; t0 = now;
    const n = w * h;
    settled = new Int32Array(n);
    for (let p = 0; p < n; p++) settled[p] = px[p] & BYTE_TOPS;
    seen = settled.slice();
    changedAt = new Float32Array(n).fill(-Infinity);
    heldUntil = new Float32Array(n);
    held = new Int32Array(n);
    heldCount = 0;
    listed = new Uint8Array(n);
    changed = new Int32Array(n);
  }

  function spansFor(rects) {
    const key = `${W}x${H}|${rects.map((r) => [r.x, r.y, r.w, r.h].join(',')).join(';')}`;
    if (key === spanKey) return;
    const mask = new Uint8Array(W * H);
    for (const r of rects) {
      for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) {
        mask.fill(1, y * W + Math.max(0, r.x), y * W + Math.min(W, r.x + r.w));
      }
    }
    const runs = [];
    count = 0;
    for (let p = 0; p < mask.length;) {
      if (mask[p]) { p++; continue; }
      const start = p;
      while (p < mask.length && !mask[p]) p++;
      runs.push(start, p);
      count += p - start;
    }
    spanKey = key;
    spans = Int32Array.from(runs);
  }

  return {
    // -> { hash, scene, pendingUntil }; `every` is the poll interval (ms)
    update(img, rects, now, every) {
      const { width, height } = img;
      const data = img.data.byteOffset % 4 ? img.data.slice() : img.data;
      const px = new Uint32Array(data.buffer, data.byteOffset, width * height);
      if (width !== W || height !== H) alloc(width, height, px, now);
      spansFor(rects);
      const t = now - t0;
      // locals: the hot loops must not reload closure variables
      const S = settled, V = seen, R = spans, C = changed;
      // a held pixel that stayed put for its hold: its new value counts
      let kept = 0;
      for (let i = 0; i < heldCount; i++) {
        const p = held[i];
        const v = px[p] & BYTE_TOPS;
        if (v === V[p] && heldUntil[p] <= t) S[p] = v;
        if (S[p] === V[p]) listed[p] = 0;
        else held[kept++] = p;
      }
      heldCount = kept;
      // hash what has settled; look for changes where a block has one
      let h = 0x811c9dc5;
      let n = 0;
      for (let k = 0; k < R.length; k += 2) {
        const end = R[k + 1];
        for (let b = R[k]; b < end; b += BLOCK) {
          const e = Math.min(end, b + BLOCK);
          let diff = 0;
          for (let p = b; p < e; p++) {
            diff |= (px[p] & BYTE_TOPS) ^ V[p];
            h = Math.imul(h ^ S[p], 0x01000193);
          }
          if (diff !== 0) for (let p = b; p < e; p++) if ((px[p] & BYTE_TOPS) !== V[p]) C[n++] = p;
        }
      }
      const scene = n > SCENE_SHARE * count;
      const hold = OUTSIDE_HOLD_POLLS * every;
      let pendingUntil = -Infinity;
      for (let i = 0; i < n; i++) {
        const p = C[i];
        const animated = !scene && t - changedAt[p] <= ANIMATED_MS;
        heldUntil[p] = t + (animated ? ANIMATED_MS : hold);
        if (!animated) pendingUntil = now + hold;
        changedAt[p] = scene ? -Infinity : t;
        V[p] = px[p] & BYTE_TOPS;
        if (!listed[p]) {
          listed[p] = 1;
          held[heldCount++] = p;
        }
      }
      return { hash: h >>> 0, scene, pendingUntil };
    },
    // the same hash over the frame as it is (no masking), for the spans of
    // the last update: what the masked hash becomes once every pixel settles
    raw(img) {
      if (!spans || img.width !== W || img.height !== H) return null;
      const data = img.data.byteOffset % 4 ? img.data.slice() : img.data;
      const px = new Uint32Array(data.buffer, data.byteOffset, W * H);
      let h = 0x811c9dc5;
      for (let k = 0; k < spans.length; k += 2) {
        for (let p = spans[k]; p < spans[k + 1]; p++) h = Math.imul(h ^ (px[p] & BYTE_TOPS), 0x01000193);
      }
      return h >>> 0;
    },
    reset() {
      W = 0; H = 0;
      spanKey = '';
    }
  };
}

function copyImage(img) {
  const data = new Uint8ClampedArray(img.data);
  if (typeof ImageData === 'function') {
    try { return new ImageData(data, img.width, img.height); } catch { /* plain object below */ }
  }
  return { data, width: img.width, height: img.height };
}

const baseLang = (code) => {
  const c = String(code || '').toLowerCase().split(/[-_]/u)[0];
  return ({ iw: 'he', nb: 'no', nn: 'no', jw: 'jv', in: 'id' })[c] || c;
};

// "KAMPF" -> "Kampf": machine translation leaves lone all-caps words alone
// (DATA-24), and menu items are names of actions, not shouts.
function titleCase(text) {
  return text.split(/(\s+)/u).map((w) => (w.trim()
    ? w.charAt(0).toLocaleUpperCase() + w.slice(1).toLocaleLowerCase()
    : w)).join('');
}

export function createScanner(deps) {
  const {
    frameSource, tracker, engine, correct, translate, getSettings,
    clock = defaultClock, cpuClock = defaultCpuClock, detectLanguage, onSettingsChange, upscale = upscaleNearest
  } = deps;

  const listeners = { status: new Set(), capture: new Set(), update: new Set() };
  const pauseReasons = new Set();
  const lru = new Map();            // `${containerKey}|${hash}` -> { lines, engine, regions, complete }
  const screen = new Map();         // containerKey -> { container, hash, regions, processedHash, ghost }
  const correctionMemo = new Map();
  const translationMemo = new Map();
  const inflight = new Map();       // `${captureId}|${regionKey}|${text}` -> settles when its translation does
  const captures = new Map();       // recent capture records by id (for retries and continuations)
  // pollCostMs: main-thread ms of a poll that grabs a frame (lower quartile);
  // pollEveryMs: the regular poll interval after the main-thread budget;
  // screenReads: whole-screen reads started (the free frame, or the rest of
  // the screen around the boxes)
  const stats = { reads: 0, cacheHits: 0, lastReadMs: 0, engine: null, pollCostMs: 0, pollEveryMs: POLL_MS.normal, screenReads: 0 };

  let running = false;
  let timer = null;
  const costs = [];                 // main-thread ms of recent polls that grabbed a frame
  const steadyCosts = [];           // the same, for polls that saw no box (or free frame) change
  let steady = false;               // the current poll saw nothing change
  let budgetAt = -Infinity;         // when the main-thread time spent so far is paid back
  let grabbed = false;              // the current poll grabbed a frame
  let wakeIn = null;                // ms until the first unread box counts as settled
  let wakeStill = null;             // the same, for boxes already seen still
  let generation = 0;
  let seen = null;                  // settings that reset the scanner when they change
  let settingsCache = null;
  let unsubscribe = null;

  let job = null;                   // the one engine job in flight
  let forced = null;                // scanNow() in flight
  let readFailures = 0;
  let backoffUntil = 0;
  let engineError = null;
  let pollError = null;
  let linesUnsupported = false;
  let prepareLang = null;
  let preparing = null;
  let prepared = false;
  let unsupported = false;
  let setupInfo = null;
  let frameAvailable = true;
  let noLanguage = false;
  let userPaused = false;

  let lastContainers = [];
  let freeLastRead = -Infinity;
  let freeReadMs = Infinity;        // how long the last whole-screen read took (unknown: slow)
  // pendingUntil: a changed pixel outside the boxes may be animation until then
  // readRaw: the unmasked hash of the frame the last whole-screen read saw
  const outside = { hash: null, since: 0, pendingUntil: -Infinity, readHash: null, readRaw: null, regions: [], rects: [] };
  const outsideMemory = createOutsideMemory();
  const gaps = [];                  // ms between recent frames (the actual cadence)
  let lastFrameAt = null;

  let dialog = createDialogTracker();
  let dialogLang = null;
  let current = null;               // the capture on show (internal record)
  let composeHadContent = false;
  let translating = 0;
  let translationError = null;      // { id, key, retrying, code }
  let dialogChecks = 0;
  let mismatchStreak = 0;
  let mismatchLetters = 0;          // letters of new dialog text in the streak
  let hint = null;
  let status = { state: 'off', message: 'Live translation is off', progress: null, hint: null };
  let captureSeq = 0;

  // ---------------------------------------------------------------- events

  function emit(evt, payload) {
    for (const fn of listeners[evt] || []) {
      try { fn(payload); } catch (err) { console.error('[scanner] listener failed', err); }
    }
  }

  function on(evt, fn) {
    if (!listeners[evt]) throw new Error(`Unknown scanner event: ${evt}`);
    listeners[evt].add(fn);
    return () => listeners[evt].delete(fn);
  }

  // -------------------------------------------------------------- settings

  function readSettings() {
    try {
      settingsCache = { ...(getSettings() || {}) };
    } catch {
      settingsCache = settingsCache || {};
    }
    return settingsCache;
  }

  const pollMs = (s) => POLL_MS[s.scanSpeed] || POLL_MS.normal;
  const settleMs = (s) => (s.waitForTyping === false ? SETTLE_QUICK_MS : SETTLE_MS);

  // Source, target, engine or spell-check changes invalidate what was read
  // or translated (PLAY-M5, 2.6b).
  function applySettingChanges(s) {
    const next = { source: s.source || null, target: s.target || null, ocrEngine: s.ocrEngine || null, spellCheck: s.spellCheck !== false };
    const prev = seen;
    seen = next;
    if (!prev) return;
    if (prev.source !== next.source || prev.ocrEngine !== next.ocrEngine) {
      prepareLang = null;
      prepared = false;
      hint = null;
      dialogChecks = 0;
      mismatchStreak = 0;
      mismatchLetters = 0;
      reset();
    } else if (prev.target !== next.target) {
      const shown = current;
      reset();
      if (shown && next.target) retranslateInto(shown, next.target);
    } else if (prev.spellCheck !== next.spellCheck) {
      // re-run layout and correction on the cached engine lines (no new
      // read), but keep what is shown for dedupe
      generation++;
      correctionMemo.clear();
      for (const [k, v] of lru) {
        if (k.startsWith('outside|')) lru.delete(k);
        else v.complete = false;
      }
      for (const e of screen.values()) e.processedHash = null;
    }
  }

  // ---------------------------------------------------------------- status

  function computeStatus() {
    if (!running) return { state: 'off', message: 'Live translation is off' };
    if (pauseReasons.size) {
      const reason = [...pauseReasons][0];
      return { state: 'paused', message: PAUSE_MESSAGES[reason] || 'Paused', reason };
    }
    if (userPaused) return { state: 'paused', message: PAUSE_MESSAGES.user, reason: 'user' };
    if (noLanguage) return { state: 'paused', message: 'Choose the game’s language to start', reason: 'language' };
    if (unsupported) return { state: 'error', message: 'Text recognition isn’t available for this language yet' };
    if (setupInfo || preparing) {
      return {
        state: 'setup',
        message: (setupInfo && setupInfo.message) || 'Getting text recognition ready…',
        progress: setupInfo && typeof setupInfo.progress === 'number' ? setupInfo.progress : null
      };
    }
    if (!frameAvailable) return { state: 'paused', message: 'Waiting for the game screen', reason: 'frame' };
    if (job || forced) return { state: 'reading', message: 'Reading the screen…' };
    if (engineError || pollError) {
      const err = engineError || pollError;
      return {
        state: 'error',
        message: 'Couldn’t read the screen. Trying again…',
        detail: String(err.message || err)
      };
    }
    if (translating) return { state: 'translating', message: 'Translating…' };
    if (translationError) {
      return {
        state: 'error',
        message: translationError.retrying
          ? 'Couldn’t translate. Trying again in 3 seconds…'
          : (TRANSLATE_ERRORS[translationError.code] || TRANSLATE_ERRORS.failed)
      };
    }
    return { state: 'watching', message: 'Watching for text' };
  }

  function refreshStatus() {
    const next = { progress: null, ...computeStatus(), hint };
    const same = next.state === status.state && next.message === status.message &&
      next.progress === status.progress && next.hint === status.hint;
    status = next;
    if (!same) emit('status', { ...next });
  }

  // ------------------------------------------------------------------ loop

  function schedule(ms) {
    if (!running || timer !== null || pauseReasons.size) return;
    timer = clock.setTimeout(tick, ms);
  }

  function kick() {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    schedule(0);
  }

  function tick() {
    timer = null;
    if (!running || pauseReasons.size) return;
    const startedAt = clock.now();
    const cpuStart = cpuClock();
    let next = POLL_MS.normal;
    grabbed = false;
    steady = false;
    wakeIn = null;
    wakeStill = null;
    try {
      next = poll();
      pollError = null;
    } catch (err) {
      // never let a bad frame or a buggy dependency kill the loop
      console.error('[scanner] poll failed', err);
      pollError = err;
      next = IDLE_POLL_MS;
    }
    refreshStatus();
    schedule(paced(next, startedAt, cpuClock() - cpuStart));
  }

  // The delay before the next poll: the regular cadence (`next`), or sooner
  // when a box settles (wakeIn, wakeStill), but late enough to keep the
  // scanner's main-thread share under 1 / PAYBACK.
  function paced(next, startedAt, spent) {
    const cost = Number.isFinite(spent) && spent > 0 ? spent : 0;
    if (grabbed) {
      costs.push(cost);
      if (costs.length > COST_SAMPLES) costs.shift();
      if (steady) {
        steadyCosts.push(cost);
        if (steadyCosts.length > COST_SAMPLES) steadyCosts.shift();
      }
    }
    // (until three such polls are known, a page is not held back at all)
    const paging = lastContainers.some((c) => PAGED.has(c.kind));
    const typical = paging ? (steadyCosts.length >= 3 ? lowerQuartile(steadyCosts) : 0) : lowerQuartile(costs);
    const slot = Math.min(SLOWEST_POLL_MS, typical * PAYBACK);
    // a poll that grabbed a frame is charged the typical cost of one, so a
    // single slow poll does not stall the next; a poll without a frame
    // (paused, no game) costs next to nothing and is charged what it took
    budgetAt = Math.max(budgetAt, startedAt) + (grabbed ? slot : Math.min(SLOWEST_POLL_MS, cost * PAYBACK));
    stats.pollCostMs = Math.round(typical * 10) / 10;
    stats.pollEveryMs = Math.round(Math.max(pollMs(settingsCache || {}), slot));
    const owed = budgetAt - clock.now();
    let delay = Math.max(next, Math.min(SLOWEST_POLL_MS, owed));
    if (wakeIn !== null && wakeIn >= owed) delay = Math.min(delay, wakeIn);
    if (wakeStill !== null) delay = Math.min(delay, Math.max(wakeStill, owed - slot));
    return delay;
  }

  function poll() {
    const s = readSettings();
    applySettingChanges(s);
    userPaused = !!s.ocrPaused;
    noLanguage = !s.source;
    if (userPaused || noLanguage) return IDLE_POLL_MS;
    ensurePrepared(s.source);
    if (unsupported) return IDLE_POLL_MS;

    let frame = null;
    try {
      frame = frameSource.grab();
    } catch {
      frame = null;
    }
    frameAvailable = !!frame;
    // hidden view / game not started: the canvas is 0x0 (2.6b) - stay quiet
    if (!frame) return pollMs(s) * 2;
    grabbed = true;

    const now = clock.now();
    const containers = tracker.update(frame) || [];
    lastContainers = containers;
    steady = containers.length > 0 && containers.every((c) => c.settledMs > 0);
    syncScreen(containers);
    trackOutside(frame, containers, s, now);
    if (!job && !forced) startNextJob(frame, s, now);
    compose(now);
    return nextPollIn(containers, s);
  }

  // Event-driven cadence: poll again exactly when a still box will count as
  // settled (wakeIn), so "wait for typing" off (250 ms) really reads sooner
  // than on (400 ms) instead of both landing on the 200 ms grid; otherwise
  // at the regular cadence (returned).
  function nextPollIn(containers, s) {
    for (const c of containers) {
      const e = screen.get(c.key);
      // the free frame is only read automatically with "read all text" on
      if (!e || e.processedHash === c.hash || (c.kind === 'free' && !s.readAllText)) continue;
      const wait = (c.kind === 'free' ? FREE_SETTLE_MS : settleMs(s)) - c.settledMs;
      if (wait <= 0) continue;
      wakeIn = Math.min(wakeIn ?? Infinity, Math.max(wait, 20));
      if (c.settledMs > 0) wakeStill = Math.min(wakeStill ?? Infinity, Math.max(wait, 20));
    }
    return pollMs(s);
  }

  function ensurePrepared(lang) {
    if (prepareLang === lang) return;
    prepareLang = lang;
    prepared = false;
    let support = 'neural';
    try {
      support = engine.supports ? engine.supports(lang) : 'neural';
    } catch {
      support = 'neural';
    }
    unsupported = support === 'none';
    if (unsupported) return;
    const done = (err) => {
      if (prepareLang !== lang) return;
      prepared = true;
      preparing = null;
      setupInfo = null;
      // a failed prepare is not fatal: the engine may fall back to Tesseract
      if (err) engineError = err;
      refreshStatus();
      if (running && !job && !forced) kick();
    };
    preparing = Promise.resolve()
      .then(() => engine.prepare(lang))
      .then(() => done(null), (err) => done(err || new Error('Text recognition failed to start')));
  }

  // ------------------------------------------------------------ containers

  function syncScreen(containers) {
    const keys = new Set(containers.map((c) => c.key));
    for (const [k, e] of screen) if (!keys.has(k) || e.ghost) screen.delete(k);
    for (const c of containers) {
      const e = screen.get(c.key) || { regions: [], processedHash: null };
      e.container = c;
      e.hash = c.hash;
      screen.set(c.key, e);
    }
  }

  const cacheKey = (c) => `${c.key}|${c.hash}`;
  const isSettled = (c, s) => c.settledMs >= (c.kind === 'free' ? FREE_SETTLE_MS : settleMs(s));
  const byPriority = (a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9) || (b.y + b.h) - (a.y + a.h);

  function needsWork(c, s) {
    const e = screen.get(c.key);
    return !!e && e.processedHash !== c.hash && isSettled(c, s);
  }

  function applyRegions(c, hash, regions) {
    const e = screen.get(c.key);
    if (e) {
      e.regions = regions;
      if (e.hash === hash) e.processedHash = hash;
    } else {
      // the box closed while it was being read: show the read once anyway,
      // the player did see that text
      screen.set(c.key, { container: c, hash, regions, processedHash: hash, ghost: true });
    }
  }

  function startNextJob(frame, s, now) {
    if (!prepared || now < backoffUntil) return;
    const todo = lastContainers.filter((c) => needsWork(c, s)).sort(byPriority);
    for (const c of todo) {
      if (c.kind === 'free' && !s.readAllText) continue;
      const cached = lruGet(lru, cacheKey(c));
      if (cached && cached.complete) {
        stats.cacheHits++;
        applyRegions(c, c.hash, cached.regions);
        continue;
      }
      if (c.kind === 'free' && !cached && now - freeLastRead < FREE_INTERVAL_MS) continue;
      readContainer(c, frame, s, { cached });
      return;
    }
    if (!shouldReadOutside(now)) return;
    // the same scene around a box seen before (talking to the same NPC
    // again): no need for another whole-screen read
    const cached = lruGet(lru, outsideKey());
    if (cached) {
      stats.cacheHits++;
      outside.readHash = outside.hash;
      outside.regions = cached.regions;
    } else if (now - freeLastRead >= FREE_INTERVAL_MS) {
      readOutside(frame, s);
    }
  }

  // The engine transfers pixel buffers to its worker; never hand it one
  // the tracker still owns.
  const scaled = (img, k) => (k > 1 ? upscale(img, k) : copyImage(img));

  // Framed boxes come with text-row cells (containers.js): recognising each
  // row without the detector is faster and keeps lines whole. The cell's
  // ink box is the line's native box. Free and zone reads use the detector.
  function prepareJob(c, frame, lang) {
    if (FRAMED.has(c.kind) && typeof c.cells === 'function' && !linesUnsupported) {
      const cells = c.cells() || [];
      const strips = cells.map((cell) => {
        const { img, offset } = cell.crop();
        const k = upscaleFactor(frame.w, img.width, img.height);
        return { img: scaled(img, k), k, offset };
      });
      return { cells, job: { mode: 'lines', strips, lang } };
    }
    const { img, offset } = c.crop();
    const k = upscaleFactor(frame.w, img.width, img.height);
    return { cells: null, job: { img: scaled(img, k), k, offset, lang, mode: c.kind === 'free' ? 'free' : 'container' } };
  }

  async function runEngine(c, frame, lang, spec) {
    const { cells, job } = spec;
    if (cells) {
      if (!cells.length) return { lines: [], engine: null, ms: 0, skipped: true }; // an empty box
      let res;
      try {
        res = await engine.read(job);
      } catch (err) {
        // an engine without line mode ("Unknown OCR mode"): use the detector
        // from now on. Any other error is a failed read, retried later.
        if (!(err instanceof TypeError) || !/\bmode\b/iu.test(String(err.message || ''))) throw err;
        linesUnsupported = true;
        return runEngine(c, frame, lang, prepareJob(c, frame, lang));
      }
      const got = (res && res.lines) || [];
      const lines = cells.map((cell, i) => ({
        text: (got[i] && got[i].text) || '',
        score: got[i] && typeof got[i].score === 'number' ? got[i].score : 0,
        box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h },
        row: cell.row,
        col: cell.col
      })).filter((l) => l.text);
      return { lines, engine: res && res.engine, ms: res && res.ms };
    }
    const res = await engine.read(job);
    return { lines: (res && res.lines) || [], engine: res && res.engine, ms: res && res.ms };
  }

  // Reads one container (or re-processes its cached lines) as the single
  // job in flight. Resolves when done; never rejects.
  function readContainer(c, frame, s, { cached = null } = {}) {
    const gen = generation;
    const lang = s.source;
    const hash = c.hash;
    let spec = null;
    if (!cached) {
      try {
        // crops are taken now, from the frame the tracker just saw
        spec = prepareJob(c, frame, lang);
      } catch (err) {
        return Promise.resolve(readFailed(err));
      }
    }
    const run = (async () => {
      let raw = cached;
      if (!raw) {
        if (c.kind === 'free') {
          freeLastRead = clock.now();
          stats.screenReads++;
        }
        raw = await runEngine(c, frame, lang, spec);
        if (c.kind === 'free') freeReadMs = clock.now() - freeLastRead;
        if (!raw.skipped) readSucceeded(raw);
      }
      if (gen !== generation) return;
      const { regions, complete } = await processLines(raw, c, frame, s);
      if (gen !== generation) return;
      lruSet(lru, cacheKey({ key: c.key, hash }), { ...raw, regions, complete }, LRU_SIZE);
      applyRegions(c, hash, regions);
    })();
    return trackJob(run);
  }

  function trackJob(run) {
    const p = run.catch(readFailed).finally(() => {
      if (job === p) job = null;
      compose(clock.now());
      refreshStatus();
      if (!running || forced || pauseReasons.size) return;
      const s = readSettings();
      if (!s.ocrPaused && s.source) startNextJob(lastFrameForJobs(), s, clock.now());
    });
    job = p;
    refreshStatus();
    return p;
  }

  // the latest polled frame, for chaining the next job without waiting a poll
  let lastFrame = null;
  const lastFrameForJobs = () => lastFrame || { w: 0, h: 0 };

  function readSucceeded(res) {
    stats.reads++;
    stats.lastReadMs = (res && res.ms) || 0;
    stats.engine = (res && res.engine) || stats.engine;
    readFailures = 0;
    engineError = null;
    // the engine answered, so whatever it was setting up is done (the
    // Tesseract fallback never reports a failed download)
    setupInfo = null;
  }

  function readFailed(err) {
    setupInfo = null;
    readFailures++;
    engineError = err || new Error('Text recognition failed');
    backoffUntil = clock.now() + READ_BACKOFF_MS[Math.min(readFailures, READ_BACKOFF_MS.length) - 1];
    console.warn('[scanner] read failed', err);
  }

  // ------------------------------------------------- text outside the boxes

  function framedRects(containers) {
    return containers.filter((c) => FRAMED.has(c.kind)).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
  }

  // The poll interval as it actually is (the main-thread budget stretches it
  // on a phone): the longest of the last few gaps between frames, never
  // shorter than the scan speed's. Longer gaps are pauses, not the cadence.
  function noteFrame(now) {
    const gap = lastFrameAt === null ? 0 : now - lastFrameAt;
    lastFrameAt = now;
    if (gap <= 0 || gap > 1.5 * SLOWEST_POLL_MS) return;
    gaps.push(gap);
    if (gaps.length > CADENCE_SAMPLES) gaps.shift();
  }
  const cadence = (s) => Math.max(pollMs(s), ...gaps);

  function trackOutside(frame, containers, s, now) {
    lastFrame = frame;
    noteFrame(now);
    const rects = framedRects(containers);
    if (!s.readAllText || !rects.length || containers.some((c) => c.kind === 'zone' || c.kind === 'free')) {
      outside.hash = null;
      outside.readHash = null;
      outside.regions = [];
      return;
    }
    const { hash: h, scene, pendingUntil } = outsideMemory.update(frame.img, rects, now, cadence(s));
    outside.rects = rects;
    outside.pendingUntil = Math.max(outside.pendingUntil, pendingUntil);
    if (h !== outside.hash) {
      outside.hash = h;
      outside.since = now;
      // Pixels held while they changed (animation, a sign drawn where an NPC
      // walked) settle to exactly the frame that was read last: nothing new.
      // Otherwise what was read there is gone; the new scene is read once it
      // settles.
      if (h === outside.readRaw) outside.readHash = h;
      else outside.regions = [];
    } else if (scene) {
      outside.since = now;
    }
  }

  const outsideKey = () => `outside|${(outside.rects || []).map((r) => [r.x, r.y, r.w, r.h].join(',')).join(';')}|${outside.hash}`;

  // Low priority: only once every box is read and has been still for 2 s
  // (a box the player pages through: 8 s, unless whole-screen reads are
  // known to be quick), and the rest of the screen for 700 ms with nothing
  // held that may be animation (the caller allows one read per 3 s).
  function shouldReadOutside(now) {
    if (outside.hash === null || outside.hash === outside.readHash) return false;
    if (now - outside.since < FREE_SETTLE_MS || now < outside.pendingUntil) return false;
    const pagedQuiet = freeReadMs <= FREE_QUICK_MS ? BOX_QUIET_MS : PAGED_QUIET_MS;
    return !lastContainers.some((c) => c.settledMs < (PAGED.has(c.kind) ? pagedQuiet : BOX_QUIET_MS) ||
      (screen.get(c.key) && screen.get(c.key).processedHash !== c.hash));
  }

  function readOutside(frame, s) {
    const gen = generation;
    const hash = outside.hash;
    const key = outsideKey();
    const rects = framedRects(lastContainers);
    const lang = s.source;
    const run = (async () => {
      const k = upscaleFactor(frame.w, frame.w, frame.h);
      const img = scaled(frame.img, k);
      freeLastRead = clock.now();
      stats.screenReads++;
      outside.readHash = hash;
      // the frame as it is: once the masked hash catches up with it, nothing is new
      outside.readRaw = outsideMemory.raw(frame.img);
      const res = await engine.read({ img, k, offset: { x: 0, y: 0 }, lang, mode: 'free' });
      freeReadMs = clock.now() - freeLastRead;
      readSucceeded(res);
      if (gen !== generation) return;
      const inside = (l) => {
        const cx = l.box.x + l.box.w / 2;
        const cy = l.box.y + l.box.h / 2;
        return rects.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
      };
      const lines = ((res && res.lines) || []).filter((l) => l && l.box && !inside(l));
      const box = { key: 'outside', kind: 'free', x: 0, y: 0, w: frame.w, h: frame.h };
      const { regions, complete } = await processLines({ lines, engine: res && res.engine }, box, frame, s);
      if (gen !== generation) return;
      if (complete) lruSet(lru, key, { regions }, LRU_SIZE);
      if (outside.hash === hash) outside.regions = regions;
    })();
    return trackJob(run);
  }

  // ------------------------------------------------------------ processing

  // Layout + clean-up, then spell-correction of uncertain lines within a
  // 2 s budget. Lines whose correction did not finish keep the raw text and
  // are not memoised, so a later pass can still correct them.
  async function processLines(raw, c, frame, s) {
    const lang = s.source;
    // Tesseract scores run lower than the neural engine's (engine MIN_SCORE)
    const minScore = raw.engine === 'tesseract' ? TESSERACT_MIN_SCORE : undefined;
    const regions = buildRegions(raw.lines, c, { w: frame.w, h: frame.h }, { lang, minScore });
    let complete = true;
    if (!correct || s.spellCheck === false) return { regions, complete };
    const tasks = [];
    for (const r of regions) {
      r.lines.forEach((line, i) => {
        const score = r.lineScores && typeof r.lineScores[i] === 'number' ? r.lineScores[i] : r.score;
        if (raw.engine !== 'tesseract' && !(score < CORRECT_BELOW)) return;
        const key = `${lang}|${line}`;
        if (correctionMemo.has(key)) {
          r.lines[i] = correctionMemo.get(key);
          return;
        }
        const task = { r, i, key, done: false, value: null };
        task.promise = Promise.resolve()
          .then(() => correct(line, lang, score))
          .then((v) => { task.done = true; task.value = v; }, () => { task.done = true; });
        tasks.push(task);
      });
    }
    if (tasks.length) {
      let budget = null;
      await Promise.race([
        Promise.all(tasks.map((t) => t.promise)),
        new Promise((resolve) => { budget = clock.setTimeout(resolve, CORRECT_BUDGET_MS); })
      ]);
      clock.clearTimeout(budget);
      for (const t of tasks) {
        if (t.done && typeof t.value === 'string' && t.value.trim()) {
          t.r.lines[t.i] = t.value;
          lruSet(correctionMemo, t.key, t.value, MEMO_SIZE);
        } else if (!t.done) {
          complete = false;
        }
      }
    }
    for (const r of regions) r.text = r.kind === 'menu' ? r.lines.join('\n') : joinLines(r.lines);
    return { regions: regions.filter((r) => r.text.trim()), complete };
  }

  // -------------------------------------------------------------- captures

  // Labels (HUD plates, signs) only start a capture in free reads, or from
  // a box when no dialog/battle/menu box is on screen.
  function triggers(region, kind, framedPresent) {
    if (region.kind !== 'label') return true;
    if (kind === 'free' || kind === 'zone') return true;
    return kind === 'box' && !framedPresent;
  }

  function screenRegions() {
    const entries = [...screen.values()]
      .filter((e) => e.container && e.regions && e.regions.length)
      .sort((a, b) => byPriority(a.container, b.container));
    return entries.flatMap((e) => e.regions.map((r) => ({ region: r, kind: e.container.kind })));
  }

  // Merges what is on screen into the shown capture. While paused (by the
  // player or the app) nothing new is emitted, except for "Translate now".
  function compose(now, { force = false } = {}) {
    if (!running || (!force && (pauseReasons.size || userPaused))) return;
    const s = settingsCache || readSettings();
    const lang = s.source;
    if (dialogLang !== lang) {
      dialog = createDialogTracker({ lang });
      dialogLang = lang;
    }
    const all = screenRegions();
    const primaryAt = all.findIndex((x) => x.region.kind === 'dialog');
    const primary = primaryAt >= 0 ? all[primaryAt].region : null;
    const ds = dialog.update(primary, now);
    const framedPresent = lastContainers.some((c) => TRIGGER_FRAMES.has(c.kind));
    const others = all
      .filter((x, i) => i !== primaryAt)
      .map((x) => ({ region: x.region, trigger: triggers(x.region, x.kind, framedPresent) }));
    for (const r of outside.regions) others.push({ region: r, trigger: false });
    for (const [k, e] of screen) if (e.ghost) screen.delete(k);

    const dialogText = primary ? ds.text : '';
    composeHadContent = !!dialogText || others.some((o) => o.trigger);
    if (!composeHadContent) return;
    decide({ s, ds, primary, dialogText, others });
  }

  function decide({ s, ds, primary, dialogText, others }) {
    const nd = normalizeForCompare(dialogText);
    const seenText = new Set(nd ? [nd] : []);
    const fresh = [];
    for (const o of others) {
      const n = normalizeForCompare(o.region.text);
      if (!n || seenText.has(n)) continue;
      seenText.add(n);
      fresh.push(o);
    }
    const conf = primary ? primary.score : Math.max(0, ...fresh.filter((o) => o.trigger).map((o) => o.region.score || 0));

    if (current) {
      const curDialog = normalizeForCompare(current.dialog ? current.dialog.text : '');
      const curOthers = current.others.map((o) => normalizeForCompare(o.text));
      // a re-read can differ by a letter ("OPTION" / "OPTlON"): that is
      // still what is shown
      const shown = (n) => curOthers.some((c) => similarText(c, n, SAME_READ));
      const added = fresh.filter((o) => !shown(normalizeForCompare(o.region.text)));
      const addedTriggers = added.some((o) => o.trigger);
      if (primary) {
        const sameTranscript = current.transcriptId === ds.id;
        if (sameTranscript || similarText(nd, curDialog, SAME_READ)) {
          current.transcriptId = ds.id;
          // only the transcript itself grows the text; a slightly different
          // re-read of what is shown is not news
          const grew = sameTranscript && nd !== curDialog;
          if (!grew && !addedTriggers) return;
          if (grew) {
            current.dialog = { text: dialogText, translation: current.dialog ? current.dialog.translation : '', status: 'pending' };
            current.conf = conf;
          }
          addOthers(current, added);
          emit('update', snapshot(current));
          translateCapture(current);
          // a growing transcript is new text: one wrong-language page that
          // continues on the next would otherwise never count twice
          if (grew) checkLanguage(current);
          return;
        }
      } else if (!addedTriggers) {
        // every menu or label that could start a capture is already shown
        return;
      } else if (!current.dialog && fresh.some((o) => o.trigger && shown(normalizeForCompare(o.region.text)))) {
        // a submenu opened over a menu that is shown: grow that capture
        addOthers(current, added);
        emit('update', snapshot(current));
        translateCapture(current);
        return;
      }
    }

    const rec = {
      id: `cap-${Date.now().toString(36)}-${(++captureSeq).toString(36)}`,
      time: Date.now(),
      src: s.source,
      tgt: s.target,
      dialog: primary ? { text: dialogText, translation: '', status: 'pending' } : null,
      others: [],
      conf,
      transcriptId: primary ? ds.id : null
    };
    addOthers(rec, fresh);
    current = rec;
    lruSet(captures, rec.id, rec, RECENT_CAPTURES);
    translationError = null;
    emit('capture', snapshot(rec));
    translateCapture(rec);
    if (rec.dialog) checkLanguage(rec);
  }

  function addOthers(rec, list) {
    for (const o of list) {
      let key = o.region.key;
      for (let n = 2; rec.others.some((x) => x.key === key); n++) key = `${o.region.key}~${n}`;
      rec.others.push({ key, kind: o.region.kind, text: o.region.text, translation: '', status: 'pending' });
    }
  }

  function snapshot(rec) {
    return {
      id: rec.id,
      time: rec.time,
      src: rec.src,
      tgt: rec.tgt,
      dialog: rec.dialog ? { ...rec.dialog } : null,
      others: rec.others.map((o) => ({ ...o })),
      conf: rec.conf
    };
  }

  // A new target language: show the visible capture again, translated into
  // it, as a new capture (history keeps the old one in the old language).
  function retranslateInto(shown, target) {
    const rec = {
      ...shown,
      id: `cap-${Date.now().toString(36)}-${(++captureSeq).toString(36)}`,
      time: Date.now(),
      tgt: target,
      dialog: shown.dialog ? { text: shown.dialog.text, translation: '', status: 'pending' } : null,
      others: shown.others.map((o) => ({ ...o, translation: '', status: 'pending' })),
      transcriptId: null
    };
    current = rec;
    lruSet(captures, rec.id, rec, RECENT_CAPTURES);
    emit('capture', snapshot(rec));
    translateCapture(rec);
  }

  // ----------------------------------------------------------- translation

  function regionOf(rec, key) {
    if (key === 'dialog') return rec.dialog;
    return rec.others.find((o) => o.key === key) || null;
  }

  function translateCapture(rec) {
    if (rec.dialog && rec.dialog.status === 'pending') translateRegion(rec, 'dialog', 0);
    for (const o of rec.others) if (o.status === 'pending') translateRegion(rec, o.key, 0);
  }

  async function translateText(text, kind, src, tgt) {
    if (kind === 'menu') {
      const items = text.split('\n');
      if (items.length <= MENU_ITEMS_EACH) {
        const out = await Promise.all(items.map((t) => translate(isCapsish(t) ? titleCase(t) : t, src, tgt)));
        return out.join('\n');
      }
    }
    if (kind === 'label' && isCapsish(text)) return translate(titleCase(text), src, tgt);
    return translate(text, src, tgt);
  }

  async function translateRegion(rec, key, attempt) {
    const target = regionOf(rec, key);
    if (!target || !target.text) return;
    const text = target.text;
    const kind = key === 'dialog' ? 'dialog' : target.kind;
    const memoKey = `${rec.src}|${rec.tgt}|${kind}|${text}`;
    const memo = lruGet(translationMemo, memoKey);
    if (memo !== undefined) {
      target.translation = memo;
      target.status = 'done';
      emit('update', snapshot(rec));
      return;
    }
    const flight = `${rec.id}|${key}|${text}`;
    // a Retry while the automatic retry runs waits for that outcome instead of reporting failure
    if (inflight.has(flight)) return inflight.get(flight);
    if (typeof translate !== 'function') {
      target.status = 'done';
      return;
    }
    let settle;
    inflight.set(flight, new Promise((resolve) => { settle = resolve; }));
    const wasError = target.status === 'error';
    target.status = 'pending';
    translating++;
    refreshStatus();
    // a retried part shows that it is being translated again, not the old error
    if (wasError) emit('update', snapshot(rec));
    try {
      const out = String((await translateText(text, kind, rec.src, rec.tgt)) ?? '');
      lruSet(translationMemo, memoKey, out, MEMO_SIZE);
      const now = regionOf(rec, key);
      if (!now || now.text !== text) return; // superseded by a longer transcript
      now.translation = out;
      now.status = 'done';
      if (translationError && translationError.id === rec.id && translationError.key === key) translationError = null;
      emit('update', snapshot(rec));
    } catch (err) {
      const now = regionOf(rec, key);
      if (!now || now.text !== text) return;
      now.status = 'error';
      const retrying = attempt === 0;
      // the reason matters: "check your connection" is wrong advice when the service is busy
      if (rec === current) translationError = { id: rec.id, key, retrying, code: err && err.code };
      emit('update', snapshot(rec));
      if (retrying) {
        clock.setTimeout(() => {
          const again = regionOf(rec, key);
          if (running && again && again.text === text && again.status === 'error') translateRegion(rec, key, 1);
        }, RETRY_MS);
      }
      console.warn('[scanner] translation failed', err);
    } finally {
      inflight.delete(flight);
      settle();
      translating--;
      refreshStatus();
    }
  }

  // Google's detected language disagrees with the chosen game language on
  // three dialog checks in a row, or on two that hold 40+ letters of new
  // text (two full pages of another language is evidence enough): suggest
  // switching. Checked on new captures and growing transcripts - the first
  // three, every 20th after, or while a streak runs.
  async function checkLanguage(rec) {
    const text = rec.dialog.text;
    if (!detectLanguage || letterCount(text) < 12) return;
    // only the part of a transcript not counted before adds to the evidence
    const fresh = Math.max(0, letterCount(text) - (rec.langLetters || 0));
    rec.langLetters = letterCount(text);
    dialogChecks++;
    if (!(dialogChecks <= 3 || mismatchStreak > 0 || dialogChecks % 20 === 0)) return;
    let detected = null;
    try {
      detected = await detectLanguage(rec.dialog.text);
    } catch {
      return;
    }
    if (!detected || rec.src !== (settingsCache && settingsCache.source)) return;
    if (baseLang(detected) === baseLang(rec.src)) {
      mismatchStreak = 0;
      mismatchLetters = 0;
      return;
    }
    mismatchStreak++;
    mismatchLetters += fresh;
    if (mismatchStreak >= 3 || (mismatchStreak >= 2 && mismatchLetters >= 40)) {
      const next = { type: 'language-mismatch', detected: baseLang(detected), expected: rec.src };
      if (!hint || hint.detected !== next.detected) {
        hint = next;
        refreshStatus();
      }
    }
  }

  // ------------------------------------------------------------ public API

  function reset() {
    generation++;
    lru.clear();
    screen.clear();
    correctionMemo.clear();
    dialog.reset();
    try {
      if (tracker.reset) tracker.reset();
    } catch {
      // a tracker without reset keeps its state
    }
    current = null;
    translationError = null;
    outside.hash = null;
    outside.readHash = null;
    outside.readRaw = null;
    outside.regions = [];
    outside.pendingUntil = -Infinity;
    outsideMemory.reset();
    freeLastRead = -Infinity;
    readFailures = 0;
    backoffUntil = 0;
    engineError = null;
  }

  function start() {
    if (running) return;
    running = true;
    seen = null;
    reset();
    const s = readSettings();
    applySettingChanges(s);
    if (s.source && !s.ocrPaused) ensurePrepared(s.source);
    if (onSettingsChange && !unsubscribe) {
      try {
        unsubscribe = onSettingsChange(() => {
          if (!running) return;
          applySettingChanges(readSettings());
          kick();
        });
      } catch {
        unsubscribe = null;
      }
    }
    refreshStatus();
    schedule(0);
  }

  function stop() {
    running = false;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* already gone */ }
    }
    unsubscribe = null;
    refreshStatus();
  }

  function pause(reason = 'user') {
    pauseReasons.add(reason);
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    refreshStatus();
  }

  function resume(reason = 'user') {
    pauseReasons.delete(reason);
    refreshStatus();
    if (!pauseReasons.size) kick();
  }

  function setZone(rect) {
    try {
      tracker.setZone(rect || null);
    } catch (err) {
      console.warn('[scanner] setZone failed', err);
    }
    reset();
    if (running) kick();
  }

  // "Translate now": read every box on screen right away (and the free
  // frame or the text outside the boxes), bypassing settle times and the
  // cache. Single-flight; waits for a read already in flight. Resolves
  // with the capture for what is on screen, or null when nothing readable.
  function scanNow() {
    if (!running) return Promise.resolve(null);
    if (forced) return forced;
    const p = (async () => {
      if (job) await job;
      const s = readSettings();
      applySettingChanges(s);
      if (!s.source) return null;
      ensurePrepared(s.source);
      if (unsupported) return null;
      if (preparing) await preparing;
      let frame = null;
      try {
        frame = frameSource.grab();
      } catch {
        frame = null;
      }
      frameAvailable = !!frame;
      if (!frame) return null;
      const containers = tracker.update(frame) || [];
      lastContainers = containers;
      syncScreen(containers);
      trackOutside(frame, containers, s, clock.now());
      // every box, and the free frame even when "read text outside text
      // boxes" is off: the player asked for this screen explicitly
      for (const c of [...containers].sort(byPriority)) await readContainer(c, frame, s);
      compose(clock.now(), { force: true });
      const readOut = outside.hash !== null && s.readAllText;
      if (composeHadContent && current) {
        // the boxes are what the player is looking at: answer with them now
        // (a whole-screen read takes seconds); the rest of the screen is
        // read next and joins this capture
        const plan = readOut ? outsidePlan() : 'skip';
        if (plan !== 'skip') attachOutside(plan === 'read' ? readOutside(frame, s) : Promise.resolve(), current);
        return snapshot(current);
      }
      // nothing in the boxes: the rest of the screen is all there is
      if (readOut) await readOutside(frame, s);
      compose(clock.now(), { force: true });
      return composeHadContent && current ? snapshot(current) : null;
    })();
    forced = p.catch((err) => {
      readFailed(err);
      return null;
    }).finally(() => {
      forced = null;
      refreshStatus();
      if (running && !pauseReasons.size) kick();
    });
    refreshStatus();
    return forced;
  }

  // "Translate now" reads the rest of the screen once per scene ('cached'
  // reuses that read) and at most every 3 s ('skip'): a whole-screen read
  // takes seconds, and the next press waits for it (one engine job at a time).
  function outsidePlan() {
    const cached = lruGet(lru, outsideKey());
    if (cached) {
      outside.readHash = outside.hash;
      outside.regions = cached.regions;
      return 'cached';
    }
    return clock.now() - freeLastRead >= FREE_INTERVAL_MS ? 'read' : 'skip';
  }

  // Text "Translate now" found outside the boxes after it answered: added
  // to the capture it answered with, if that is still the one on show.
  function attachOutside(read, rec) {
    const gen = generation;
    read.then(() => {
      if (gen !== generation || rec !== current || !outside.regions.length) return;
      const shown = [rec.dialog ? rec.dialog.text : '', ...rec.others.map((o) => o.text)].map(normalizeForCompare);
      const fresh = outside.regions.filter((r) => {
        const n = normalizeForCompare(r.text);
        return n && !shown.some((x) => x && similarText(x, n, SAME_READ));
      });
      if (!fresh.length) return;
      addOthers(rec, fresh.map((region) => ({ region })));
      emit('update', snapshot(rec));
      translateCapture(rec);
    });
  }

  // Manual "Retry" for a region of the shown capture (or of a recent one).
  function retryRegion(key, captureId) {
    const rec = captureId ? captures.get(captureId) : current;
    if (!rec || !regionOf(rec, key)) return Promise.resolve(false);
    return translateRegion(rec, key, 1).then(() => {
      const r = regionOf(rec, key);
      return !!r && r.status === 'done';
    });
  }

  // Lets the view forward engine onStatus (download/init progress).
  function noteEngineStatus(s) {
    if (!s) return;
    if (s.phase === 'download' || s.phase === 'init') setupInfo = { message: s.message, progress: s.progress };
    else setupInfo = null;
    if (s.phase === 'error') engineError = new Error(s.message || 'Text recognition failed to start');
    refreshStatus();
  }

  function dismissHint() {
    hint = null;
    mismatchStreak = 0;
    mismatchLetters = 0;
    refreshStatus();
  }

  function getState() {
    return {
      running,
      status: { ...status },
      paused: [...pauseReasons],
      capture: current ? snapshot(current) : null,
      hint,
      busy: !!(job || forced),
      stats: { ...stats }
    };
  }

  return {
    start, stop, pause, resume, scanNow, setZone, reset, retryRegion,
    dismissHint, noteEngineStatus, getState, on
  };
}
