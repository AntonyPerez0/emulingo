#!/usr/bin/env node
// Fetch EmulatorJS 4.2.3 + the GB/GBC (gambatte) and GBA (mgba) cores from the
// npm registry and lay them out exactly like https://cdn.emulatorjs.org/stable/data/
// under bench/.cache/emulatorjs/ so the e2e harness can serve the CDN locally
// (cdn.emulatorjs.org is unreachable from the sandbox).
//
//   node bench/e2e/setup.mjs            # idempotent: no-op when already done
//   node bench/e2e/setup.mjs --force    # rebuild the layout
//
// Layout produced (mirrors the CDN 'stable/data' folder):
//   loader.js  version.json  emulator.css  emulator.min.css  emulator.min.js
//   src/*.js                         (non-minified fallbacks loader.js knows about)
//   compression/{extract7z,extractzip,libunrar}.js libunrar.wasm
//   localization/*.json
//   cores/<core>[-thread][-legacy]-wasm.data  cores/reports/<core>.json
//
// The npm package of @emulatorjs/emulatorjs ships no emulator.min.js/css (the
// CDN builds them). loader.js would fall back to src/* after a 404 + console
// errors, so we build emulator.min.js as the concatenation of the exact script
// list loader.js uses (same global scope semantics as separate classic
// scripts) and emulator.min.css as a copy of emulator.css.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(ROOT, 'bench', '.cache');
const PKGS_DIR = path.join(CACHE, 'pkgs');
export const EJS_DIR = path.join(CACHE, 'emulatorjs');

export const EJS_VERSION = '4.2.3';
const PACKAGES = [
  ['@emulatorjs/emulatorjs', EJS_VERSION],
  ['@emulatorjs/core-gambatte', EJS_VERSION], // gb / gbc
  ['@emulatorjs/core-mgba', EJS_VERSION]      // gba
];
// order taken verbatim from data/loader.js
const LOADER_SCRIPTS = ['emulator.js', 'nipplejs.js', 'shaders.js', 'storage.js', 'gamepad.js', 'GameManager.js', 'socket.io.min.js', 'compression.js'];
const MARKER = path.join(EJS_DIR, '.setup.json');

function tgzName(name, ver) {
  return name.replace(/^@/, '').replace('/', '-') + '-' + ver + '.tgz';
}

function fetchPackage(name, ver) {
  fs.mkdirSync(PKGS_DIR, { recursive: true });
  const tgz = path.join(PKGS_DIR, tgzName(name, ver));
  if (!fs.existsSync(tgz)) {
    console.log(`npm pack ${name}@${ver}`);
    // npm pack verifies the registry integrity hash for us
    execFileSync('npm', ['pack', `${name}@${ver}`, '--pack-destination', PKGS_DIR, '--silent'], { stdio: ['ignore', 'pipe', 'inherit'] });
  }
  const dir = path.join(PKGS_DIR, 'x-' + tgzName(name, ver).replace(/\.tgz$/, ''));
  if (!fs.existsSync(path.join(dir, 'package', 'package.json'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  }
  return path.join(dir, 'package');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function expectedFiles() {
  return [
    'loader.js', 'version.json', 'emulator.min.js', 'emulator.min.css', 'emulator.css',
    'compression/extract7z.js', 'compression/extractzip.js', 'compression/libunrar.js', 'compression/libunrar.wasm',
    'localization/en-US.json',
    'cores/gambatte-wasm.data', 'cores/gambatte-legacy-wasm.data', 'cores/reports/gambatte.json',
    'cores/mgba-wasm.data', 'cores/mgba-legacy-wasm.data', 'cores/reports/mgba.json'
  ];
}

export function isSetUp() {
  try {
    const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    if (m.version !== EJS_VERSION) return false;
    return expectedFiles().every((f) => fs.existsSync(path.join(EJS_DIR, f)));
  } catch { return false; }
}

export function setup({ force = false } = {}) {
  if (!force && isSetUp()) {
    console.log(`EmulatorJS ${EJS_VERSION} already laid out in ${path.relative(ROOT, EJS_DIR)}/`);
    return EJS_DIR;
  }
  const [ejsPkg, ...corePkgs] = PACKAGES.map(([n, v]) => fetchPackage(n, v));
  fs.rmSync(EJS_DIR, { recursive: true, force: true });
  fs.mkdirSync(EJS_DIR, { recursive: true });

  const data = path.join(ejsPkg, 'data');
  for (const f of ['loader.js', 'version.json', 'emulator.css']) fs.copyFileSync(path.join(data, f), path.join(EJS_DIR, f));
  copyDir(path.join(data, 'src'), path.join(EJS_DIR, 'src'));
  copyDir(path.join(data, 'compression'), path.join(EJS_DIR, 'compression'));
  copyDir(path.join(data, 'localization'), path.join(EJS_DIR, 'localization'));

  // emulator.min.js / .min.css as the CDN would serve them
  const js = LOADER_SCRIPTS.map((f) => `/* ---- ${f} ---- */\n` + fs.readFileSync(path.join(data, 'src', f), 'utf8')).join('\n;\n');
  fs.writeFileSync(path.join(EJS_DIR, 'emulator.min.js'), js);
  fs.copyFileSync(path.join(data, 'emulator.css'), path.join(EJS_DIR, 'emulator.min.css'));

  const coresDir = path.join(EJS_DIR, 'cores');
  fs.mkdirSync(path.join(coresDir, 'reports'), { recursive: true });
  for (const pkg of corePkgs) {
    for (const f of fs.readdirSync(pkg)) {
      if (f.endsWith('-wasm.data')) fs.copyFileSync(path.join(pkg, f), path.join(coresDir, f));
    }
    for (const f of fs.readdirSync(path.join(pkg, 'reports'))) {
      fs.copyFileSync(path.join(pkg, 'reports', f), path.join(coresDir, 'reports', f));
    }
  }
  const missing = expectedFiles().filter((f) => !fs.existsSync(path.join(EJS_DIR, f)));
  if (missing.length) throw new Error('EmulatorJS layout incomplete, missing: ' + missing.join(', '));
  fs.writeFileSync(MARKER, JSON.stringify({ version: EJS_VERSION, packages: PACKAGES, builtAt: new Date().toISOString() }, null, 2));
  console.log(`EmulatorJS ${EJS_VERSION} laid out in ${path.relative(ROOT, EJS_DIR)}/`);
  return EJS_DIR;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup({ force: process.argv.includes('--force') });
}
