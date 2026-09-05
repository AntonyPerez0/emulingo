import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// short git hash so a deployed site can be identified on-device (shown in
// the emulator toolbar and Settings); falls back for shallow/no-git builds
function buildId() {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'dev'; }
}

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
  build: { outDir: 'dist' },
  define: { __BUILD__: JSON.stringify(buildId()) }
});
