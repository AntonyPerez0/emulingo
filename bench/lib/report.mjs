// Tables for bench results (console text + Markdown). Shared by run.mjs and
// report.mjs.

import { aggregate, aggregateByKind, groupBy } from '../metrics.js';

export const pct = (x) => (x == null || !Number.isFinite(x) ? '-' : (x * 100).toFixed(1) + '%');
export const ms = (x) => (x == null || !Number.isFinite(x) ? '-' : Math.round(x).toString());
const num = (x, d = 1) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(d));

function aggRow(label, runs, extra = []) {
  const a = aggregate(runs);
  return [
    label, ...extra,
    pct(a.cer), pct(a.cerCI), pct(a.frameCerCI), pct(a.lineExactCS),
    pct(a.wordRecall), pct(a.wordPrecision),
    a.textRuns ? `${num(a.regionsOut / a.textRuns)}/${num(a.regionsExpected / a.textRuns)}` : '-',
    pct(a.regionCountExact),
    a.textRuns ? num(a.junkRegions / a.textRuns, 2) : '-',
    a.noTextRuns ? `${a.fpRegions} in ${a.fpRuns}/${a.noTextRuns}` : '-',
    ms(a.latencyMean), ms(a.latencyP95), ms(a.longTaskMax), ms(a.tbtMean),
    String(a.errors)
  ];
}
const AGG_COLS = ['CER', 'CER ci', 'frame CER ci', 'lines exact', 'word R', 'word P', 'regions out/exp', 'region count ok', 'junk/run', 'FP (no-text)', 'ms mean', 'ms p95', 'max long task', 'TBT mean', 'errors'];

export function summaryTable(docs) {
  return {
    title: 'Overall (all scenes x variants; CER over text scenes, partial frames included)',
    columns: ['adapter', 'init ms', ...AGG_COLS],
    rows: docs.map((d) => aggRow(d.flavour, d.runs, [ms(Math.max(0, ...d.init.map((i) => i.initMs || 0)))]))
  };
}

export function sceneTable(doc) {
  const rows = [];
  for (const [scene, runs] of groupBy(doc.runs, (r) => r.scene)) {
    const t = doc.scenes[scene];
    const a = aggregate(runs);
    const sample = runs.find((r) => r.variant === 'x4-nearest') || runs[0];
    const got = sample.error ? 'ERROR' : sample.regions.map((r) => r.text).join(' | ');
    rows.push([
      scene, t.platform, t.frameKind + (t.partial ? '*' : ''),
      t.regions.length ? pct(a.cer) : '-', t.regions.length ? pct(a.cerCI) : '-',
      t.regions.length ? pct(a.lineExactCS) : '-',
      t.regions.length ? `${num(a.regionsOut / Math.max(1, a.textRuns))}/${t.regions.length}` : `${num(a.fpRegions / Math.max(1, a.noTextRuns))}/0`,
      ms(a.latencyMean), String(a.errors),
      got.length > 70 ? got.slice(0, 67) + '...' : got
    ]);
  }
  return {
    title: `${doc.flavour}: per scene (mean over ${[...new Set(doc.runs.map((r) => r.variant))].length} variants; * = partial typewriter frame; "got" = output on ${doc.runs.some((r) => r.variant === 'x4-nearest') ? 'x4-nearest' : 'first variant'})`,
    columns: ['scene', 'plat', 'frame', 'CER', 'CER ci', 'lines exact', 'regions out/exp', 'ms', 'err', 'got'],
    rows
  };
}

export function groupTable(doc, keyFn, label, title) {
  const rows = [];
  for (const [k, runs] of groupBy(doc.runs, keyFn)) rows.push(aggRow(String(k), runs));
  return { title: `${doc.flavour}: ${title}`, columns: [label, ...AGG_COLS], rows };
}

export function kindTable(doc) {
  return {
    title: `${doc.flavour}: per region kind`,
    columns: ['kind', 'GT regions', 'CER', 'CER ci', 'lines exact'],
    rows: aggregateByKind(doc.runs).map((k) => [k.kind, String(k.regions), pct(k.cer), pct(k.cerCI), pct(k.lineExactCS)])
  };
}

export function initTable(docs) {
  const rows = [];
  for (const d of docs) {
    if (d.flavour !== d.adapter) continue;
    for (const i of d.init) {
      rows.push([d.adapter, i.lang, ms(i.initMs), ms(i.maxLongTaskMs), ms(i.totalBlockingMs), i.spellWarmMs != null ? ms(i.spellWarmMs) : '-', (i.error ? 'ERROR: ' + i.error.split('\n')[0] : (i.spellNote || i.note || '')).slice(0, 110)]);
    }
  }
  return { title: 'Engine init (per adapter and language)', columns: ['adapter', 'lang', 'init ms', 'max long task', 'TBT', 'spell warm ms', 'note'], rows };
}

// worst GT regions, one entry per (scene, region), preferring x4-nearest
export function failureExamples(doc, n = 15) {
  const best = new Map();
  for (const r of doc.runs) {
    if (!r.metrics) continue;
    r.metrics.perRegion.forEach((pr, i) => {
      const key = r.scene + '#' + i;
      const prev = best.get(key);
      const prefer = r.variant === 'x4-nearest';
      if (!prev || (prefer && prev.variant !== 'x4-nearest')) best.set(key, { scene: r.scene, variant: r.variant, ...pr });
    });
  }
  const list = [...best.values()].filter((e) => e.cerCI > 0).sort((a, b) => (b.cerCI - a.cerCI) || (b.chars - a.chars));
  return {
    title: `${doc.flavour}: worst regions (x4-nearest when available)`,
    columns: ['scene', 'kind', 'CER ci', 'expected', 'got (best-matching output region)'],
    rows: list.slice(0, n).map((e) => [e.scene, e.kind, pct(e.cerCI), e.gt, e.got || '(nothing)'])
  };
}

export function falsePositiveTable(doc) {
  const rows = [];
  for (const r of doc.runs) {
    if (doc.scenes[r.scene].regions.length || !r.regions.length) continue;
    rows.push([r.scene, r.variant, r.regions.map((x) => x.text).join(' | ').slice(0, 100)]);
  }
  return { title: `${doc.flavour}: false positives on no-text scenes`, columns: ['scene', 'variant', 'output'], rows };
}

// --- rendering ------------------------------------------------------------

const width = (s) => [...String(s)].length;

export function renderText(t) {
  const cols = t.columns.length;
  const w = new Array(cols).fill(0);
  for (const row of [t.columns, ...t.rows]) row.forEach((c, i) => { w[i] = Math.min(Math.max(w[i], width(c)), 72); });
  const fmt = (row) => row.map((c, i) => {
    let s = String(c);
    if (width(s) > w[i]) s = [...s].slice(0, w[i] - 1).join('') + '~';
    return s + ' '.repeat(w[i] - width(s));
  }).join('  ');
  return [`== ${t.title}`, fmt(t.columns), w.map((x) => '-'.repeat(x)).join('  '), ...t.rows.map(fmt)].join('\n');
}

export function renderMarkdown(t) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  return [`#### ${t.title}`, '', '| ' + t.columns.map(esc).join(' | ') + ' |', '|' + t.columns.map(() => '---').join('|') + '|',
    ...t.rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |'), ''].join('\n');
}

export function allTables(docs, { examples = 15 } = {}) {
  const out = [summaryTable(docs), initTable(docs)];
  for (const d of docs) {
    out.push(groupTable(d, (r) => r.variant, 'variant', 'per presentation variant'));
    out.push(groupTable(d, (r) => r.platform, 'platform', 'per platform'));
    out.push(groupTable(d, (r) => (r.partial ? 'partial (typewriter)' : 'complete'), 'frames', 'complete vs partial frames'));
    out.push(kindTable(d));
    out.push(sceneTable(d));
    out.push(failureExamples(d, examples));
    out.push(falsePositiveTable(d));
  }
  return out;
}
