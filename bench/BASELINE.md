# OCR bench - baseline (frozen legacy pipelines)

Baseline of the OCR code as of commit `002b2c7` (frozen copies in
`bench/legacy/`), measured with `npm run bench:ocr` (all 42 scenes x 4
presentation variants = 168 runs per adapter; about 8 minutes for everything).

- Environment: headless Chromium 141.0.7390.37 (Playwright 1.56.1), Node 22, 4 vCPU
  shared with other jobs, so treat latencies as relative. Packages:
  @paddleocr/paddleocr-js 0.4.2, onnxruntime-web 1.29.0 (WASM, 1 thread),
  @techstark/opencv-js 4.10.0-release.1, tesseract.js 5.1.1 + core 5.1.1 with
  tessdata `4.0.0_best` (eng/deu/fra/spa), nspell 2.1.5 + dictionary-en 4.0.0 /
  de 3.0.0 / fr 3.0.0 / es 4.0.0.
- Variants: `x4-nearest` (640x576), `x6.25-nearest` (1000x900),
  `fhd-letterbox-bilinear` (1920x1080), `phone-bilinear` (390x351).
- Init times are with every asset served locally; the 2.5 s Tesseract `es`
  init includes the one-time GitHub download of `spa.traineddata` into
  `bench/.cache/`. In production the app downloads ~13 MB of Paddle models,
  7.7 MB (deu) / 12.8 MB (eng) of gzipped tessdata and ~1 MB per dictionary.
- Reproduce: `npm run bench:ocr` (full tables in `bench/results/summary.md`),
  `npm run bench:report -- --md` re-renders them from the saved JSON.

Metric definitions are in `bench/README.md`. In short: **CER** is per GT
region against the best-matching output region, capped at 100% per region (a
region merged into one big blob counts as wrong); **frame CER** compares all
text regardless of how it was split; **lines exact** = GT lines found verbatim;
**max long task / TBT** = main-thread blocking during the read.

## Key findings

1. **legacy-neural merges every text item on screen into ONE region** (the
   known `it.x/it.y` bug in `ocr-neural.js`): regions out/exp is 1.0/1.6 on
   every run, so every multi-region frame (battles, menus over dialogs, marts)
   scores 100% region CER even though the frame CER is only 18.7% - the
   characters are mostly read, but HUD, menu and dialog text arrive as one
   string ("TAUBSI :L3 HP: BISASAM :L5 HP: 97 ZE Ein wildes TAUBSI erscheint!")
   and are translated as one sentence.
2. **Background art leaks into the text.** The full-frame neural detector
   reads trees, grass tufts, sign boards and shelves as glyphs (`8 • : - • d &&
   . ea Hallo! ...`, `ROUTE 101 00=: H`); because of the merge bug the junk is
   glued onto the real dialog instead of being dropped by `cleanOcrText`.
3. **Bigger is worse for PaddleOCR.** With `textDetLimitSideLen: 640 / max`,
   the 640x576 (4x) canvas goes in unscaled with 32-px glyphs and gives the
   worst accuracy and the slowest reads (CER 52.5%, lines exact 66%, 1.56 s);
   the 390x351 phone canvas (~2.4 px per native pixel) gives the best (43.8%,
   81%, 0.88 s). Feeding the model a crisp ~2-3x render of the native grid
   is both faster and more accurate.
4. **The neural engine freezes the page.** `predict()` runs on the main thread:
   total blocking time is ~95% of the read time, single long tasks reach
   4.1 s (German START menu at 4x), mean 1.25 s per frame. Init takes ~6.8 s
   with a 554 ms long task (model load, ORT session, OpenCV).
5. **Pixel-font confusions (neural):** `!`->`t` at line end (`gefährlicht`),
   mixed case inside caps (`POkéMoN`, `SIcheRn`), `W`->`H` in the bold font
   (`Hillk`), `P`->`F` (`FIDGET`, `HF` for `HP`), `l`->`1` (`1auern`), `¡`->`i`,
   `í`->`f` (`Aquf`, `iCufdalo`), `ç`->`c`, `0`->`8` (`$3888`), and the 8x8
   thin font's wide letter spacing splits words into letters
   (`K A U FE N V E R K A U F E N`). Number fields like `19/ 20` come out as
   `97 ZE`.
6. **legacy-tesseract finds the boxes but reads them badly.** It splits
   regions closer to the truth (region CER 37.5% vs 48.2%) but its frame CER is
   75% because detected bands over map art produce junk regions (0.92 per
   run), it drops whole words below confidence 30 (`Hello there! to the`),
   reads the dialog arrow as `v`, cannot read white-on-teal GBA battle text
   or the GBA location sign, and produces **false positives on 6 of 20 no-text
   frames** (neural: 0/20).
7. **Spell correction is a wash (slightly negative).** It repairs some
   misreads (`recu`->`reçu`, `Willkommer`->`Willkommen`,
   `gefährlicht`->`gefährlich`) but nspell with dictionary-de 3.0.0 rejects
   common words (`lernen`, `kennen`, `Vorsicht`), so correctOcrText also
   "fixes" correct text: `Vorsicht!`->`Vorsieht!`, `lernen!`->`lerne!`, and
   typewriter prefixes `Willk`->`Will`; net lines-exact drops 70.7% -> 70.0%
   (neural). Spanish is never corrected: the app passes `ocrLangFor('es')` =
   `spa` and correct.js takes `slice(0,2)` = `sp`, which has no dictionary.
   Loading the French dictionary blocks the main thread for ~5.2 s in one
   long task (German 1.2 s).
8. **Partial typewriter frames read fine** (CER 5.8% neural), i.e. the
   per-frame engines cannot tell a half-printed line from a finished one -
   the stability logic in playview.js has to handle it.

## Tables

### Overall (all scenes x variants; CER over text scenes, partial frames included)

| adapter | init ms | CER | CER ci | frame CER ci | lines exact | word R | word P | regions out/exp | region count ok | junk/run | FP (no-text) | ms mean | ms p95 | max long task | TBT mean | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| legacy-neural | 6778 | 48.2% | 47.9% | 18.7% | 70.7% | 87.0% | 75.4% | 1.0/1.6 | 70.3% | 0.02 | 0 in 0/20 | 1246 | 2220 | 4099 | 1199 | 0 |
| legacy-neural+spell | 6778 | 48.3% | 47.9% | 18.8% | 70.0% | 86.6% | 75.1% | 1.0/1.6 | 70.3% | 0.02 | 0 in 0/20 | 1247 | 2221 | 4099 | 1199 | 0 |
| legacy-tesseract | 2495 | 37.5% | 37.0% | 75.2% | 25.7% | 56.2% | 47.2% | 1.9/1.6 | 41.9% | 0.92 | 12 in 6/20 | 1313 | 2368 | 132 | 0 | 0 |
| legacy-tesseract+spell | 2495 | 37.7% | 37.1% | 75.2% | 24.8% | 55.9% | 47.4% | 1.9/1.6 | 41.9% | 0.92 | 12 in 6/20 | 1314 | 2369 | 132 | 0 | 0 |

### Engine init (per adapter and language)

| adapter | lang | init ms | max long task | TBT | spell warm ms | note |
|---|---|---|---|---|---|---|
| legacy-neural | de | 6778 | 554 | 504 | 1754 | speller "de" ready |
| legacy-neural | en | 0 | 0 | 0 | 205 | speller "en" ready |
| legacy-neural | es | 0 | 0 | 0 | 0 | no dictionary for code "sp" (app derives it as ocrLang.slice(0,2) = "spa".slice(0,2)) - correction is a no-op |
| legacy-neural | fr | 0 | 0 | 0 | 5327 | speller "fr" ready |
| legacy-tesseract | de | 1156 | 0 | 0 | 1052 | speller "de" ready |
| legacy-tesseract | en | 1605 | 0 | 0 | 170 | speller "en" ready |
| legacy-tesseract | es | 2495 | 0 | 0 | 0 | no dictionary for code "sp" (app derives it as ocrLang.slice(0,2) = "spa".slice(0,2)) - correction is a no-op |
| legacy-tesseract | fr | 1360 | 0 | 0 | 5036 | speller "fr" ready |

### legacy-neural: per presentation variant

| variant | CER | CER ci | frame CER ci | lines exact | word R | word P | regions out/exp | region count ok | junk/run | FP (no-text) | ms mean | ms p95 | max long task | TBT mean | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| x4-nearest | 52.5% | 51.9% | 24.3% | 66.2% | 86.4% | 70.9% | 1.0/1.6 | 70.3% | 0.03 | 0 in 0/5 | 1563 | 2428 | 4099 | 1516 | 0 |
| x6.25-nearest | 48.7% | 48.1% | 19.4% | 61.2% | 83.2% | 72.7% | 1.0/1.6 | 70.3% | 0.00 | 0 in 0/5 | 1382 | 2088 | 3525 | 1333 | 0 |
| fhd-letterbox-bilinear | 48.1% | 47.9% | 19.2% | 74.1% | 87.0% | 73.6% | 1.0/1.6 | 70.3% | 0.05 | 0 in 0/5 | 1162 | 2033 | 3087 | 1119 | 0 |
| phone-bilinear | 43.8% | 43.7% | 12.0% | 81.3% | 91.5% | 84.4% | 1.0/1.6 | 70.3% | 0.00 | 0 in 0/5 | 877 | 1820 | 2754 | 827 | 0 |

### legacy-tesseract: per presentation variant

| variant | CER | CER ci | frame CER ci | lines exact | word R | word P | regions out/exp | region count ok | junk/run | FP (no-text) | ms mean | ms p95 | max long task | TBT mean | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| x4-nearest | 37.8% | 37.5% | 87.8% | 21.6% | 54.5% | 41.1% | 2.1/1.6 | 29.7% | 1.14 | 3 in 2/5 | 1432 | 2632 | 0 | 0 | 0 |
| x6.25-nearest | 35.1% | 34.6% | 85.4% | 27.3% | 56.3% | 44.9% | 1.9/1.6 | 48.6% | 0.89 | 1 in 1/5 | 1351 | 2338 | 132 | 2 | 0 |
| fhd-letterbox-bilinear | 35.5% | 34.9% | 58.4% | 27.3% | 57.5% | 52.5% | 1.8/1.6 | 48.6% | 0.76 | 6 in 2/5 | 1226 | 2059 | 0 | 0 | 0 |
| phone-bilinear | 41.7% | 41.1% | 69.0% | 26.6% | 56.5% | 50.1% | 1.9/1.6 | 40.5% | 0.89 | 2 in 1/5 | 1241 | 1934 | 0 | 0 | 0 |

### legacy-neural: per platform

| platform | CER | CER ci | frame CER ci | lines exact | word R | word P | regions out/exp | region count ok | junk/run | FP (no-text) | ms mean | ms p95 | max long task | TBT mean | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gb | 50.6% | 50.0% | 19.3% | 68.4% | 85.2% | 72.8% | 1.0/1.5 | 70.4% | 0.03 | 0 in 0/12 | 1299 | 2428 | 4099 | 1251 | 0 |
| gba | 44.3% | 44.3% | 17.2% | 76.2% | 91.9% | 82.4% | 1.0/1.8 | 70.0% | 0.00 | 0 in 0/8 | 1114 | 2004 | 2167 | 1067 | 0 |

### legacy-tesseract: per platform

| platform | CER | CER ci | frame CER ci | lines exact | word R | word P | regions out/exp | region count ok | junk/run | FP (no-text) | ms mean | ms p95 | max long task | TBT mean | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gb | 35.1% | 34.5% | 87.3% | 27.0% | 56.4% | 41.8% | 2.2/1.5 | 36.1% | 1.09 | 12 in 6/12 | 1425 | 2376 | 0 | 0 | 0 |
| gba | 41.7% | 41.4% | 42.2% | 22.6% | 55.6% | 61.7% | 1.3/1.8 | 57.5% | 0.45 | 0 in 0/8 | 1033 | 2338 | 132 | 2 | 0 |

### legacy-neural: complete vs partial frames

| frames | CER | CER ci | frame CER ci | lines exact | word R | word P | regions out/exp | region count ok | junk/run | FP (no-text) | ms mean | ms p95 | max long task | TBT mean | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| complete | 49.7% | 49.4% | 19.8% | 70.6% | 86.9% | 74.7% | 1.0/1.6 | 67.6% | 0.02 | 0 in 0/20 | 1293 | 2416 | 4099 | 1246 | 0 |
| partial (typewriter) | 5.8% | 5.8% | 6.1% | 75.0% | 88.9% | 82.6% | 1.0/1.0 | 100.0% | 0.00 | - | 637 | 924 | 928 | 589 | 0 |

### legacy-tesseract: complete vs partial frames

| frames | CER | CER ci | frame CER ci | lines exact | word R | word P | regions out/exp | region count ok | junk/run | FP (no-text) | ms mean | ms p95 | max long task | TBT mean | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| complete | 38.5% | 38.0% | 69.5% | 25.2% | 54.4% | 46.7% | 1.9/1.6 | 41.2% | 0.91 | 12 in 6/20 | 1328 | 2352 | 132 | 1 | 0 |
| partial (typewriter) | 10.1% | 10.1% | 138.8% | 43.8% | 76.4% | 52.1% | 2.0/1.0 | 50.0% | 1.00 | - | 1113 | 2602 | 0 | 0 | 0 |

### legacy-neural: per region kind

| kind | GT regions | CER | CER ci | lines exact |
|---|---|---|---|---|
| dialog | 120 | 27.5% | 27.1% | 73.2% |
| hud | 64 | 100.0% | 100.0% | 60.0% |
| menu | 40 | 73.8% | 73.7% | 81.9% |
| sign | 8 | 38.4% | 35.4% | 50.0% |

### legacy-tesseract: per region kind

| kind | GT regions | CER | CER ci | lines exact |
|---|---|---|---|---|
| dialog | 120 | 22.9% | 22.6% | 35.5% |
| hud | 64 | 82.1% | 80.4% | 1.1% |
| menu | 40 | 46.5% | 46.4% | 43.8% |
| sign | 8 | 35.4% | 35.4% | 0.0% |

### legacy-neural: per scene (mean over 4 variants; * = partial typewriter frame; "got" = output on x4-nearest)

| scene | plat | frame | CER | CER ci | lines exact | regions out/exp | ms | err | got |
|---|---|---|---|---|---|---|---|---|---|
| gb1-oak-hello-de | gb | overworld-dialog | 22.7% | 22.7% | 100.0% | 1.0/1 | 1564 | 0 | 8 • : - • d && . ea Hallo! Willkommen in der Welt der |
| gb1-oak-world-de | gb | overworld-dialog | 15.6% | 15.6% | 75.0% | 1.0/1 | 529 | 0 | POKéMON! |
| gb1-grass-warning-de | gb | overworld-dialog | 31.8% | 29.5% | 50.0% | 1.0/1 | 1691 | 0 | X • ** 8 a . a . Vorsicht! Im Gras lauern POkéMoN! |
| gb1-draussen-de | gb | overworld-dialog | 8.8% | 8.8% | 50.0% | 1.0/1 | 1178 | 0 | - - . - Draußen im Gras ist es gefährlich† |
| gb1-pokedex-hyphen-de | gb | overworld-dialog | 14.5% | 9.7% | 25.0% | 1.0/1 | 1068 | 0 | a Der POKéDEx zeichnet. Daten auf . |
| gb1-battle-wild-de | gb | battle-dialog | 100.0% | 100.0% | 69.4% | 1.0/3 | 1904 | 0 | THUESI :L3 HF. BISASAM :L5 HP: 97 ZE Ein Wildes TAUBSI erscheint ! |
| gb1-battle-menu-de | gb | battle-menu | 100.0% | 100.0% | 63.9% | 1.0/3 | 1621 | 0 | TAUESI :L3 HP: BISASAM :L5 HP: 2B KAMFF FOKé ITEM FLUCHT |
| gb1-start-menu-de | gb | start-menu | 63.5% | 63.0% | 89.3% | 1.0/1 | 2734 | 0 | POKéDEX POKéMON ITEM a ROT à à • • SICHERN π OPTIONEN • H ZURÜCK - ... |
| gb1-yesno-save-de | gb | yes-no | 60.1% | 57.4% | 75.0% | 1.0/2 | 1601 | 0 | a - JA NE IN Möchtest du das Spiel SIcheRn? |
| gb2-shorts-de | gb | overworld-dialog | 0.0% | 0.0% | 100.0% | 1.0/1 | 671 | 0 | Ich trage gern kurze Hosen! |
| gb2-mart-de | gb | mart | 100.0% | 100.0% | 45.8% | 1.0/3 | 1767 | 0 | GELD 3000 K A U FE N V E R K A U F E N T S C H U S S ! Hallo! Willk... |
| gba-oak-hello-de | gba | overworld-dialog | 0.3% | 0.3% | 100.0% | 1.0/1 | 790 | 0 | Hallo! Schön, dich kennen zu lernen! Willkommen in der Welt der POK... |
| gba-battle-menu-de | gba | battle-menu | 100.0% | 100.0% | 69.4% | 1.0/4 | 1870 | 0 | FIFFYEN Lv2 HF FLEMMLI [d Lv5 HF 19/ 20 Was soll KAMPF * BEUTEL FLE... |
| gb1-partial-hello-de | gb | overworld-dialog* | 8.3% | 8.3% | 50.0% | 1.0/1 | 606 | 0 | * Hallo! Hillk |
| gb2-overworld-notext | gb | no-text | - | - | - | 0.0/0 | 714 | 0 |  |
| gb1-oak-hello-en | gb | overworld-dialog | 11.1% | 11.1% | 100.0% | 1.0/1 | 843 | 0 | d s Hello there! Welcome to the |
| gb1-oak-world-en | gb | overworld-dialog | 51.5% | 47.1% | 25.0% | 1.0/1 | 1133 | 0 | world of POkéMoN! |
| gb1-battle-wild-en | gb | battle-dialog | 100.0% | 100.0% | 72.2% | 1.0/3 | 1544 | 0 | FIDGET :L3 HF BULBASAUR :L5 HP: 1 97 ZE Wild PIDGEY appeared! |
| gb1-battle-menu-en | gb | battle-menu | 100.0% | 100.0% | 52.8% | 1.0/3 | 1737 | 0 | FI DGET :L3 HF' …………… BUL BASAUR :L5 HP 97 ZE FIGHT ITEM RUN |
| gb1-start-menu-en | gb | start-menu | 64.6% | 64.6% | 89.3% | 1.0/1 | 2722 | 0 | POKéDEX POKéMON ITEM M. & RED SAVE OFTION EXIT • A A • A d A A 2 |
| gb1-yesno-save-en | gb | yes-no | 51.3% | 51.3% | 75.0% | 1.0/2 | 1715 | 0 | à YES NO 8 Would you like t o SAVE the game? |
| gb1-mart-money-en | gb | mart | 42.5% | 42.5% | 75.0% | 1.0/2 | 1271 | 0 | $3888 Hi there! May I help you? − |
| gb2-shorts-en | gb | overworld-dialog | 7.6% | 7.6% | 100.0% | 1.0/1 | 1149 | 0 | d 9 Hi, I like shorts! They're comfy andy |
| gb2-sign-en | gb | overworld-dialog | 29.7% | 25.8% | 25.0% | 1.0/1 | 1565 | 0 | a se ** e • NEW BARK TOWN The Town Where th |
| gba-oak-hello-en | gba | overworld-dialog | 5.2% | 5.2% | 100.0% | 1.0/1 | 1057 | 0 | = £: Hello there! Glad to meet you! Welcome to the world of POKéMON! |
| gba-battle-menu-en | gba | battle-menu | 100.0% | 100.0% | 77.8% | 1.0/4 | 1832 | 0 | POOCHYENALv2 HF TORCHIC Lv5 HF 19/ 20 What will 3 FIGHT BAG TORCHIC... |
| gba-battle-appeared-en | gba | battle-dialog | 100.0% | 100.0% | 58.3% | 1.0/3 | 1309 | 0 | POOCHYENA Lv2 HF TORCHIC Lv5 HF za Wild POOCHYENA appeared! |
| gba-route-sign-en | gba | location-sign | 69.4% | 69.4% | 100.0% | 1.0/1 | 701 | 0 | ROUTE 101 00=: H |
| gba-start-menu-en | gba | start-menu | 12.5% | 12.5% | 100.0% | 1.0/1 | 1435 | 0 | POKéDEX :Et POKéMON U . BAG MAY 8 SAVE OPTION EXIT e |
| gb1-partial-hello-en | gb | overworld-dialog* | 4.4% | 4.4% | 87.5% | 1.0/1 | 722 | 0 | a Hello there! Welc |
| gba-partial-hello-en | gba | overworld-dialog* | 5.4% | 5.4% | 75.0% | 1.0/1 | 585 | 0 | R Hello there! Glad to me |
| gb1-overworld-notext | gb | no-text | - | - | - | 0.0/0 | 746 | 0 |  |
| gb1-battle-intro-notext | gb | no-text | - | - | - | 0.0/0 | 451 | 0 |  |
| gba-overworld-notext | gba | no-text | - | - | - | 0.0/0 | 613 | 0 |  |
| gba-battle-intro-notext | gba | no-text | - | - | - | 0.0/0 | 454 | 0 |  |
| gb1-hola-es | gb | overworld-dialog | 39.0% | 39.0% | 25.0% | 1.0/1 | 1982 | 0 | T 0 a e x • o i Hola! iBienvenido a1 mundo de los |
| gb1-nino-es | gb | overworld-dialog | 1.4% | 1.4% | 100.0% | 1.0/1 | 842 | 0 | El niño de al lado también entrena. |
| gb2-aqui-es | gb | overworld-dialog | 10.5% | 10.5% | 25.0% | 1.0/1 | 869 | 0 | Aquf está tu POKéMON. iCufdalo! |
| gba-oak-hello-es | gba | overworld-dialog | 14.3% | 14.3% | 0.0% | 1.0/1 | 1676 | 0 | (B3 9 . Hola! iEncantado de conocerte! Bienvenido al mundo de los P... |
| gb1-hello-fr | gb | overworld-dialog | 12.5% | 12.5% | 100.0% | 1.0/1 | 1269 | 0 | a * u - Bonjour! Bienvenue dans le monde des+ |
| gb2-recu-fr | gb | overworld-dialog | 3.1% | 3.1% | 50.0% | 1.0/1 | 757 | 0 | Voilà! Tu as recu une POKé BALL. |
| gba-oak-hello-fr | gba | overworld-dialog | 2.6% | 2.6% | 87.5% | 1.0/1 | 1049 | 0 | D Bon,jour! Ravi de te rencontrer! Bienvenue dans le monde des POKé... |

### legacy-tesseract: per scene (mean over 4 variants; * = partial typewriter frame; "got" = output on x4-nearest)

| scene | plat | frame | CER | CER ci | lines exact | regions out/exp | ms | err | got |
|---|---|---|---|---|---|---|---|---|---|
| gb1-oak-hello-de | gb | overworld-dialog | 32.6% | 32.6% | 12.5% | 1.8/1 | 1699 | 0 | A A A = A A BA \| Hallo! Wıiıllkommer: ın der Helt der v |
| gb1-oak-world-de | gb | overworld-dialog | 93.8% | 93.8% | 0.0% | 1.0/1 | 1914 | 0 | Pa M \| X, - A A A A A Ah A Ba an a a |
| gb1-grass-warning-de | gb | overworld-dialog | 18.2% | 18.2% | 50.0% | 2.3/1 | 1635 | 0 | A 5:5 A A A A A a A Ar \| Vorsicht! Im Gras lauern FOK€eMON! |
| gb1-draussen-de | gb | overworld-dialog | 39.7% | 39.7% | 12.5% | 1.8/1 | 1854 | 0 | am am A A % A A A A A A A A A A \| Draußen ım Gras ıst es |
| gb1-pokedex-hyphen-de | gb | overworld-dialog | 25.8% | 25.8% | 50.0% | 1.3/1 | 1778 | 0 | Der zeichnet Daten auf. v |
| gb1-battle-wild-de | gb | battle-dialog | 55.9% | 55.1% | 16.7% | 2.8/3 | 1690 | 0 | LS HF" VO, „19/7, 76 \| Ein wıldes TAUESI erscheint! v |
| gb1-battle-menu-de | gb | battle-menu | 64.9% | 64.9% | 5.6% | 3.0/3 | 1245 | 0 | HPE \| LS HF \| FOKE€ ITEM FLUCHT |
| gb1-start-menu-de | gb | start-menu | 39.1% | 39.1% | 50.0% | 1.3/1 | 815 | 0 | FOKeDEX ITEM ROT SICHERN OFTIONEN \| A A A 2 m A A |
| gb1-yesno-save-de | gb | yes-no | 11.5% | 10.8% | 68.8% | 3.3/2 | 1791 | 0 | =, A A A \| a NEIN \| Möchtest du das SICHERN? |
| gb2-shorts-de | gb | overworld-dialog | 8.3% | 3.7% | 62.5% | 1.0/1 | 342 | 0 | ICh trage gern kurze Hosen! |
| gb2-mart-de | gb | mart | 31.8% | 31.8% | 45.8% | 4.0/3 | 1173 | 0 | AA GELD, 2000% \| VERKAUFEN I, 7 \| TSCHUSS! \| Hallo! Wıllkommen im P... |
| gba-oak-hello-de | gba | overworld-dialog | 38.2% | 38.2% | 12.5% | 1.5/1 | 1771 | 0 | WEG \| Hallo! Schön, , dich kennen zu lernen! Willkommen in der Welt... |
| gba-battle-menu-de | gba | battle-menu | 78.3% | 77.4% | 0.0% | 1.5/4 | 1900 | 0 | I FLEMMLIS Lvö |
| gb1-partial-hello-de | gb | overworld-dialog* | 10.4% | 10.4% | 25.0% | 3.5/1 | 2241 | 0 | a A a &, 4, *, A A \| La &, A A A A A \| - a A = a a A A \| Hallo! Willk |
| gb2-overworld-notext | gb | no-text | - | - | - | 1.3/0 | 1889 | 0 | A A X A A |
| gb1-oak-hello-en | gb | overworld-dialog | 24.1% | 24.1% | 37.5% | 2.5/1 | 1560 | 0 | rs rs rs A eA a, 4 Fe Fy :, & \| Hello there! to the v |
| gb1-oak-world-en | gb | overworld-dialog | 42.6% | 42.6% | 0.0% | 2.3/1 | 1711 | 0 | Ey ad \| A, », © Fe, 2 -r a, “ir \| world of |
| gb1-battle-wild-en | gb | battle-dialog | 64.4% | 61.9% | 11.1% | 2.3/3 | 1267 | 0 | Mild FIDGEY appeared! v |
| gb1-battle-menu-en | gb | battle-menu | 64.9% | 61.8% | 11.1% | 3.0/3 | 1295 | 0 | Elll EASAHIIR \| LS HFS od, 19/7, 28 \| PFIGHT ITEM RUN |
| gb1-start-menu-en | gb | start-menu | 50.0% | 50.0% | 28.6% | 2.5/1 | 1531 | 0 | PFOKEDEX FOK&éMON ITEM RED \| HVE \| OFTION \| exo \| -, . - A oy oy a ... |
| gb1-yesno-save-en | gb | yes-no | 18.4% | 18.4% | 12.5% | 2.8/2 | 1371 | 0 | Fy Fs Fy n, - rs Fy FY Fy a A AA, \| LN a \| Hould uou like to SHUE t... |
| gb1-mart-money-en | gb | mart | 40.0% | 40.0% | 33.3% | 1.3/2 | 1339 | 0 | Hi there! Mau I help uou”, v |
| gb2-shorts-en | gb | overworld-dialog | 25.0% | 25.0% | 25.0% | 2.0/1 | 1907 | 0 | A A a Pa i FN \| LA BY a \| Hl, , l1 like shorts! comfy |
| gb2-sign-en | gb | overworld-dialog | 22.7% | 22.7% | 0.0% | 2.3/1 | 2001 | 0 | a A rs rs rs by re, * A re AG ool Fo \| = EEE Ty \| Fl, — I \| NEW EHE... |
| gba-oak-hello-en | gba | overworld-dialog | 5.6% | 5.6% | 50.0% | 1.0/1 | 453 | 0 | Hello there! Glad to meet youd Welcome to the world of POKéMON |
| gba-battle-menu-en | gba | battle-menu | 66.8% | 66.8% | 11.1% | 2.8/4 | 1445 | 0 | “71 TORCHICS Lvs \| (2ST A FIGHT HARE |
| gba-battle-appeared-en | gba | battle-dialog | 81.6% | 79.5% | 0.0% | 1.3/3 | 1406 | 0 | rh TORCHICS Lvs |
| gba-route-sign-en | gba | location-sign | 80.6% | 80.6% | 0.0% | 0.5/1 | 2181 | 0 |  |
| gba-start-menu-en | gba | start-menu | 23.8% | 23.8% | 71.4% | 1.0/1 | 1094 | 0 | POKéMON BRE MARY SAVE OPTION EXIT |
| gb1-partial-hello-en | gb | overworld-dialog* | 23.5% | 23.5% | 25.0% | 1.5/1 | 915 | 0 | iF, -, "Fee \| Hello there! |
| gba-partial-hello-en | gba | overworld-dialog* | 0.0% | 0.0% | 100.0% | 1.0/1 | 182 | 0 | Hello there! Glad to me |
| gb1-overworld-notext | gb | no-text | - | - | - | 1.8/0 | 1484 | 0 | ERE \| A a oy A A |
| gb1-battle-intro-notext | gb | no-text | - | - | - | 0.0/0 | 389 | 0 |  |
| gba-overworld-notext | gba | no-text | - | - | - | 0.0/0 | 382 | 0 |  |
| gba-battle-intro-notext | gba | no-text | - | - | - | 0.0/0 | 361 | 0 |  |
| gb1-hola-es | gb | overworld-dialog | 21.3% | 21.3% | 25.0% | 2.3/1 | 1644 | 0 | E El A iS E A, - a, - \| iHola! al mundo de las Y |
| gb1-nino-es | gb | overworld-dialog | 0.7% | 0.7% | 87.5% | 3.0/1 | 1761 | 0 | A, - ", E. E " ñ A +, aaa \| mal AY \| El niña de al lado también ent... |
| gb2-aqui-es | gb | overworld-dialog | 22.6% | 21.8% | 25.0% | 1.0/1 | 316 | 0 | HQui está tu POKéMON. ¡Cuídalo! |
| gba-oak-hello-es | gba | overworld-dialog | 22.8% | 22.8% | 0.0% | 1.0/1 | 527 | 0 | Hola! ¡Encantado de conocerte! al mundo de los POKéMON! = |
| gb1-hello-fr | gb | overworld-dialog | 27.1% | 27.1% | 37.5% | 2.8/1 | 1519 | 0 | du du, =, Lu, =, = A, 25 A. \| du A, *, las FE, +, FA % A \| Eoniour!... |
| gb2-recu-fr | gb | overworld-dialog | 7.8% | 7.8% | 37.5% | 1.0/1 | 667 | 0 | Voila! Tu as reçu une POKé |
| gba-oak-hello-fr | gba | overworld-dialog | 8.1% | 8.1% | 50.0% | 1.0/1 | 697 | 0 | Bonjour! Ravi de te rencontrer! dans le monde des PÜKéMON! |

### legacy-neural: worst regions (x4-nearest when available)

| scene | kind | CER ci | expected | got (best-matching output region) |
|---|---|---|---|---|
| gb1-start-menu-de | menu | 100.0% | POKéDEX POKéMON ITEM ROT SICHERN OPTIONEN ZURÜCK | POKéDEX POKéMON ITEM a ROT à à • • SICHERN π OPTIONEN • H ZURÜCK - m • $ . • • • . a . . à - 8 • • • × |
| gb2-mart-de | dialog | 100.0% | Hallo! Willkommen im POKéMON-MARKT! | GELD 3000 K A U FE N V E R K A U F E N T S C H U S S ! Hallo! Willkommen im POKéMON-MARKT! |
| gb1-battle-wild-de | dialog | 100.0% | Ein wildes TAUBSI erscheint! | THUESI :L3 HF. BISASAM :L5 HP: 97 ZE Ein Wildes TAUBSI erscheint ! |
| gba-battle-menu-de | menu | 100.0% | KAMPF BEUTEL POKéMON FLUCHT | FIFFYEN Lv2 HF FLEMMLI [d Lv5 HF 19/ 20 Was soll KAMPF * BEUTEL FLEMMLI tun? POKéMON FLUCHT |
| gb2-mart-de | menu | 100.0% | KAUFEN VERKAUFEN TSCHÜSS! | GELD 3000 K A U FE N V E R K A U F E N T S C H U S S ! Hallo! Willkommen im POKéMON-MARKT! |
| gb1-battle-wild-en | hud | 100.0% | BULBASAUR :L5 HP: 19/ 20 | FIDGET :L3 HF BULBASAUR :L5 HP: 1 97 ZE Wild PIDGEY appeared! |
| gb1-battle-menu-en | hud | 100.0% | BULBASAUR :L5 HP: 19/ 20 | FI DGET :L3 HF' ............... BUL BASAUR :L5 HP 97 ZE FIGHT ITEM RUN |
| gba-battle-appeared-en | dialog | 100.0% | Wild POOCHYENA appeared! | POOCHYENA Lv2 HF TORCHIC Lv5 HF za Wild POOCHYENA appeared! |
| gb1-battle-wild-de | hud | 100.0% | BISASAM :L5 HP: 19/ 20 | THUESI :L3 HF. BISASAM :L5 HP: 97 ZE Ein Wildes TAUBSI erscheint ! |
| gb1-battle-menu-de | menu | 100.0% | KAMPF POKé ITEM FLUCHT | TAUESI :L3 HP: BISASAM :L5 HP: 2B KAMFF FOKé ITEM FLUCHT |
| gb1-battle-menu-de | hud | 100.0% | BISASAM :L5 HP: 7/ 20 | TAUESI :L3 HP: BISASAM :L5 HP: 2B KAMFF FOKé ITEM FLUCHT |
| gba-battle-menu-de | hud | 100.0% | FLEMMLI Lv5 HP 19/ 20 | FIFFYEN Lv2 HF FLEMMLI [d Lv5 HF 19/ 20 Was soll KAMPF * BEUTEL FLEMMLI tun? POKéMON FLUCHT |

### legacy-tesseract: worst regions (x4-nearest when available)

| scene | kind | CER ci | expected | got (best-matching output region) |
|---|---|---|---|---|
| gb1-battle-wild-de | hud | 100.0% | TAUBSI :L3 HP: | LS HF" VO, "19/7, 76 |
| gb1-battle-wild-en | hud | 100.0% | PIDGEY :L3 HP: | Mild FIDGEY appeared! v |
| gba-route-sign-en | sign | 100.0% | ROUTE 101 | (nothing) |
| gb1-mart-money-en | hud | 100.0% | $3000 | Hi there! Mau I help uou", v |
| gb1-battle-wild-en | hud | 91.7% | BULBASAUR :L5 HP: 19/ 20 | Mild FIDGEY appeared! v |
| gba-battle-menu-en | hud | 87.5% | POOCHYENA Lv2 HP | "71 TORCHICS Lvs |
| gb1-battle-menu-de | hud | 85.7% | BISASAM :L5 HP: 7/ 20 | LS HF |
| gb1-yesno-save-en | menu | 83.3% | YES NO | LN a |
| gba-battle-menu-de | menu | 81.5% | KAMPF BEUTEL POKéMON FLUCHT | I FLEMMLIS Lvö |
| gba-battle-appeared-en | hud | 81.3% | POOCHYENA Lv2 HP | rh TORCHICS Lvs |
| gba-battle-appeared-en | dialog | 79.2% | Wild POOCHYENA appeared! | rh TORCHICS Lvs |
| gb1-battle-menu-de | hud | 78.6% | TAUBSI :L3 HP: | LS HF |

### legacy-tesseract: false positives on no-text scenes

| scene | variant | output |
|---|---|---|
| gb2-overworld-notext | x4-nearest | A A X A A |
| gb2-overworld-notext | x6.25-nearest | a X Wii A A A |
| gb2-overworld-notext | fhd-letterbox-bilinear | ET SIT, 3 \| BB BB A A A A \| X, 8 j A, “ a A m |
| gb1-overworld-notext | x4-nearest | ERE \| A a oy A A |
| gb1-overworld-notext | fhd-letterbox-bilinear | I's, #F, “a A “a Tarte I \| Eo. TT \| iF, = g EE |
| gb1-overworld-notext | phone-bilinear | la, “al “a Fy - \| i ie 3 g Ed |

### Spell-correction changes (same OCR output, with vs without correctOcrText)

| adapter | scene | variant | change |
|---|---|---|---|
| legacy-neural | gb1-grass-warning-de | x4-nearest | `Vorsicht!` -> `Vorsieht!` |
| legacy-neural | gb1-grass-warning-de | fhd-letterbox-bilinear | `Vorsicht!:` -> `Vorsieht!:` |
| legacy-neural | gb1-draussen-de | x6.25-nearest | `gefährlicht` -> `gefährlich` |
| legacy-neural | gba-oak-hello-de | x4-nearest | `lernen!` -> `lerne!` |
| legacy-neural | gb1-partial-hello-de | fhd-letterbox-bilinear | `Willk` -> `Will` |
| legacy-neural | gb2-sign-en | phone-bilinear | `tha` -> `tho` |
| legacy-neural | gb1-hello-fr | fhd-letterbox-bilinear | `desv` -> `des` |
| legacy-neural | gb2-recu-fr | x4-nearest | `recu` -> `reçu` |
| legacy-neural | gba-oak-hello-fr | x4-nearest | `Bon,jour!` -> `Bonjour!` |
| legacy-tesseract | gb1-oak-hello-de | phone-bilinear | `Willkommer:` -> `Willkommen:` |
| legacy-tesseract | gb1-grass-warning-de | x4-nearest | `Vorsicht!` -> `Vorsieht!` |
| legacy-tesseract | gb1-draussen-de | x4-nearest | `ıst` -> `ıSt` |
| legacy-tesseract | gb1-pokedex-hyphen-de | x6.25-nearest | `zeıichnet` -> `zeichnet` |
| legacy-tesseract | gba-oak-hello-de | x4-nearest | `lernen!` -> `lerne!` |
| legacy-tesseract | gb1-partial-hello-de | x4-nearest | `Willk` -> `Will` |
| legacy-tesseract | gb1-oak-world-en | fhd-letterbox-bilinear | `Aus,` -> `Ans,` |
| legacy-tesseract | gb1-battle-menu-en | x4-nearest | `Elll` -> `Ell` |
| legacy-tesseract | gb1-yesno-save-en | x4-nearest | `Hould` -> `Hold` |
| legacy-tesseract | gb1-mart-money-en | x6.25-nearest | `alll` -> `all` |
| legacy-tesseract | gb2-shorts-en | x6.25-nearest | `andw` -> `and` |
| legacy-tesseract | gb2-sign-en | x6.25-nearest | `Hhere` -> `Here` |
| legacy-tesseract | gba-oak-hello-en | x4-nearest | `youd` -> `you` |
| legacy-tesseract | gb1-hello-fr | x4-nearest | `desv` -> `des` |
