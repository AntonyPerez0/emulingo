#!/usr/bin/env node
// OCR benchmark runner.
//
//   npm run bench:ocr -- [--adapter a,b|all] [--scene f1,f2] [--variant v1,v2|all]
//                        [--no-spell] [--timeout 90] [--headed] [--frames]
//                        [--examples 15] [--list]
//
// Starts Vite (repo root) + headless Chromium, serves every CDN dependency
// from node_modules (bench/lib/routes.mjs), runs each adapter over
// scenes x variants in bench/bench.html and writes
//   bench/results/<adapter>.json (+ <adapter>+spell.json)
//   bench/results/summary.md
// Exit code 1 when an adapter fails to load/initialise, a run errors, or the
// app requested a CDN URL with no local equivalent.

import fs from 'node:fs';
import path from 'node:path';
import { startHarness, REPO_ROOT } from './lib/server.mjs';
import { scoreRun } from './metrics.js';
import { allTables, renderText, renderMarkdown, pct } from './lib/report.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, def) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
  process.exit(0);
}

const outDir = path.resolve(opt('out', path.join(REPO_ROOT, 'bench', 'results')));
const timeoutMs = Number(opt('timeout', '90')) * 1000;
const spell = !flag('no-spell');
const examples = Number(opt('examples', '15'));
const log = (...a) => console.log(...a);
const t0 = Date.now();

const splitList = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const matches = (id, filters) => !filters.length || filters.some((f) => (f.startsWith('/') && f.endsWith('/') ? new RegExp(f.slice(1, -1)).test(id) : id.includes(f)));

function pkgVersions() {
  const out = {};
  for (const p of ['@paddleocr/paddleocr-js', 'onnxruntime-web', '@techstark/opencv-js', 'tesseract.js', 'tesseract.js-core', 'nspell', 'dictionary-en', 'dictionary-de', 'dictionary-fr', 'dictionary-es', 'vite', 'playwright']) {
    try { out[p] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'node_modules', p, 'package.json'), 'utf8')).version; } catch { out[p] = null; }
  }
  return out;
}

const harness = await startHarness({ entries: ['bench/bench.html'], log });
let failed = false;
const pageErrors = [];

async function openPage() {
  const page = await harness.context.newPage();
  page.on('pageerror', (e) => { pageErrors.push(String(e.stack || e.message)); log('[pageerror]', e.message); });
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' && !/CleanUnusedInitializersAndNodeArgs|Failed to create WebGPU|WebGPU is experimental/.test(text)) {
      pageErrors.push(text.slice(0, 500));
      if (process.env.BENCH_VERBOSE) log('[console.error]', text.slice(0, 300));
    }
  });
  await page.goto(harness.origin + '/bench/bench.html?headless=1', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.bench && window.bench.ready, null, { timeout: 120000 });
  return page;
}

function withTimeout(p, ms, label) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(timer));
}

try {
  let page = await openPage();
  const loadErrors = await page.evaluate(() => window.bench.adapterLoadErrors());
  for (const [file, err] of Object.entries(loadErrors)) { failed = true; log(`[bench] ADAPTER LOAD FAILED ${file}\n${err}`); }
  const allAdapters = await page.evaluate(() => window.bench.adapters());
  const scenes = await page.evaluate(() => window.bench.scenes());
  const variants = await page.evaluate(() => window.bench.variants());
  const defaultVariants = await page.evaluate(() => window.bench.defaultVariants());
  const longTaskSupported = await page.evaluate(() => window.bench.longTaskSupported);
  const browserVersion = harness.browser.version();

  if (flag('list')) {
    log('adapters:', allAdapters.map((a) => `${a.name}${a.spell ? ' (+spell)' : ''}`).join(', '));
    log('variants:', variants.map((v) => v.id).join(', '), '(default:', defaultVariants.join(', ') + ')');
    log('scenes:'); for (const s of scenes) log('  ' + s.id.padEnd(28), s.platform, s.lang, s.frameKind, s.partial ? 'partial' : '');
  } else {
    const wantAdapters = splitList(opt('adapter', 'all'));
    const adapters = wantAdapters.includes('all') ? allAdapters : allAdapters.filter((a) => wantAdapters.includes(a.name));
    for (const w of wantAdapters) if (w !== 'all' && !allAdapters.some((a) => a.name === w)) { failed = true; log(`[bench] unknown adapter "${w}"`); }
    const sceneFilter = splitList(opt('scene', ''));
    const selScenes = scenes.filter((s) => matches(s.id, sceneFilter));
    const variantArg = opt('variant', '');
    const selVariants = variantArg === 'all' ? variants.map((v) => v.id)
      : variantArg ? variants.map((v) => v.id).filter((id) => matches(id, splitList(variantArg))) : defaultVariants;
    if (!selScenes.length || !selVariants.length || !adapters.length) throw new Error('nothing to run (check --adapter/--scene/--variant)');
    log(`[bench] ${adapters.length} adapter(s) x ${selScenes.length} scenes x ${selVariants.length} variants (${selVariants.join(', ')}); spell flavour: ${spell ? 'on' : 'off'}; longtask API: ${longTaskSupported}`);

    if (flag('frames')) {
      const dir = path.join(outDir, 'frames');
      fs.mkdirSync(dir, { recursive: true });
      for (const s of selScenes) {
        const url = await page.evaluate(([id]) => window.bench.frameDataUrl(id, 'native', 3), [s.id]);
        fs.writeFileSync(path.join(dir, s.id + '.png'), Buffer.from(url.split(',')[1], 'base64'));
      }
      log(`[bench] wrote ${selScenes.length} native frames (3x) to ${path.relative(process.cwd(), dir)}`);
    }

    // group by language so engines that are per-language (Tesseract) switch rarely
    const ordered = [...selScenes].sort((a, b) => a.lang.localeCompare(b.lang));
    const sceneMap = Object.fromEntries(selScenes.map((s) => [s.id, s]));
    const docs = [];

    for (const ad of adapters) {
      await page.close().catch(() => {});
      page = await openPage();
      const runs = [], spellRuns = [], inits = [];
      let currentLang = null;
      let initError = null;
      const initFor = async (lang) => {
        const res = await withTimeout(page.evaluate(([n, l, sp]) => window.bench.init(n, l, { spell: sp }), [ad.name, lang, spell]), Math.max(timeoutMs, 180000), `init ${ad.name}/${lang}`)
          .catch((e) => ({ adapter: ad.name, lang, error: String(e.message || e) }));
        inits.push(res);
        if (res.error) {
          failed = true;
          log(`\n[bench] *** ${ad.name} INIT FAILED for lang=${lang} ***\n${res.error}\n`);
        } else {
          log(`[bench] ${ad.name} init lang=${lang}: ${Math.round(res.initMs)} ms (max long task ${Math.round(res.maxLongTaskMs)} ms)${res.spellNote ? '; ' + res.spellNote : ''}${res.spellWarmMs != null ? ` (${Math.round(res.spellWarmMs)} ms)` : ''}`);
        }
        return res.error || null;
      };
      for (const s of ordered) {
        if (s.lang !== currentLang) { currentLang = s.lang; initError = await initFor(s.lang); }
        for (const v of selVariants) {
          let r;
          if (initError) {
            r = { adapter: ad.name, scene: s.id, variant: v, regions: [], error: 'init failed: ' + initError.split('\n')[0] };
          } else {
            try {
              r = await withTimeout(page.evaluate(([n, sc, va, sp]) => window.bench.run(n, sc, va, { spell: sp }), [ad.name, s.id, v, spell]), timeoutMs, `run ${s.id}/${v}`);
            } catch (e) {
              r = { adapter: ad.name, scene: s.id, variant: v, regions: [], error: String(e.message || e) };
              log(`[bench] ${r.error} - reloading page and re-initialising`);
              await page.close().catch(() => {});
              page = await openPage();
              initError = await initFor(s.lang);
            }
          }
          if (r.error) failed = true;
          const base = {
            scene: s.id, variant: v, platform: s.platform, lang: s.lang, frameKind: s.frameKind, partial: s.partial,
            latencyMs: r.latencyMs ?? null, maxLongTaskMs: r.maxLongTaskMs ?? null, totalBlockingMs: r.totalBlockingMs ?? null,
            error: r.error || null, debug: r.debug || null
          };
          const run = { ...base, truth: s, regions: r.regions || [], metrics: r.error ? null : scoreRun(s, r.regions) };
          runs.push(run);
          if (spell && ad.spell) {
            const sp = r.spell;
            if (sp && sp.error) failed = true;
            spellRuns.push({
              ...base,
              truth: s,
              regions: sp ? sp.regions : (r.regions || []),
              latencyMs: r.latencyMs != null ? r.latencyMs + (sp ? sp.ms : 0) : null,
              spellMs: sp ? sp.ms : null,
              maxLongTaskMs: Math.max(r.maxLongTaskMs || 0, sp ? sp.maxLongTaskMs : 0),
              totalBlockingMs: (r.totalBlockingMs || 0) + (sp ? sp.totalBlockingMs : 0),
              error: r.error || (sp && sp.error) || null,
              metrics: r.error ? null : scoreRun(s, sp ? sp.regions : r.regions)
            });
          }
          const m = run.metrics;
          const got = r.error ? 'ERROR ' + r.error.split('\n')[0].slice(0, 90) : (r.regions || []).map((x) => x.text).join(' | ').slice(0, 90);
          log(`  ${ad.name.padEnd(17)} ${s.id.padEnd(26)} ${v.padEnd(23)} ${String(Math.round(r.latencyMs || 0)).padStart(6)}ms  ` +
            `${m ? (s.regions.length ? 'CER ' + pct(m.cerCI).padStart(6) : 'FP ' + String(m.outRegions).padStart(3)) : '      '}  ${got}`);
        }
      }
      const strip = (rs) => rs.map(({ truth, ...rest }) => rest);
      const meta = {
        generatedAt: new Date().toISOString(),
        browser: 'chromium ' + browserVersion,
        node: process.version,
        longTaskSupported,
        variants: selVariants,
        packages: pkgVersions()
      };
      docs.push({ adapter: ad.name, flavour: ad.name, description: ad.description, meta, init: inits, scenes: sceneMap, runs });
      if (spell && ad.spell) docs.push({ adapter: ad.name, flavour: ad.name + '+spell', description: ad.description + ' + correctOcrText (4 s timeout)', meta, init: inits, scenes: sceneMap, runs: spellRuns });
      fs.mkdirSync(outDir, { recursive: true });
      for (const d of docs.filter((x) => x.adapter === ad.name)) {
        const file = path.join(outDir, d.flavour + '.json');
        fs.writeFileSync(file, JSON.stringify({ ...d, runs: strip(d.runs), routes: { warnings: harness.router.stats.warnings, missing: harness.router.stats.missing, tessdata: harness.router.stats.tessdata } }, null, 1));
        log(`[bench] wrote ${path.relative(process.cwd(), file)}`);
      }
    }

    const tables = allTables(docs, { examples });
    log('\n' + tables.map(renderText).join('\n\n'));
    const md = [`# OCR bench summary`, '', `Generated ${new Date().toISOString()} - chromium ${browserVersion}, variants: ${selVariants.join(', ')}`, '', ...tables.map(renderMarkdown)].join('\n');
    fs.writeFileSync(path.join(outDir, 'summary.md'), md);

    const st = harness.router.stats;
    log(`\n[routes] served ${st.served.length} CDN requests locally; tessdata: ${JSON.stringify(st.tessdata)}`);
    for (const w of st.warnings) log('[routes] warning: ' + w);
    if (st.missing.length) { failed = true; log('[routes] UNSERVED CDN URLs (404):\n  ' + [...new Set(st.missing)].join('\n  ')); }
    if (pageErrors.length) log(`[bench] ${pageErrors.length} page errors/console errors (first: ${pageErrors[0].split('\n')[0].slice(0, 200)})`);
    log(`[bench] done in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${path.relative(process.cwd(), outDir)}/summary.md`);
  }
} catch (e) {
  failed = true;
  console.error('[bench] FATAL', e);
} finally {
  await harness.close();
}
process.exit(failed ? 1 : 0);
