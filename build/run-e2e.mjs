#!/usr/bin/env node
// Runs the browser end-to-end suites one after another (each starts its own
// server on a free port in 5400–5499 and headless Chromium), then prints a
// summary. Exits 1 if any suite fails.
//
//   npm run test:e2e                       # every suite
//   npm run test:e2e -- --only emu,play    # a subset
//   npm run test:e2e -- --skip learn --bail
//
// The emulator suites need EmulatorJS 4.2.3 laid out under bench/.cache
// (downloaded from the npm registry once by bench/e2e/setup.mjs, run here
// first). Translation checks reach the real Google endpoint (through
// $HTTPS_PROXY when set).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SUITES = [
  { id: 'pwa', files: ['build/smoke.mjs'], emulator: true, about: 'production build: CSP, service worker, offline start, real game + OCR' },
  { id: 'emu', files: ['tests/e2e-emu/emu.e2e.mjs'], emulator: true, about: 'emulator integration, saves, ROM import' },
  { id: 'capture', files: ['tests/e2e-capture/emulator.mjs', 'tests/e2e-capture/perf.mjs'], emulator: true, about: 'pixel-exact frame capture' },
  { id: 'engine', files: ['tests/e2e-engine/run.mjs'], about: 'OCR engine in its worker (production build)' },
  { id: 'learn', files: ['tests/e2e-learn/learn.e2e.mjs'], about: 'Review, Deck and Dictionary views' },
  { id: 'settings', files: ['tests/e2e-settings/settings.e2e.mjs'], about: 'Settings view' },
  { id: 'play', files: ['tests/e2e-play/play.e2e.mjs'], emulator: true, about: 'Play view with the real emulator' },
];

function parseList(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? new Set(argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean)) : null;
}

function run(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, stdio: 'inherit', env });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main(argv = process.argv.slice(2)) {
  const only = parseList(argv, '--only');
  const skip = parseList(argv, '--skip') || new Set();
  const bail = argv.includes('--bail');
  const unknown = [...(only || []), ...skip].filter((id) => !SUITES.some((s) => s.id === id));
  if (unknown.length) {
    console.error(`Unknown suite: ${unknown.join(', ')}. Suites: ${SUITES.map((s) => s.id).join(', ')}`);
    return 2;
  }
  const chosen = SUITES.filter((s) => (!only || only.has(s.id)) && !skip.has(s.id));
  // Playwright otherwise sends 127.0.0.1 through a configured HTTP proxy
  const env = { ...process.env, PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: '1' };
  const results = [];

  if (chosen.some((s) => s.emulator)) {
    console.log('\n=== setup: EmulatorJS 4.2.3 for the emulator suites');
    if ((await run('bench/e2e/setup.mjs', env)) !== 0) {
      console.error('Could not lay out EmulatorJS (bench/e2e/setup.mjs).');
      return 1;
    }
  }

  for (const suite of chosen) {
    const missing = suite.files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) {
      results.push({ id: suite.id, status: 'missing', ms: 0, note: missing.join(', ') });
      continue;
    }
    console.log(`\n=== ${suite.id}: ${suite.about}`);
    const t0 = Date.now();
    let code = 0;
    for (const file of suite.files) {
      code = await run(file, env);
      if (code !== 0) break;
    }
    results.push({ id: suite.id, status: code === 0 ? 'passed' : 'FAILED', ms: Date.now() - t0 });
    if (code !== 0 && bail) break;
  }

  console.log('\n=== summary');
  for (const r of results) {
    console.log(`${r.status.padEnd(8)} ${r.id.padEnd(9)} ${(r.ms / 1000).toFixed(1).padStart(6)} s${r.note ? `  (${r.note})` : ''}`);
  }
  const failed = results.filter((r) => r.status !== 'passed');
  console.log(failed.length ? `\n${failed.length} of ${results.length} suites did not pass.` : `\nAll ${results.length} suites passed.`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
