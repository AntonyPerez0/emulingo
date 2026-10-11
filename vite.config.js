import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

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

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
  build: {
    outDir: 'dist',
    // the OCR worker bundles onnxruntime-web (~0.4 MB JS); its 14 MB .wasm,
    // the model tars and the Tesseract core are separate assets
    chunkSizeWarningLimit: 1500
  },
  define: { __BUILD__: JSON.stringify(buildId()) },
  // module workers so the OCR worker can import onnxruntime-web and models.js
  worker: { format: 'es' },
  optimizeDeps: {
    // onnxruntime-web locates its .wasm itself (we pass the URL) and the
    // Tesseract ESM build is self-contained: serve both untouched in dev
    // (deep imports listed too: the worker is discovered only at runtime,
    // and a late pre-bundle would force a full page reload)
    exclude: ['onnxruntime-web', 'onnxruntime-web/wasm', 'tesseract.js', 'tesseract.js/dist/tesseract.esm.min.js']
  }
});
