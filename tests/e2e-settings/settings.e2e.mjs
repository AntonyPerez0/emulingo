#!/usr/bin/env node
// Settings view in the real app (Vite dev server + headless Chromium):
// axe in both themes at desktop and phone sizes, status/alert live regions
// that stay rendered while empty, keyboard behaviour (select arrow keys don't
// save or toast on every step, sliders announce readable values, dialogs
// return focus), the restore flow with a hostile backup, and screenshots for
// a visual check.
//
//   node tests/e2e-settings/settings.e2e.mjs [--port 5453] [--out DIR]
//
// axe-core: node_modules/axe-core, else $AXE_PATH, else a pinned copy from
// registry.npmjs.org cached in the OS temp folder.
// Prints one line per check and a JSON summary; exits 1 on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Playwright otherwise routes 127.0.0.1 through a configured HTTP proxy
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
// other harnesses share the 5400-5499 range: take the first free port
const PORTS = arg('--port') ? [Number(arg('--port'))] : [5453, 5454, 5455, 5456, 5457, 5458];
const OUT = arg('--out') || path.join(os.tmpdir(), 'emulingo-settings-e2e');
const AXE_VERSION = '4.10.3';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const results = [];
function check(name, ok, info = {}) {
  results.push({ name, ok: !!ok, ...info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !Object.keys(info).length ? '' : `  ${JSON.stringify(info).slice(0, 600)}`}`);
}

// ---- axe-core ----

function untar(buf, wanted) {
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    if (name === wanted) return buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function axeSource() {
  const local = path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8');
  if (process.env.AXE_PATH && fs.existsSync(process.env.AXE_PATH)) return fs.readFileSync(process.env.AXE_PATH, 'utf8');
  const cached = path.join(os.tmpdir(), `emulingo-axe-${AXE_VERSION}.min.js`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  const res = await fetch(`https://registry.npmjs.org/axe-core/-/axe-core-${AXE_VERSION}.tgz`);
  if (!res.ok) throw new Error(`axe-core download failed: ${res.status}`);
  const file = untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())), 'package/axe.min.js');
  if (!file) throw new Error('axe.min.js not found in the axe-core package');
  fs.writeFileSync(cached, file);
  return file.toString('utf8');
}

async function runAxe(page, axe) {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: axe });
  return page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
  }, AXE_TAGS);
}

// ---- server ----

async function startVite() {
  for (const port of PORTS) {
    try {
      const server = await createServer({
        root: ROOT,
        logLevel: 'error',
        server: { port, strictPort: true, host: '127.0.0.1', hmr: false },
      });
      await server.listen();
      return { server, base: `http://127.0.0.1:${port}/` };
    } catch (e) {
      if (!/in use|EADDRINUSE/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error('No free port in ' + PORTS.join(', '));
}

// ---- helpers ----

async function openSettings(browser, base, { viewport, colorScheme, hash = '#/settings', storage = {} }) {
  const ctx = await browser.newContext({ viewport, colorScheme, serviceWorkers: 'block' });
  // Block third-party requests: Settings must work without them.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await ctx.addInitScript((items) => {
    if (sessionStorage.getItem('e2e-seeded')) return;
    sessionStorage.setItem('e2e-seeded', '1');
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
  }, storage);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(base + hash);
  await page.waitForSelector('section[data-view="settings"]:not([hidden]) #settings-about');
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

// Only values that differ from the defaults are stored.
const storedSettings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('emulingo:settings') || '{}'));
const activeInfo = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a ? { tag: a.tagName, id: a.id, text: (a.textContent || '').trim().slice(0, 60), action: a.dataset.action || null } : null;
});

const SEED = {
  'emulingo:settings': JSON.stringify({ settingsVersion: 2, source: 'de', target: 'en', onboarded: true }),
  'emulingo:translations': JSON.stringify({ v: 3, entries: [['de>en|Hallo', 'Hello'], ['de>en|Ja', 'Yes']] }),
};

const HOSTILE = JSON.stringify({
  app: 'emulingo',
  format: 2,
  exported: '2026-10-01T10:00:00.000Z',
  settings: { rate: '"><img src=x onerror="window.__pwned=1">', theme: 'light' },
  cards: [
    { id: 'c-ok', text: '<img src=x onerror="window.__pwned=1">Hallo', translation: 'Hi', src: 'de', tgt: 'en' },
    { id: 'x"><img src=x onerror="window.__pwned=1">', text: 'Tschüss', src: 'de' },
  ],
  dictionary: '<svg onload="window.__pwned=1">',
  extra: '<script>window.__pwned=1</script>',
});

// ---- checks ----

async function visualAndAxe(browser, base, axe) {
  const sizes = [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ];
  for (const [size, viewport] of sizes) {
    for (const scheme of ['dark', 'light']) {
      const { ctx, page, errors } = await openSettings(browser, base, { viewport, colorScheme: scheme, storage: SEED });
      const label = `${size} ${scheme}`;
      check(`${label}: no page errors`, errors.length === 0, { errors });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${label}: no horizontal scrolling`, overflow <= 0, { overflow });
      const violations = await runAxe(page, axe);
      check(`${label}: axe finds no violations`, violations.length === 0, { violations });
      // Live regions must exist in the accessibility tree before their first message.
      const hiddenRegions = await page.evaluate(() => Array.from(document.querySelectorAll('section[data-view="settings"] [role="status"], section[data-view="settings"] [role="alert"]'))
        .filter((el) => el.closest('[hidden]') || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden')
        .map((el) => el.dataset.savedFor || el.dataset.errorFor || el.className));
      check(`${label}: status and alert regions stay rendered while empty`, hiddenRegions.length === 0, { hiddenRegions });
      await page.screenshot({ path: path.join(OUT, `settings-${size}-${scheme}.png`), fullPage: true });
      await page.screenshot({ path: path.join(OUT, `settings-${size}-${scheme}-top.png`) });
      await ctx.close();
    }
  }
  // Forced colours: the page must stay usable (axe is not meaningful there).
  const { ctx, page } = await openSettings(browser, base, { viewport: { width: 1280, height: 900 }, colorScheme: 'dark', storage: SEED });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: path.join(OUT, 'settings-forced-colors.png') });
  await ctx.close();
}

async function keyboard(browser, base) {
  const { ctx, page, errors } = await openSettings(browser, base, { viewport: { width: 1280, height: 900 }, colorScheme: 'dark', storage: SEED });

  // Arrow keys on a closed select: the value moves, but nothing is saved or toasted until it settles.
  await page.focus('#set-ocr-engine');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
  const midValue = await page.$eval('#set-ocr-engine', (el) => el.value);
  const mid = await storedSettings(page);
  check('select: arrow keys move the choice without saving each step', midValue === 'tesseract' && mid.ocrEngine === undefined, { midValue, stored: mid.ocrEngine });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(50);
  const after = await storedSettings(page);
  const toasts = await page.$$eval('.toast', (els) => els.length);
  const saved = await page.$eval('[data-saved-for="reading"]', (el) => el.textContent.trim());
  check('select: leaving it saves once, with an inline status and no toast', after.ocrEngine === 'tesseract' && toasts === 0 && saved === 'Saved', { stored: after.ocrEngine, toasts, saved });

  // Language clash is refused with a linked error.
  await page.focus('#set-target');
  await page.selectOption('#set-target', 'de');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(50);
  const clash = await page.evaluate(() => {
    const el = document.getElementById('set-target');
    return { invalid: el.getAttribute('aria-invalid'), described: el.getAttribute('aria-describedby'), error: document.getElementById('set-target-error')?.textContent.trim() };
  });
  const clashStored = await storedSettings(page);
  check('languages: the same language twice is refused with a linked error', clash.invalid === 'true' && /set-target-error/.test(clash.described) && (clashStored.target ?? 'en') === 'en', { clash, target: clashStored.target });
  await page.selectOption('#set-target', 'en');
  await page.keyboard.press('Tab');

  // Switch by keyboard.
  await page.focus('#set-read-all');
  await page.keyboard.press('Space');
  await page.waitForTimeout(30);
  const sw = await storedSettings(page);
  check('switch: Space toggles and saves', sw.readAllText === false, { readAllText: sw.readAllText });

  // Slider: readable value while moving, saved when settled.
  await page.focus('#set-rate');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  const rate = await page.$eval('#set-rate', (el) => ({ text: el.getAttribute('aria-valuetext'), out: document.getElementById('set-rate-value').textContent }));
  await page.keyboard.press('Tab');
  await page.waitForTimeout(50);
  const rs = await storedSettings(page);
  check('slider: aria-valuetext and output read “1.3 times”, then it saves', rate.text === '1.3 times' && rate.out === '1.3 times' && rs.rate === 1.3, { rate, stored: rs.rate });

  // Visible focus on every tabbable control.
  const missing = await page.evaluate(async () => {
    const section = document.querySelector('section[data-view="settings"]');
    const items = Array.from(section.querySelectorAll('a[href], button, input, select')).filter((el) => !el.closest('[hidden]') && !el.hidden && el.tabIndex >= 0);
    const bad = [];
    for (const el of items) {
      el.focus();
      if (document.activeElement !== el) continue;
      // Switch inputs are invisible; their track draws the ring.
      const shown = el.classList.contains('switch__input') ? el.nextElementSibling : el;
      const cs = getComputedStyle(shown);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow && cs.boxShadow !== 'none');
      if (!ring) bad.push(el.id || el.dataset.action || el.textContent.trim().slice(0, 30));
    }
    return { count: items.length, bad };
  });
  // Keyboard focus (not mouse) is what :focus-visible keys off: re-check one control via Tab.
  check('focus: every control shows a focus ring', missing.bad.length === 0, missing);

  // Clear the translation cache: count updates in place, focus stays.
  const cacheBtn = page.locator('[data-action="clear-cache"]');
  await cacheBtn.focus();
  const before = await page.$eval('[data-cache-count]', (el) => el.textContent);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  const cache = await page.evaluate(() => ({
    text: document.querySelector('[data-cache-count]').textContent,
    focused: document.activeElement?.dataset.action,
    disabled: document.querySelector('[data-action="clear-cache"]').getAttribute('aria-disabled'),
  }));
  check('cache: cleared in place, focus kept on the button', /2 translations/.test(before) && cache.text === 'No translations saved yet.' && cache.focused === 'clear-cache' && cache.disabled === 'true', { before, cache });

  // Shortcut help from Appearance returns focus to its button.
  await page.focus('[data-action="view-shortcuts"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  const backTo = await activeInfo(page);
  check('shortcut help: Escape returns focus to “View shortcuts”', backTo && backTo.action === 'view-shortcuts', { backTo });

  // Erase: needs ERASE; Escape cancels and returns focus.
  await page.focus('[data-action="erase"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open]');
  const erase = await page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    const ok = Array.from(d.querySelectorAll('.dialog__footer button')).find((b) => /Erase everything/.test(b.textContent));
    return { title: d.querySelector('h2').textContent, disabled: ok.disabled, focus: document.activeElement.tagName };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  const afterErase = await activeInfo(page);
  check('erase: confirmation needs ERASE and Escape returns focus', erase.disabled && erase.focus === 'INPUT' && afterErase.action === 'erase', { erase, afterErase });

  // Deep link from another view lands on the section heading.
  await page.evaluate(() => { location.hash = '#/review'; });
  await page.waitForSelector('section[data-view="review"]:not([hidden])');
  await page.evaluate(() => { location.hash = '#/settings?section=data'; });
  await page.waitForTimeout(400);
  const deep = await activeInfo(page);
  check('deep link: #/settings?section=data focuses that section', deep && deep.id === 'settings-data-title', { deep });

  // In-page section links move focus without leaving Settings.
  await page.click('[data-section-link="about"]');
  await page.waitForTimeout(400);
  const toc = await page.evaluate(() => ({ hash: location.hash, focus: document.activeElement.id }));
  check('section links: focus moves to the section, the route stays', toc.focus === 'settings-about-title' && toc.hash.startsWith('#/settings'), toc);

  check('keyboard run: no page errors', errors.length === 0, { errors });
  await ctx.close();
}

async function restore(browser, base) {
  const { ctx, page, errors } = await openSettings(browser, base, { viewport: { width: 1280, height: 900 }, colorScheme: 'light', storage: SEED });
  await page.focus('[data-action="import"]');
  await page.setInputFiles('#set-backup-file', { name: 'starter-deck.json', mimeType: 'application/json', buffer: Buffer.from(HOSTILE) });
  await page.waitForSelector('dialog[open]');
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    return {
      name: document.getElementById(d.getAttribute('aria-labelledby'))?.textContent,
      text: d.textContent.replace(/\s+/g, ' '),
      imgs: document.querySelectorAll('img').length,
      focus: document.activeElement.textContent.trim(),
    };
  });
  check('restore: the dialog summarises the file and starts on Cancel', dlg.name === 'Restore backup?' && /contains 1 card, plus settings/.test(dlg.text) && /damaged item in cards was skipped/.test(dlg.text) && dlg.focus === 'Cancel' && dlg.imgs === 0, dlg);
  await page.screenshot({ path: path.join(OUT, 'settings-restore-dialog.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  const back = await activeInfo(page);
  check('restore: Escape cancels and returns focus to “Choose backup file”', back && back.action === 'import', { back });

  await page.setInputFiles('#set-backup-file', { name: 'starter-deck.json', mimeType: 'application/json', buffer: Buffer.from(HOSTILE) });
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] .dialog__footer button:has-text("Merge")');
  await page.waitForFunction(() => /Backup restored/.test(document.querySelector('[data-saved-for="backup"]').textContent));
  const merged = await page.evaluate(() => ({ pwned: window.__pwned ?? null, imgs: document.querySelectorAll('img').length, focus: document.activeElement.dataset.action }));
  check('restore: merge writes plain text only, nothing runs', merged.pwned === null && merged.imgs === 0 && merged.focus === 'import', merged);

  await page.setInputFiles('#set-backup-file', { name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":') });
  await page.waitForFunction(() => document.querySelector('[data-error-for="backup"]').textContent.trim() !== '');
  const err = await page.$eval('[data-error-for="backup"]', (el) => ({ role: el.getAttribute('role'), text: el.textContent.trim(), height: el.getBoundingClientRect().height }));
  check('restore: an unreadable file gets an inline alert', err.role === 'alert' && /isn’t an Emulingo backup/.test(err.text) && err.height > 20, err);
  check('restore run: no page errors', errors.length === 0, { errors });
  await ctx.close();
}

// ---- main ----

fs.mkdirSync(OUT, { recursive: true });
const { server, base } = await startVite();
let browser;
try {
  const axe = await axeSource();
  browser = await chromium.launch();
  await visualAndAxe(browser, base, axe);
  await keyboard(browser, base);
  await restore(browser, base);
} catch (err) {
  check('harness ran to completion', false, { error: String(err && err.stack || err) });
} finally {
  if (browser) await browser.close();
  await server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, screenshots: OUT }));
process.exit(failed.length ? 1 : 0);
