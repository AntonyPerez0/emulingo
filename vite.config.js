import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { contentSecurityPolicy } from './build/csp.js';
import { serviceWorker, serviceWorkerDevReset } from './build/sw-plugin.js';

// Short commit id so a deployed site can be identified (Settings › About).
// CI provides GITHUB_SHA; locally ask git quietly; otherwise 'dev'.
function buildId() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
  } catch {
    return 'dev';
  }
}

const BUILD = buildId();

export default defineConfig({
  // relative URLs: the same build works from a sub-path (GitHub Pages
  // project sites) or a domain root
  base: './',
  server: { port: 5173, strictPort: false },
  preview: { port: 4173, strictPort: false },
  build: {
    outDir: 'dist',
    // ES2022 syntax, lowered where Safari 16.0–16.3 lacks it (class static
    // blocks; regex lookbehind becomes a runtime RegExp)
    target: ['es2022', 'chrome111', 'firefox111', 'safari16'],
    // the OCR worker bundles onnxruntime-web (~0.4 MB JS); its 14 MB .wasm,
    // the model tars and the Tesseract core are separate assets
    chunkSizeWarningLimit: 1500,
  },
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [contentSecurityPolicy(), serviceWorker({ build: BUILD }), serviceWorkerDevReset()],
  // module workers so the OCR worker can import onnxruntime-web and models.js
  worker: { format: 'es' },
  optimizeDeps: {
    // onnxruntime-web locates its .wasm itself (we pass the URL) and the
    // Tesseract ESM build is self-contained: serve both untouched in dev
    // (deep imports listed too: the worker is discovered only at runtime,
    // and a late pre-bundle would force a full page reload)
    exclude: ['onnxruntime-web', 'onnxruntime-web/wasm', 'tesseract.js', 'tesseract.js/dist/tesseract.esm.min.js'],
    // nspell is CommonJS and only imported by the spell-check worker, which
    // the dev server discovers late: pre-bundle it up front for the same reason
    include: ['nspell'],
  },
  test: {
    include: ['tests/unit/**/*.test.js'],
  },
});
