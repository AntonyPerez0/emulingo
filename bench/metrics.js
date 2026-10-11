// OCR scoring (pure JS - used by bench/run.mjs in Node; importable in the
// browser too).
//
// Per run (one adapter x scene x variant):
//   - each GT region is matched to the OCR region with the smallest edit
//     distance (an OCR region may serve several GT regions). The distance is
//     capped at the GT length, so per-region CER is in [0, 1]: a pipeline
//     that MERGES regions scores ~100% on them (the region text is wrong for
//     translation) while frame CER shows the content itself was read
//   - CER = sum(edit distance) / sum(GT chars), case-sensitive and
//     case-insensitive (accents are never folded: "schon" vs "schön" is a
//     different word, and losing umlauts is a real OCR error)
//   - exact line match: fraction of GT lines that occur verbatim inside
//     some OCR region (whitespace-normalised; CS and CI)
//   - frame CER: all GT regions joined in reading order vs all OCR regions
//     joined in output order (insensitive to how regions were split)
//   - word recall / precision (case-insensitive bag of words)
//   - junk regions: OCR regions whose words are (mostly) not in the ground
//     truth; on no-text scenes every output region is a false positive

export function normText(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/…/g, '...')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  const s = [...a], t = [...b];
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[t.length];
}

const lower = (s) => s.toLocaleLowerCase('und');
const words = (s) => lower(normText(s)).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const len = (s) => [...s].length;

export function scoreRun(truth, outRegions) {
  const gt = truth.regions.map((r) => ({ ...r, text: normText(r.text), lines: r.lines.map(normText) }));
  const out = (outRegions || []).map((r) => normText(r.text)).filter(Boolean);
  const res = {
    gtRegions: gt.length,
    outRegions: out.length,
    gtChars: 0,
    distCS: 0,
    distCI: 0,
    lines: 0,
    linesExactCS: 0,
    linesExactCI: 0,
    perRegion: [],
    junkRegions: 0,
    junkChars: 0
  };
  for (const g of gt) {
    // best-matching output region (smallest case-insensitive distance);
    // the per-region distance is capped at the GT length, so a region that
    // drowns in merged neighbours scores like a missed region (100%) - the
    // frame-level CER below shows whether its content was read at all
    let bestIdx = -1, bestCI = Infinity;
    out.forEach((o, i) => {
      const d = levenshtein(lower(g.text), lower(o));
      if (d < bestCI) { bestCI = d; bestIdx = i; }
    });
    const n = len(g.text);
    const distCI = bestIdx >= 0 ? Math.min(n, bestCI) : n;
    const distCS = bestIdx >= 0 ? Math.min(n, levenshtein(g.text, out[bestIdx])) : n;
    res.gtChars += n;
    res.distCS += distCS;
    res.distCI += distCI;
    const exactCS = g.lines.map((l) => out.some((o) => o.includes(l)));
    const exactCI = g.lines.map((l) => out.some((o) => lower(o).includes(lower(l))));
    res.lines += g.lines.length;
    res.linesExactCS += exactCS.filter(Boolean).length;
    res.linesExactCI += exactCI.filter(Boolean).length;
    res.perRegion.push({
      kind: g.kind,
      gt: g.text,
      got: bestIdx >= 0 ? out[bestIdx] : '',
      chars: n,
      distCS,
      distCI,
      cer: n ? distCS / n : 0,
      cerCI: n ? distCI / n : 0,
      lines: g.lines.length,
      linesExactCS: exactCS.filter(Boolean).length
    });
  }
  // junk: output regions whose words mostly do not occur in the ground
  // truth (border/art misreads); on no-text scenes every output is junk
  const gtWords = new Set(gt.flatMap((g) => words(g.text)));
  for (const o of out) {
    const ow = words(o);
    const known = ow.filter((w) => gtWords.has(w)).length;
    if (!gt.length || !ow.length || known / ow.length < 0.3) { res.junkRegions++; res.junkChars += len(o); }
  }
  res.cer = res.gtChars ? res.distCS / res.gtChars : null;
  res.cerCI = res.gtChars ? res.distCI / res.gtChars : null;
  const gtFrame = gt.map((g) => g.text).join(' ');
  const outFrame = out.join(' ');
  res.frameCerCI = gtFrame ? levenshtein(lower(gtFrame), lower(outFrame)) / len(gtFrame) : null;
  // bag-of-words recall / precision
  const gw = words(gtFrame), ow = words(outFrame);
  const pool = new Map();
  for (const w of gw) pool.set(w, (pool.get(w) || 0) + 1);
  let hit = 0;
  for (const w of ow) { const n = pool.get(w) || 0; if (n > 0) { hit++; pool.set(w, n - 1); } }
  res.wordRecall = gw.length ? hit / gw.length : null;
  res.wordPrecision = ow.length ? hit / ow.length : (gw.length ? 0 : null);
  return res;
}

// --- aggregation ------------------------------------------------------------

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}
const mean = (v) => { const f = v.filter((x) => Number.isFinite(x)); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null; };

// runs: [{ truth, metrics, latencyMs, maxLongTaskMs, totalBlockingMs, error }]
export function aggregate(runs) {
  const text = runs.filter((r) => r.truth.regions.length);
  const noText = runs.filter((r) => !r.truth.regions.length);
  const sum = (arr, f) => arr.reduce((a, r) => a + (r.metrics ? f(r.metrics) : 0), 0);
  const gtChars = sum(text, (m) => m.gtChars);
  const lines = sum(text, (m) => m.lines);
  const gtRegions = sum(text, (m) => m.gtRegions);
  return {
    runs: runs.length,
    errors: runs.filter((r) => r.error).length,
    textRuns: text.length,
    cer: gtChars ? sum(text, (m) => m.distCS) / gtChars : null,
    cerCI: gtChars ? sum(text, (m) => m.distCI) / gtChars : null,
    frameCerCI: mean(text.map((r) => r.metrics && r.metrics.frameCerCI)),
    lineExactCS: lines ? sum(text, (m) => m.linesExactCS) / lines : null,
    lineExactCI: lines ? sum(text, (m) => m.linesExactCI) / lines : null,
    wordRecall: mean(text.map((r) => r.metrics && r.metrics.wordRecall)),
    wordPrecision: mean(text.map((r) => r.metrics && r.metrics.wordPrecision)),
    regionsOut: sum(text, (m) => m.outRegions),
    regionsExpected: gtRegions,
    regionCountExact: text.length ? text.filter((r) => r.metrics && r.metrics.outRegions === r.metrics.gtRegions).length / text.length : null,
    junkRegions: sum(text, (m) => m.junkRegions),
    noTextRuns: noText.length,
    fpRegions: sum(noText, (m) => m.outRegions),
    fpRuns: noText.filter((r) => r.metrics && r.metrics.outRegions > 0).length,
    latencyMean: mean(runs.map((r) => r.latencyMs)),
    latencyP95: percentile(runs.map((r) => r.latencyMs), 95),
    longTaskMax: runs.reduce((a, r) => Math.max(a, r.maxLongTaskMs || 0), 0),
    longTaskP95: percentile(runs.map((r) => r.maxLongTaskMs || 0), 95),
    tbtMean: mean(runs.map((r) => r.totalBlockingMs))
  };
}

// per-region-kind CER (over all GT regions of that kind)
export function aggregateByKind(runs) {
  const by = new Map();
  for (const r of runs) {
    if (!r.metrics) continue;
    for (const pr of r.metrics.perRegion) {
      if (!by.has(pr.kind)) by.set(pr.kind, { regions: 0, chars: 0, distCS: 0, distCI: 0, lines: 0, exact: 0 });
      const k = by.get(pr.kind);
      k.regions++; k.chars += pr.chars; k.distCS += pr.distCS; k.distCI += pr.distCI;
      k.lines += pr.lines; k.exact += pr.linesExactCS;
    }
  }
  return [...by.entries()].map(([kind, k]) => ({
    kind, regions: k.regions,
    cer: k.chars ? k.distCS / k.chars : null,
    cerCI: k.chars ? k.distCI / k.chars : null,
    lineExactCS: k.lines ? k.exact / k.lines : null
  }));
}

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
