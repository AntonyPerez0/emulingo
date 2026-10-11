// Content-Security-Policy for the production build, injected as a <meta> tag
// (GitHub Pages can't send headers). Dev keeps Vite's inline HMR client, so
// the policy is build-only.
//
// What needs what:
//  - EmulatorJS 4.2.3 (cdn.emulatorjs.org): loader and emulator scripts and
//    its stylesheet from the CDN; the core's JS runs from a blob: script, its
//    WebAssembly needs 'wasm-unsafe-eval', archives unpack in a blob: worker,
//    and it styles its controls inline. The RetroArch cores' Emscripten glue
//    builds its cwrap() wrappers with eval(), so the game can't start without
//    'unsafe-eval' (verified with the gambatte core in build/smoke.mjs).
//    Inline script stays blocked, which is what stops injected markup.
//  - OCR: module workers from our own origin (ONNX Runtime, Tesseract,
//    nspell); models are same-origin except the Japanese/Chinese recogniser
//    (Baidu's model CDN), Tesseract's language data and the Hunspell
//    dictionaries (jsDelivr).
//  - Translation: Google's endpoints, MyMemory as the fallback.
// A meta policy can't carry frame-ancestors, report-uri or sandbox.

export const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:', 'https://cdn.emulatorjs.org'],
  'worker-src': ["'self'", 'blob:'],
  'connect-src': [
    "'self'",
    'blob:',
    'data:',
    'https://cdn.emulatorjs.org',
    'https://cdn.jsdelivr.net',
    'https://translate.googleapis.com',
    'https://clients5.google.com',
    'https://api.mymemory.translated.net',
    'https://tessdata.projectnaptha.com',
    'https://paddle-model-ecology.bj.bcebos.com',
  ],
  'img-src': ["'self'", 'data:', 'blob:'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://cdn.emulatorjs.org'],
  'media-src': ["'self'", 'blob:'],
  'font-src': ["'self'", 'data:', 'https://cdn.emulatorjs.org'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'none'"],
};

export function serializeCsp(directives = CSP_DIRECTIVES) {
  return Object.entries(directives)
    .map(([name, values]) => [name, ...values].join(' '))
    .join('; ');
}

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Insert the policy right after <meta charset> so it governs everything below it. */
export function injectCsp(html, policy = serializeCsp()) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(policy)}">`;
  const charset = /<meta\s+charset=["']?[\w-]+["']?\s*\/?>/i;
  if (charset.test(html)) return html.replace(charset, (m) => `${m}\n  ${tag}`);
  return html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`);
}

/**
 * Vite plugin: adds the policy to the app's index.html in production builds
 * only (other HTML entries, e.g. test pages built with this config, are left
 * alone).
 */
export function contentSecurityPolicy({ policy = serializeCsp(), pages = ['/index.html'] } = {}) {
  return {
    name: 'emulingo:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        return pages.includes(ctx.path) ? injectCsp(html, policy) : html;
      },
    },
  };
}
