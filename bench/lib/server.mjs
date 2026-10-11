// Shared headless harness plumbing: a programmatic Vite dev server rooted at
// the repo + a headless Chromium (Playwright) with the CDN routes installed.

import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdnRouter, VITE_OPTIMIZE_DEPS } from './routes.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// entries: html files (relative to the repo) Vite should crawl for deps
export async function startVite({ entries = ['bench/bench.html'], log = () => {} } = {}) {
  const { createServer } = await import('vite');
  const port = await freePort();
  const server = await createServer({
    root: REPO_ROOT,
    configFile: path.join(REPO_ROOT, 'vite.config.js'),
    // separate optimizer cache so a concurrently running `npm run dev` or
    // another harness never races on node_modules/.vite
    cacheDir: path.join(REPO_ROOT, 'node_modules', '.vite-bench'),
    logLevel: 'warn',
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
      watch: { ignored: ['**/bench/results/**', '**/bench/.cache/**', '**/node_modules/**', '**/dist/**'] }
    },
    optimizeDeps: { entries, include: VITE_OPTIMIZE_DEPS }
  });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  log(`[vite] dev server at ${origin}`);
  return { server, origin, close: () => server.close() };
}

export async function launchBrowser({ headless = true, log = () => {} } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless,
    args: ['--no-proxy-server', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  });
  log(`[chromium] ${browser.version()}`);
  return browser;
}

// One-call setup: Vite + Chromium + context with CDN routes. Returns
// { origin, browser, context, router, close }.
export async function startHarness({ entries, log = () => {}, routerOptions = {} } = {}) {
  const vite = await startVite({ entries, log });
  let browser;
  try {
    browser = await launchBrowser({ log });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const router = createCdnRouter({ repoRoot: REPO_ROOT, viteOrigin: vite.origin, log, ...routerOptions });
    await router.install(context);
    return {
      origin: vite.origin,
      browser,
      context,
      router,
      async close() {
        try { await browser.close(); } catch {}
        try { await vite.close(); } catch {}
      }
    };
  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    await vite.close();
    throw e;
  }
}
