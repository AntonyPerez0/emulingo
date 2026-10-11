// ESLint flat config. Globals follow where code runs: the app in the browser
// (its *.worker.js files in a worker, the service worker in its own scope),
// tooling in Node, and the e2e/bench harnesses in both (Node scripts that
// hand closures to page.evaluate()).
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'bench/.cache/**',
      'bench/results/**',
      // frozen copies of the v1 code the OCR baseline was measured on, and the
      // harness that drives the v1 UI (tests/e2e-play covers the v2 app)
      'bench/legacy/**',
      'bench/e2e/run-e2e.mjs',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // `catch { /* best effort */ }` is the codebase's idiom for optional APIs
      'no-empty': ['error', { allowEmptyCatch: true }],
      // sanitisers strip control characters on purpose
      'no-control-regex': 'off',
      // flags `let x = fallback; try { x = … } catch {}` and `bytes = null`
      // (dropping a large buffer early), both deliberate here
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { globals: { ...globals.browser, __BUILD__: 'readonly' } },
  },
  {
    files: ['src/**/*.worker.js'],
    languageOptions: { globals: { ...globals.worker } },
  },
  {
    files: ['build/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['*.js', 'build/**/*.mjs', 'build/**/*.js'],
    ignores: ['build/sw.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // jsdom tests touch window/document; the harnesses run code in the page
    files: ['tests/**/*.{js,mjs}', 'bench/**/*.{js,mjs}', 'build/smoke.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // page.evaluate() closures use the test page's `window.t` helpers
    files: ['tests/e2e-emu/emu.e2e.mjs'],
    languageOptions: { globals: { t: 'readonly' } },
  },
  {
    // bench/fonts.js keeps a directive for a formatter rule this config lacks
    files: ['bench/**'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
];
