#!/usr/bin/env node
// Re-render the bench tables from saved results without re-running OCR.
//
//   npm run bench:report -- [--md] [--examples 15] [file.json ...]
//
// Defaults to every bench/results/*.json. --md prints Markdown.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRun } from './metrics.js';
import { allTables, renderText, renderMarkdown } from './lib/report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const md = args.includes('--md');
const ei = args.indexOf('--examples');
const examples = ei >= 0 ? Number(args[ei + 1]) : 15;
let files = args.filter((a, i) => a.endsWith('.json') && args[i - 1] !== '--examples');
if (!files.length) {
  const dir = path.join(here, 'results');
  files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f)) : [];
}
if (!files.length) { console.error('no results - run `npm run bench:ocr` first'); process.exit(1); }

const docs = files.map((f) => {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  // re-score from the stored outputs so metric changes apply retroactively
  d.runs = d.runs.map((r) => ({ ...r, truth: d.scenes[r.scene], metrics: r.error ? null : scoreRun(d.scenes[r.scene], r.regions) }));
  return d;
});
const tables = allTables(docs, { examples });
console.log(tables.map(md ? renderMarkdown : renderText).join('\n\n'));
