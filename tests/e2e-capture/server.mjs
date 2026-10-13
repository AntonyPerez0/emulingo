// Tiny static file server + Chromium launcher for the capture checks.
// Serves the repo root (plain ES modules need no bundler) plus a few mounts.
// Ports stay inside 5400-5499 as agreed for this repo's tooling.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.gb': 'application/octet-stream', '.gba': 'application/octet-stream'
};

// mounts: { '/prefix/': '/abs/dir' }, pages: { '/path': htmlString }
export function startServer({ port, mounts = {}, pages = {} } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (pages[p] != null) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(pages[p]);
    }
    let file = null;
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (p.startsWith(prefix)) { file = path.join(dir, p.slice(prefix.length)); break; }
    }
    if (!file) file = path.join(REPO_ROOT, p);
    // '..' segments must not climb out (a sibling '/home/user/spritespeak2'
    // also starts with REPO_ROOT, hence the separator)
    const within = (dir) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
    const base = [REPO_ROOT, ...Object.values(mounts)].find(within);
    if (!base || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    fs.createReadStream(file).pipe(res);
  });
  // other tools share the 5400-5499 range: take the next free port
  return new Promise((resolve, reject) => {
    let p = port;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && p < 5499) server.listen(++p, '127.0.0.1');
      else reject(e);
    });
    server.on('listening', () => resolve({
      origin: `http://127.0.0.1:${p}`,
      close: () => new Promise((r) => server.close(() => r()))
    }));
    server.listen(p, '127.0.0.1');
  });
}

export async function launchChromium() {
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  const { chromium } = await import('playwright');
  return chromium.launch({
    headless: true,
    args: ['--no-proxy-server', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  });
}

export const BLANK = '<!doctype html><meta charset="utf-8"><title>capture</title><body style="margin:0;background:#000"></body>';
