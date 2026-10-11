#!/usr/bin/env node
// Browser checks for the Review, Deck and Dictionary views in the real app
// (Vite dev server + headless Chromium):
//  - axe-core: zero violations on each view, empty and populated, dark and light
//  - keyboard walkthroughs: review flow (reveal, grade, Again, held Enter),
//    deck delete + undo, dictionary batch translation (translation API stubbed)
//  - screenshots at desktop and phone sizes in both themes
//
//   node tests/e2e-learn/learn.e2e.mjs [--base http://127.0.0.1:5463/] [--shots DIR] [--headed]
//
// Without --base it starts its own Vite server on the first free port from 5480.
// axe-core is loaded from node_modules/axe-core or $AXE_PATH (axe checks are
// skipped, with a warning, when neither exists).
// Prints one line per check and exits 1 on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const HEADED = argv.includes('--headed');
const SHOTS = arg('--shots', path.join(os.tmpdir(), 'emulingo-e2e-learn'));
const PORTS = [5480, 5481, 5482, 5483, 5484, 5485, 5486, 5487];
const VIEWS = ['review', 'deck', 'dictionary'];
const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

// ---- axe ------------------------------------------------------------------------

function loadAxe() {
  const candidates = [];
  if (process.env.AXE_PATH) candidates.push(process.env.AXE_PATH);
  try { candidates.push(createRequire(import.meta.url).resolve('axe-core/axe.min.js')); } catch { /* not installed */ }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  console.warn('WARN axe-core not found (npm i -D axe-core, or set AXE_PATH): accessibility scans skipped');
  return null;
}
const AXE = loadAxe();

// ---- results --------------------------------------------------------------------

const results = [];
function check(name, ok, info) {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && info !== undefined ? ` :: ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}

// ---- server ---------------------------------------------------------------------

async function startVite() {
  const { createServer } = await import('vite');
  for (const port of PORTS) {
    try {
      const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'warn', server: { port, strictPort: true, host: '127.0.0.1', hmr: false } });
      await server.listen();
      return { server, base: `http://127.0.0.1:${port}/` };
    } catch (e) {
      if (!/in use|EADDRINUSE/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error(`No free port in ${PORTS.join(', ')}`);
}

// ---- page helpers ---------------------------------------------------------------

async function openApp(page, base, view) {
  await page.goto(`${base}#/${view}`);
  await page.waitForSelector(`section[data-view="${view}"]:not([hidden]) h1`, { timeout: 20000 });
  await page.waitForTimeout(150);
}

async function go(page, view) {
  await page.evaluate((v) => { location.hash = `#/${v}`; }, view);
  await page.waitForSelector(`section[data-view="${view}"]:not([hidden]) h1`, { timeout: 20000 });
  await page.waitForTimeout(200);
}

async function axe(page, label) {
  if (!AXE) return;
  const has = await page.evaluate(() => !!window.axe);
  if (!has) await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary || '').split('\n').slice(0, 2).join(' ')}`) }));
  });
  check(`axe ${label}`, res.length === 0, res);
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return null;
  return {
    tag: a.tagName,
    action: a.dataset.action || null,
    q: a.dataset.q || null,
    label: a.getAttribute('aria-label') || a.textContent.trim().replace(/\s+/g, ' ').slice(0, 60),
    key: a.closest('[data-key]')?.dataset.key || null,
    id: a.id || null,
  };
});

const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent.trim().replace(/\s+/g, ' ') ?? null, sel);
const srStatus = async (page) => { await page.waitForTimeout(180); return text(page, '#sr-status'); };

// Realistic German Pokémon data: cards in every stage, a week of activity,
// and dictionary entries with some words still untranslated.
async function seed(page) {
  await page.evaluate(async () => {
    const { store } = await import('/src/core/store.js');
    const srs = await import('/src/core/srs.js');
    const dict = await import('/src/core/dictionary.js');
    const db = await import('/src/core/db.js');
    store.set('source', 'de');
    store.set('target', 'en');
    store.set('onboarded', true);
    const DAY = 86_400_000;
    const now = Date.now();
    const cards = [
      ['Ein wildes TAUBSI erscheint!', 'A wild PIDGEY appears!', { seen: 2, reps: 2, interval: 3 * DAY, due: now - 3_600_000, lastResult: 2 }],
      ['PIKACHU setzt DONNERSCHOCK ein!', 'PIKACHU uses THUNDERSHOCK!', { seen: 3, reps: 3, interval: 8 * DAY, due: now - 2 * DAY, lastResult: 1 }],
      ['Hallo! Willkommen in der Welt der POKéMON!', 'Hello! Welcome to the world of POKéMON!', null],
      ['Mein Name ist EICH! Man nennt mich den POKéMON-PROFESSOR!', 'My name is OAK! People call me the POKéMON PROF!', null],
      ['Du hast einen TRANK erhalten!', 'You received a POTION!', null],
      ['Beutel', 'Bag', { seen: 6, reps: 6, interval: 40 * DAY, due: now + 12 * DAY, lastResult: 2 }],
      ['KAMPF', 'FIGHT', { seen: 1, reps: 1, interval: DAY, due: now + DAY, lastResult: 2 }],
      ['Möchtest du das Spiel speichern?', 'Would you like to save the game?', { seen: 4, reps: 4, interval: 25 * DAY, due: now + 20 * DAY, lastResult: 3 }],
      ['Flucht', 'Run', { seen: 2, reps: 2, interval: 4 * DAY, due: now + 3 * DAY, lastResult: 2 }],
      ['Willst du tauschen?', '', null],
    ];
    for (const [text, translation, extra] of cards) {
      const { card } = srs.addCard({ text, translation, src: 'de', tgt: 'en', origin: 'auto' });
      if (extra) srs.importCards([{ ...card, ...extra }], { mode: 'merge' });
    }
    const counts = [12, 0, 7, 18, 4, 9, 6];
    srs.importActivity(counts.map((count, i) => ({ id: srs.todayKey(now - (6 - i) * DAY), count })).filter((a) => a.count), { mode: 'replace' });
    dict.recordCapture([
      { text: 'Ein wildes TAUBSI erscheint!', kind: 'dialog', translation: 'A wild PIDGEY appears!' },
      { text: 'Hallo! Willkommen in der Welt der POKéMON!', kind: 'dialog', translation: 'Hello! Welcome to the world of POKéMON!' },
      { text: 'KAMPF', kind: 'menu' },
      { text: 'BEUTEL', kind: 'menu' },
    ], 'de', 'en');
    const tr = { wildes: 'wild', Hallo: 'Hello', Willkommen: 'Welcome', Welt: 'world', KAMPF: 'FIGHT' };
    for (const e of dict.entries()) if (tr[e.text]) dict.setTranslation(e.id, 'en', tr[e.text]);
    await db.flush();
  });
}

// ---- scenarios ------------------------------------------------------------------

async function emptyStates(browser, base) {
  for (const [size, opts] of Object.entries(SIZES)) {
    const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openApp(page, base, 'review');
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const v of VIEWS) {
        await go(page, v);
        await axe(page, `${v} empty ${theme} ${size}`);
        if (size === 'desktop' || theme === 'dark') await shot(page, `${v}-empty-${theme}-${size}`);
      }
    }
    check(`no page errors (empty, ${size})`, errors.length === 0, errors);
    await ctx.close();
  }
}

async function populated(browser, base) {
  for (const [size, opts] of Object.entries(SIZES)) {
    const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openApp(page, base, 'review');
    await seed(page);
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const v of VIEWS) {
        await go(page, v);
        await axe(page, `${v} populated ${theme} ${size}`);
        await shot(page, `${v}-${theme}-${size}`);
      }
      // Review mid-card (answer shown), the edit form, and the finish screen.
      await go(page, 'review');
      await page.click('[data-action="start"]');
      await page.click('[data-action="reveal"]');
      await page.waitForTimeout(300); // reveal fades in
      await axe(page, `review card revealed ${theme} ${size}`);
      await shot(page, `review-card-${theme}-${size}`);
      await page.click('[data-action="end"]');
      await page.waitForTimeout(100);
      // End with nothing answered goes back to the start screen; answer one and end.
      await page.click('[data-action="start"]');
      await page.click('[data-action="reveal"]');
      await page.click('[data-q="2"]');
      await page.click('[data-action="end"]');
      await axe(page, `review finished ${theme} ${size}`);
      await shot(page, `review-done-${theme}-${size}`);
      // Deck with a row in edit mode and the menu open.
      await go(page, 'deck');
      await page.click('section[data-view="deck"] .lv-row [data-action="edit"]');
      await axe(page, `deck editing ${theme} ${size}`);
      await shot(page, `deck-editing-${theme}-${size}`);
      await page.keyboard.press('Escape');
      await page.click('section[data-view="deck"] [data-menu-trigger]');
      await axe(page, `deck menu open ${theme} ${size}`);
      await page.keyboard.press('Escape');
    }
    // Forced colours: the chart and progress must not disappear.
    if (size === 'desktop') {
      await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active' });
      await go(page, 'deck');
      await shot(page, 'deck-forced-colors');
      await page.emulateMedia({ forcedColors: 'none' });
    }
    // No horizontal scrolling at this width.
    for (const v of VIEWS) {
      await go(page, v);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${v} no horizontal scroll (${size})`, overflow <= 0, { overflow });
    }
    check(`no page errors (populated, ${size})`, errors.length === 0, errors);
    await ctx.close();
  }
}

async function keyboardReview(browser, base) {
  const ctx = await browser.newContext({ ...SIZES.desktop, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await openApp(page, base, 'review');
  await seed(page);
  await go(page, 'deck');
  await go(page, 'review');
  // Router focuses the h1 on navigation; Tab reaches Start review.
  let a = await active(page);
  check('review: heading focused after navigation', a && a.tag === 'H1', a);
  await page.keyboard.press('Tab');
  a = await active(page);
  check('review: Tab reaches Start review', a && a.action === 'start', a);
  await page.keyboard.press('Enter');
  a = await active(page);
  check('review: Enter starts, focus on Show answer', a && a.action === 'reveal', a);
  const first = await text(page, '[data-r="pos"]');
  check('review: progress text', /^Card 1 of \d+$/.test(first || ''), first);
  const total = Number(first.split(' of ')[1]);
  check('review: announcement names the card', /^Card 1 of \d+: /.test((await srStatus(page)) || ''), await text(page, '#sr-status'));
  await page.keyboard.press('Space');
  a = await active(page);
  check('review: Space shows the answer and focuses Good', a && a.q === '2', a);
  check('review: answer announced', /^Answer: /.test((await srStatus(page)) || ''), await text(page, '#sr-status'));
  await page.keyboard.press('3');
  a = await active(page);
  check('review: 3 grades Good, focus returns to Show answer', a && a.action === 'reveal' && (await text(page, '[data-r="pos"]')) === `Card 2 of ${total}`, { a, pos: await text(page, '[data-r="pos"]') });
  // Enter on the focused Show answer (native activation), then 1 = Again.
  await page.keyboard.press('Enter');
  a = await active(page);
  check('review: Enter on Show answer reveals', a && a.q === '2', a);
  await page.keyboard.press('1');
  const pos = await text(page, '[data-r="pos"]');
  check('review: Again re-queues the card (total grows)', pos === `Card 3 of ${total + 1}`, pos);
  // A held Enter must not grade the card it reveals.
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter'); // auto-repeat
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  const held = { pos: await text(page, '[data-r="pos"]'), a: await active(page) };
  check('review: held Enter reveals but does not grade', held.pos === `Card 3 of ${total + 1}` && held.a && held.a.q === '2', held);
  // A held Space pressed outside a button (the shortcut) reveals on keydown; with
  // auto-repeat Chromium would press the newly focused Good on release.
  await page.keyboard.press('3');
  const beforeSpace = await text(page, '[data-r="pos"]');
  await page.focus('section[data-view="review"] h1');
  await page.keyboard.down(' ');
  await page.keyboard.down(' '); // auto-repeat
  await page.keyboard.down(' ');
  await page.keyboard.up(' ');
  const heldSpace = { pos: await text(page, '[data-r="pos"]'), a: await active(page) };
  check('review: held Space reveals but does not grade on release', heldSpace.pos === beforeSpace && heldSpace.a && heldSpace.a.q === '2', { ...heldSpace, beforeSpace });
  // Shortcuts are listed in the help dialog.
  await page.keyboard.press('Shift+?');
  await page.waitForSelector('dialog[open]');
  const help = await text(page, 'dialog[open]');
  check('review: help dialog lists the review shortcuts', /Show answer/.test(help) && /Answer Good/.test(help) && /Listen to the card/.test(help), help);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  // Leave and come back: the session continues.
  await go(page, 'deck');
  await go(page, 'review');
  const resumed = await text(page, '[data-r="pos"]');
  check('review: session survives switching views', resumed === beforeSpace && await page.isVisible('[data-r="answer"]'), { resumed, beforeSpace });
  // Edit the translation with the keyboard.
  await page.focus('[data-r="edit-btn"]');
  await page.keyboard.press('Enter');
  a = await active(page);
  check('review: Edit focuses the input', a && a.id === 'review-edit-input', a);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Edited translation');
  await page.keyboard.press('Enter');
  a = await active(page);
  check('review: Enter saves and returns focus to Edit', a && a.action === 'edit' && (await text(page, '[data-r="back"]')) === 'Edited translation', { a, back: await text(page, '[data-r="back"]') });
  // Finish the session with 4 = Easy until done.
  for (let i = 0; i < 20 && await page.isVisible('[data-r="session"]'); i++) {
    if (!(await page.isVisible('[data-r="answer"]'))) await page.keyboard.press('Space');
    await page.keyboard.press('4');
  }
  a = await active(page);
  check('review: finish screen focused', a && a.tag === 'H2' && /Session complete/.test(a.label), a);
  const badge = await page.evaluate(() => document.querySelector('[data-badge="review"]')?.hidden);
  check('review: nav badge cleared after the session', badge === true, badge);
  await ctx.close();
}

async function keyboardLists(browser, base) {
  const ctx = await browser.newContext({ ...SIZES.desktop, colorScheme: 'light' });
  const page = await ctx.newPage();
  // Stub the translation API: "EN:<text>", one word fails.
  let calls = 0;
  await page.route(/translate\.googleapis\.com|clients5\.google\.com|mymemory/, (route) => {
    calls++;
    const u = new URL(route.request().url());
    const q = u.searchParams.get('q') || '';
    if (/^(erscheint|BEUTEL)$/.test(q)) return route.fulfill({ status: 500, body: 'nope' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([[[`EN:${q}`, q]], null, 'de']) });
  });
  await openApp(page, base, 'deck');
  await seed(page);
  await go(page, 'review');
  await go(page, 'deck');

  // Search, then delete the second row with the keyboard and undo.
  await page.focus('#deck-search');
  await page.keyboard.type('ein');
  await page.waitForTimeout(300);
  const count = await text(page, '[data-lv-count]');
  check('deck: search updates the result count', /^\d+ of 10 cards$/.test(count || ''), count);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const keys = await page.$$eval('section[data-view="deck"] .lv-row', (rows) => rows.map((r) => r.dataset.key));
  await page.focus(`.lv-row[data-key="${keys[1]}"] [data-action="delete"]`);
  await page.keyboard.press('Enter');
  let a = await active(page);
  check('deck: delete moves focus to the next row’s first button', a && a.key === keys[2], { a, expected: keys[2] });
  const toastMsg = await text(page, '.toast__message');
  check('deck: undo toast', /^Deleted “/.test(toastMsg || '') && (await text(page, '.toast__action')) === 'Undo', toastMsg);
  await page.focus('.toast__action');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  a = await active(page);
  check('deck: undo restores the card and focuses it', a && a.key === keys[1], a);
  // Ctrl+Z reaches the same Undo without tabbing to the toast.
  await page.focus(`.lv-row[data-key="${keys[1]}"] [data-action="delete"]`);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  a = await active(page);
  const restoredCount = await text(page, '[data-lv-count]');
  check('deck: Ctrl+Z undoes the delete and focuses the card', a && a.key === keys[1] && restoredCount === '10 cards', { a, restoredCount });
  // Inline edit: Escape cancels and returns focus.
  await page.focus(`.lv-row[data-key="${keys[0]}"] [data-action="edit"]`);
  await page.keyboard.press('Enter');
  a = await active(page);
  check('deck: Edit opens the inline field', a && a.tag === 'INPUT', a);
  await page.keyboard.press('Escape');
  a = await active(page);
  check('deck: Escape cancels and returns to Edit', a && a.action === 'edit' && a.key === keys[0], a);
  // Filter buttons expose state.
  await page.click('#deck-filter .segmented__option[data-value="mature"]');
  const pressed = await page.$$eval('#deck-filter .segmented__option', (b) => b.map((x) => `${x.dataset.value}:${x.getAttribute('aria-pressed')}`));
  check('deck: filter state is exposed with aria-pressed', pressed.includes('mature:true') && pressed.includes('all:false'), pressed);
  // Deep link with params (router passes them to show()).
  await page.evaluate(() => { location.hash = '#/deck?q=Beutel&filter=all'; });
  await page.waitForTimeout(300);
  const deep = { value: await page.inputValue('#deck-search'), count: await text(page, '[data-lv-count]'), all: await page.getAttribute('#deck-filter .segmented__option[data-value="all"]', 'aria-pressed') };
  check('deck: deep link #/deck?q=… sets search and filter', deep.value === 'Beutel' && /^1 of \d+ cards$/.test(deep.count || '') && deep.all === 'true', deep);

  // Dictionary: translate one pending row, then the batch.
  await go(page, 'dictionary');
  const pendingBefore = await text(page, 'section[data-view="dictionary"] .lv-stats .stat:nth-child(3) dd');
  await page.focus('section[data-view="dictionary"] .lv-row--pending [data-action="translate"]');
  const rowKey = await page.evaluate(() => document.activeElement.closest('[data-key]').dataset.key);
  await page.keyboard.press('Enter');
  await page.waitForFunction((k) => !document.querySelector(`[data-key="${k}"] [data-action="translate"]`), rowKey);
  a = await active(page);
  check('dictionary: Translate moves focus to Edit on the same row', a && a.action === 'edit' && a.key === rowKey, a);
  await page.focus('[data-action="translate-all"]');
  await page.keyboard.press('Enter');
  const busy = await page.getAttribute('[data-action="translate-all"]', 'aria-disabled');
  check('dictionary: batch button is disabled while running', busy === 'true', busy);
  await page.waitForSelector('[data-action="translate-stop"]', { state: 'detached', timeout: 20000 });
  const summary = await page.$$eval('.toast__message', (t) => t.map((x) => x.textContent).join(' | '));
  check('dictionary: batch summary reports failures', /Translated \d+ of \d+ entries\. 2 entries couldn’t be translated/.test(summary), summary);
  const pendingAfter = await text(page, 'section[data-view="dictionary"] .lv-stats .stat:nth-child(3) dd');
  check('dictionary: pending count drops', Number(pendingAfter) === 2 && Number(pendingBefore) > 2, { pendingBefore, pendingAfter });
  check('dictionary: translation API was called', calls > 0, calls);
  await axe(page, 'dictionary after batch light desktop');
  await ctx.close();
}

// ---- main -----------------------------------------------------------------------

const baseArg = arg('--base', null);
let vite = null;
let base = baseArg;
if (!base) {
  vite = await startVite();
  base = vite.base;
}
console.log(`base ${base} · screenshots in ${SHOTS}`);
const browser = await chromium.launch({ headless: !HEADED });
try {
  await emptyStates(browser, base);
  await populated(browser, base);
  await keyboardReview(browser, base);
  await keyboardLists(browser, base);
} catch (err) {
  check('run completed', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err));
} finally {
  await browser.close();
  if (vite) await vite.server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
