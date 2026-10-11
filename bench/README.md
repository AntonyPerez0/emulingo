# OCR bench

A headless benchmark that measures how well Emulingo reads Pokémon-style
Game Boy / GBC / GBA screens, so OCR changes can be judged by numbers instead
of by eye.

```bash
npm install                      # once (Playwright uses the preinstalled Chromium)
npm run bench:ocr                # all adapters x all scenes x default variants
npm run bench:ocr -- --adapter legacy-neural --scene gba- --variant x4-nearest
npm run bench:ocr -- --list      # adapters, variants, scenes
npm run bench:scenes             # contact sheet of every scene -> bench/results/scenes.png
npm run bench:report -- --md     # re-render tables from bench/results/*.json
```

`bench:ocr` options:

| option | meaning |
|---|---|
| `--adapter a,b` | adapters to run (default `all`) |
| `--scene f1,f2` | scene id substrings (or `/regex/`) |
| `--variant v1,v2` | presentation variants (substring), `all` for all five; default `x4-nearest,x6.25-nearest,fhd-letterbox-bilinear,phone-bilinear` |
| `--no-spell` | skip the `+spell` flavour (spell correction post-pass) |
| `--timeout 90` | per-run timeout in seconds (the page is reloaded after a timeout) |
| `--frames` | also write every native frame (3x) to `bench/results/frames/` |
| `--examples 15` | number of worst-region examples in the report |
| `--out dir` | output directory (default `bench/results/`) |

Outputs: `bench/results/<adapter>.json`, `<adapter>+spell.json` (every run with
OCR output, metrics, latency, long tasks, debug data) and `summary.md` (all
tables). The exit code is 1 when an adapter fails to load or initialise, any
run errors, or the app requested a CDN URL the router could not serve - there
are no silent failures. A full baseline (2 adapters, 42 scenes, 4 variants)
takes about 8-10 minutes.

## How it works

1. `run.mjs` starts Vite programmatically (root = repo, free port, separate
   optimizer cache `node_modules/.vite-bench`) and headless Chromium
   (Playwright), and opens `bench/bench.html`.
2. Every CDN request the app makes is answered from `node_modules` by
   `lib/routes.mjs` (see below), so runs are offline and pinned.
3. For each adapter the page renders each scene at **native** resolution
   (`scenes.js`), presents it like the emulator canvas (`present.js`) and
   hands `(canvas, grid)` to the adapter - exactly what
   `emulator.snapshot()` gives the app.
4. Node scores the output against the scene's ground truth (`metrics.js`) and
   prints/writes the tables (`lib/report.mjs`).

### Scenes (`scenes.js`, `fonts.js`)

42 procedurally generated frames with **original** art (seeded PRNG): grass,
tall grass, trees, ponds, paths, flowers, fences, rocks, ledges, signs, houses,
shop interiors, player/NPC sprites and blob creatures. Text uses three
hand-designed bitmap fonts (no Nintendo assets):

- `GB_BOLD` - 8x8 tiles with 2-px stems (Gen 1 feel), `GB_THIN` - 8x8 tiles
  with 1-px strokes (Gen 2 feel). Printable ASCII, `ä ö ü Ä Ö Ü ß é è ê à â ç ñ
  á í ó ú ¿ ¡ ¥` and the special tiles `▼ ▶ ♂ ♀ …`, PK / MN ligatures,
  `:L` level and `HP` label tiles.
- `GBA_FONT` - Gen 3 style proportional font (5-6 px advance, 16 px line
  pitch) drawn dark-gray-on-white with a light 1-px drop shadow.

| group | scenes |
|---|---|
| Gen 1 style (bold font; DMG gray, DMG green, GBC red/blue palettes) | Oak intro EN/DE (with and without ▼), German umlauts/ß/hyphenated wrap, FR, ES (¡ ñ é), wild battle EN/DE (HUDs with `:L3`, HP bars, `19/ 20`), battle menu EN (FIGHT PkMn / ITEM RUN) and DE (KAMPF POKé / ITEM FLUCHT), START menu EN/DE over the map, YES/NO over a dialog EN/DE, mart with `$3000` money box |
| Gen 2 style (thin font, per-tile GBC colours, day and night) | dialogs EN/DE/FR/ES, a town sign, a German mart (menu + `GELD 3000¥` + dialog) |
| Gen 3 style GBA | Oak intro EN/DE/ES/FR, battle with "What will TORCHIC do?" + FIGHT/BAG/POKéMON/RUN (and German), "Wild POOCHYENA appeared!", ROUTE 101 location sign, START menu |
| partial | typewriter frames with half-printed text (`partial: true`, scored against what is visible) |
| no text | GB/GBC/GBA overworld and battle intros (empty boxes) - false-positive measurement |

Ground truth per scene: `{id, platform, lang, frameKind, partial, regions:[{kind:
'dialog'|'menu'|'hud'|'sign', lines, text}]}`. Decorations (▼ ▶ ♂ ♀) are not
text; ligature tiles map to `Pk`, `Mn`, `:L`, `HP`. A line ending in
`<lowercase>-` followed by a lowercase line is a word wrap and joins without the
hyphen.

### Presentation variants (`present.js`)

`presentFrame(native, variant) -> {canvas, grid}` aspect-fits the native frame
into a black canvas like EmulatorJS and returns `grid` computed with the exact
arithmetic of `src/core/emulator.js getGrid()`:

| variant | canvas | scaling |
|---|---|---|
| `x4-nearest` | 640x576 | integer, nearest |
| `x6.25-nearest` | 1000x900 | non-integer, nearest |
| `x8-bilinear` | 1280x1152 | bilinear |
| `fhd-letterbox-bilinear` | 1920x1080 | pillarboxed, bilinear |
| `phone-bilinear` | 390x351 | bilinear |

GBA frames (3:2) get letterbox bars in every variant.

### Metrics (`metrics.js`)

- **CER** (case-sensitive and `ci` = case-insensitive): each GT region is
  matched to the output region with the smallest edit distance; the distance
  is capped at the GT length, so a region merged with its neighbours scores
  like a miss. Summed over regions, divided by GT characters. Accents are
  never folded.
- **frame CER ci**: all GT text vs all output text, ignoring how it was split.
- **lines exact**: share of GT lines found verbatim inside some output region.
- **word R / P**: case-insensitive bag-of-words recall / precision.
- **regions out/exp**, **region count ok**: region split quality.
- **junk/run**: output regions whose words are mostly not on screen.
- **FP (no-text)**: output regions on no-text scenes.
- **ms mean / p95**: adapter `read()` wall time; **max long task**, **TBT**:
  `PerformanceObserver('longtask')` max duration and total blocking time
  (sum of `duration - 50`) - i.e. how long the emulator would freeze.

## Adapters

Every `bench/adapters/*.js` file (except `_*.js` helpers) is loaded
automatically - **adding a pipeline = adding one file**:

```js
// bench/adapters/pipeline.js
import { readFrame } from '../../src/core/ocr/pipeline.js';

export default {
  name: 'pipeline',
  description: 'New OCR pipeline (src/core/ocr/pipeline.js)',
  spell: false,                 // true: also score '<name>+spell' using the frozen
                                // app correctOcrText; or a function (text, ctx) => text
  async init(ctx) {             // optional: before the first run and when ctx.lang changes
    // warm up models; throw to surface init failures
  },
  async read(canvas, grid, ctx) {
    // canvas: presented snapshot, grid: getGrid() object,
    // ctx: { lang: 'de', ocrLang: 'deu', core: 'gb'|'gba', onStatus(msg) }
    const regions = await readFrame(canvas, grid, { lang: ctx.lang });
    return { regions: regions.map((r) => ({ text: r.text, conf: r.conf })), debug: {} };
  }
};
```

Then `npm run bench:ocr -- --adapter pipeline,legacy-neural`. Throw from
`read()` on engine failure instead of returning nothing - errors are counted.

Built-in adapters compare against a **frozen baseline**: `bench/legacy/` holds
verbatim copies of `src/core/{ocr-neural,ocr,correct,idb}.js` at the commit the
bench was created from, and `adapters/_app.js` holds verbatim copies of the
module-private `cleanOcrText`, `ocrLangFor` and `withTimeout` from
`src/ui/playview.js`, so later rewrites of `src/` do not move the baseline.

- `legacy-neural` - the default app path: `ocrFrameNeural(canvas)`
  (PaddleOCR PP-OCRv5 det + latin rec via onnxruntime-web WASM, main thread)
  -> `cleanOcrText` (incl. `applyGameLexicon`) -> the "uncertain read" gate.
  A `null` from `ocrFrameNeural` (the app silently falls back to Tesseract) is
  an error here; init failures are diagnosed by re-running
  `PaddleOCR.create` to get the real exception.
- `legacy-tesseract` - `detectTextRects(canvas, 6, grid)` -> `ocrRegion` per
  rect (bottom-band fallback when nothing is detected) -> `cleanOcrText` ->
  confidence gates.
- `+spell` flavours - the same OCR output post-processed with the app's
  `correctOcrText` (4 s timeout), i.e. the full default pipeline with
  "Fix OCR misreads" on. The speller is warmed in `init` like the app does
  when a ROM starts.

## CDN routing (`lib/routes.mjs`) - reusable

```js
import { createCdnRouter } from './bench/lib/routes.mjs';
const router = createCdnRouter({ repoRoot, viteOrigin, emulatorjsDataDir /* optional */ });
await router.install(browserContext);   // a BrowserContext also covers workers
// router.stats -> { served, missing, warnings, tessdata }
```

| app request | served from |
|---|---|
| `cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm` | re-export of `bench/lib/shims/paddleocr-js.js` on the Vite server (Vite pre-bundles the local SDK) |
| `cdn.jsdelivr.net/npm/nspell@2/+esm` | `bench/lib/shims/nspell.js` |
| `cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/*` | `node_modules/onnxruntime-web/dist/*` |
| `cdn.jsdelivr.net/npm/tesseract.js@*/dist/*`, `tesseract.js-core@*/*` | `node_modules/tesseract.js/dist`, `node_modules/tesseract.js-core` |
| `cdn.jsdelivr.net/npm/dictionary-xx@v/index.{dic,aff}` | `node_modules/dictionary-xx` |
| `tessdata.projectnaptha.com/4.0.0_best/<lang>.traineddata.gz` | `bench/.cache/tessdata/` - downloaded once from `tesseract-ocr/tessdata_best@4.0.0` on GitHub and gzipped; offline fallback `@tesseract.js-data/<lang>` (`4.0.0_best_int` - a different flavour, reported as a warning) |
| `cdn.emulatorjs.org/*/data/*` | `emulatorjsDataDir` when given |

Version mismatches between the requested and installed packages are reported
as warnings; unknown CDN URLs get a 404 and are listed in `stats.missing`.
Use `startHarness()` from `lib/server.mjs` for the Vite + Chromium + routes
setup in one call.

## Files

```
bench/
  run.mjs            CLI runner (npm run bench:ocr)
  report.mjs         re-render tables from saved results (npm run bench:report)
  preview.mjs        scene contact sheet via @napi-rs/canvas (npm run bench:scenes)
  bench.html         browser page (also usable interactively via npm run dev -> /bench/bench.html)
  bench-page.js      window.bench API + small inspection UI
  scenes.js          scene generator + ground truth
  fonts.js           original bitmap fonts
  present.js         presentation variants + getGrid() clone
  metrics.js         scoring
  adapters/          one file per OCR pipeline (_app.js = verbatim app helpers)
  legacy/            frozen copies of the baseline OCR modules
  lib/routes.mjs     CDN -> node_modules routing (shared with E2E tests)
  lib/server.mjs     Vite + Chromium harness
  lib/report.mjs     table builders (text + Markdown)
  lib/shims/         ES-module shims the routes point at
  BASELINE.md        baseline numbers for the legacy pipelines
```
