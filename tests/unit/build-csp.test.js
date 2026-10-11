// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP_DIRECTIVES, serializeCsp, injectCsp } from '../../build/csp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const hostsIn = (text) => [...new Set([...text.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})\//g)].map((m) => m[1]))];

describe('serializeCsp', () => {
  it('locks down what a meta policy can', () => {
    const csp = serializeCsp();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'none'");
    // no inline script or event-handler attributes: the stored-XSS vectors
    // of v1 stay closed ('unsafe-eval' is for EmulatorJS's cores, see csp.js)
    expect(CSP_DIRECTIVES['script-src']).not.toContain("'unsafe-inline'");
    expect(CSP_DIRECTIVES['script-src']).not.toContain('*');
    expect(CSP_DIRECTIVES['script-src']).toContain("'wasm-unsafe-eval'");
  });

  it('allows every host the app talks to, and only those', () => {
    const sources = [
      'src/core/translate.js', 'src/core/emulator.js', 'src/core/ocr/engine.js',
      'src/core/ocr/tesseract.js', 'src/core/ocr/correct.js',
    ].map(read).join('\n');
    // comments may cite documentation sites; only URLs in string literals count
    const code = sources.replace(/^\s*(\/\/|\*).*$/gm, '');
    const used = hostsIn(code).sort();
    const allowed = CSP_DIRECTIVES['connect-src'].filter((s) => s.startsWith('https://')).map((s) => s.slice(8)).sort();
    expect(used).toEqual(allowed);
  });
});

describe('injectCsp', () => {
  it('puts the policy right after the charset declaration', () => {
    const html = '<!doctype html><html><head>\n  <meta charset="utf-8">\n  <title>x</title></head></html>';
    const out = injectCsp(html, "default-src 'self'");
    expect(out).toMatch(/<meta charset="utf-8">\n {2}<meta http-equiv="Content-Security-Policy" content="default-src 'self'">\n {2}<title>/);
  });

  it('escapes the attribute and falls back to the head', () => {
    const out = injectCsp('<html><head><title>x</title></head></html>', 'a "b" & c');
    expect(out).toContain('<head>\n  <meta http-equiv="Content-Security-Policy" content="a &quot;b&quot; &amp; c">');
  });

  it('matches the app’s index.html', () => {
    expect(injectCsp(read('index.html'))).toMatch(/<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy"/);
  });
});
