import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import { facadeSymbols } from './scripts/refactor/rewrite-imports.mjs';

// Local-only boundary (D4): provider code (retailer scraping, product photos / models) lives in apps/server and
// must never be bundled into the web app or the shared packages, which end up on GitHub Pages.
const SERVER_BOUNDARY = [
  { group: ['**/apps/server', '**/apps/server/**', '**/server/src/**', '@flat/server', '@flat/server/**'], message: 'The web app and the packages must not import the local server (D4: no retailer code in the Pages bundle).' },
  { group: ['**/providers', '**/providers/**'], message: 'Provider code is server-only (D4); talk to it through the HTTP API.' },
];

// ---- Shared pattern groups (modules.md section 2.1).
const pkg = (names, message) => ({ group: names.flatMap((n) => [n, `${n}/**`]), message });
const NO_RENDERER = { group: ['three', 'three/*', '@react-three/*', 'react', 'react-dom', 'zustand'], message: 'Pure package: no renderer or UI framework.' };
const NO_NODE = { group: ['node:*', 'fs', 'fs/*', 'path', 'http', 'https', 'child_process'], message: 'Universal entry: node built-ins only under src/node/ (tests excepted).' };
const NO_SRC_ESCAPE = { group: ['**/packages/*/src/**', '**/apps/*/src/**', ...['scene', 'assets', 'site', 'viewer', 'capture', 'server', 'mcp', 'web'].map((n) => `**/${n}/src/**`)], message: 'Import other packages by name, never by relative path.' };
const NO_SRC_ESCAPE_EXCEPT_SERVER = { ...NO_SRC_ESCAPE, group: NO_SRC_ESCAPE.group.filter((g) => !g.includes('/server/')) };
const APPS_LEAF = pkg(['@flat/web', '@flat/mcp'], 'Apps are leaves of the graph: nothing imports them.');
// Step A3 (modules.md section 4): the asset and product-wire symbols are imported from @flat/assets, never from @flat/scene.
// The list IS the named export list of packages/assets/src/index.ts. Removed in step 11, when scene no longer has them.
const ASSET_NAMES = facadeSymbols();
const ASSETS_NOT_FROM_SCENE = 'Import asset and product-wire symbols from @flat/assets, not @flat/scene (modules.md step A3).';
const SCENE_ASSET_PATHS = [{ name: '@flat/scene', importNames: ASSET_NAMES, message: ASSETS_NOT_FROM_SCENE }];
const SCENE_ASSET_PATTERN = { group: ['**/packages/scene/src', '**/packages/scene/src/**'], importNames: ASSET_NAMES, message: ASSETS_NOT_FROM_SCENE };
const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns: [...patterns, ...SERVER_BOUNDARY] }] });
const TESTS = ['**/*.test.{ts,tsx}', '**/test/**', '**/fixtures/**'];

/**
 * The blocks for one row of the matrix. The first block applies `patterns` to every file of `dir` (tests included);
 * unless `node` is set, a second block adds NO_NODE for the non-test sources. `src` narrows both to a sub-directory,
 * `srcIgnores` carves out directories that follow another row, and `server` marks the apps that ARE the server side
 * (they do not take SERVER_BOUNDARY).
 */
function row(dir, patterns, { node = false, src = dir, all = src, srcIgnores = [], server = false, paths = [] } = {}) {
  const make = (extra) => restrictFor(server, [...patterns, ...extra], paths);
  const glob = (d) => [`${d}/**/*.{ts,tsx}`];
  const blocks = [{ files: glob(all), ignores: srcIgnores, rules: make([]) }];
  if (!node) blocks.push({ files: glob(src), ignores: [...srcIgnores, ...TESTS], rules: make([NO_NODE]) });
  return blocks;
}
const restrictFor = (server, patterns, paths = []) => ({ 'no-restricted-imports': ['error', { paths, patterns: server ? patterns : [...patterns, ...SERVER_BOUNDARY] }] });

export default tseslint.config(
  { ignores: ['.claude/**', '.tmp/**', 'test-results/**', 'playwright-report/**', '**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/viewer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The web app and the shared packages never import the server or provider code (D4).
    files: ['apps/web/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: SERVER_BOUNDARY }] },
  },
  // ---- Per-package boundaries (docs/architecture/modules.md section 2). Declared before most packages exist: a glob that
  // matches nothing is a no-op, so the migration lanes never touch this file. A later block REPLACES the rule options of an
  // earlier one for the same file, so every block is built from the shared pattern groups above and repeats SERVER_BOUNDARY.
  // packages/scene: root of the graph. No renderer, no node built-ins (tests excepted), no other package.
  ...row('packages/scene', [NO_RENDERER, NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/assets', '@flat/site', '@flat/viewer', '@flat/capture'], 'scene is the root of the graph: it imports no other package.')]),
  // Temporary (removed in step 11): scene tests run against the real generators through this one setup file.
  {
    files: ['packages/scene/test/generators.setup.ts'],
    rules: restrict(NO_RENDERER, APPS_LEAF, pkg(['@flat/assets', '@flat/site', '@flat/viewer', '@flat/capture'], 'scene is the root of the graph: it imports no other package.')),
  },
  // @flat/scene/live (section 8.2): pure types, zod and applyLiveState; no Home Assistant, renderer or node code.
  ...row('packages/scene', [NO_RENDERER, NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/assets', '@flat/site', '@flat/viewer', '@flat/capture', '@flat/scene'], '@flat/scene/live is a pure leaf of scene: relative imports inside scene only.')], { src: 'packages/scene/src/live' }),
  // packages/assets: universal entry (no node, no renderer); src/node is the node-only entry.
  ...row('packages/assets', [NO_RENDERER, NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/site', '@flat/viewer', '@flat/capture', '@flat/assets/node'], 'assets depends on scene only, and its universal entry never reaches the node entry.')], { srcIgnores: ['packages/assets/src/node/**'] }),
  ...row('packages/assets/src/node', [NO_RENDERER, NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/site', '@flat/viewer', '@flat/capture'], 'assets/node depends on scene and assets only.')], { node: true }),
  // packages/site
  ...row('packages/site', [NO_RENDERER, NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/assets', '@flat/viewer', '@flat/capture', '@flat/site/node'], 'site depends on scene only, and its universal entry never reaches the node entry.')], { srcIgnores: ['packages/site/src/node/**', 'packages/site/legacy/**'] }),
  ...row('packages/site/src/node', [NO_RENDERER, NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/assets', '@flat/viewer', '@flat/capture'], 'site/node depends on scene and site only.')], { node: true }),
  // packages/capture: contracts only; site is allowed (EXIF GPS to ENU).
  ...row('packages/capture', [NO_RENDERER, NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/assets', '@flat/viewer', '@flat/site/node'], 'capture depends on scene (and, if needed, site) only.')]),
  // packages/viewer: the rendering library. No editor or app code, no site/capture, no node entries.
  ...row('packages/viewer', [NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/site', '@flat/capture', '@flat/assets/node', '@flat/site/node'], 'viewer depends on scene and assets (universal entry) only.')]),
  // @flat/viewer/element (section 8.2): the custom element depends on the viewer alone, through relative imports.
  ...row('packages/viewer', [NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/scene', '@flat/assets', '@flat/site', '@flat/capture', '@flat/site/node'], '@flat/viewer/element depends on the viewer only; React stays an implementation detail.')], { src: 'packages/viewer/src/element' }),
  // apps/web: the UI shell. The test internals are for testHook*.ts only; node entries and the server are never imported.
  ...row('apps/web', [NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/assets/node', '@flat/site/node', '@flat/viewer/testing'], 'apps/web imports the public entries only; @flat/viewer/testing belongs to testHook*.ts.')], { all: 'apps/web/src', src: 'apps/web/src', srcIgnores: ['apps/web/src/testHook*.ts'], paths: SCENE_ASSET_PATHS }),
  {
    files: ['apps/web/src/testHook*.ts'],
    rules: restrictFor(false, [NO_SRC_ESCAPE, APPS_LEAF, pkg(['@flat/assets/node', '@flat/site/node'], 'testHook may use @flat/viewer/testing but no node entry.')], SCENE_ASSET_PATHS),
  },
  // apps/server: node is fine; no renderer, no viewer, no other app. It may be the target of apps/mcp/src/testing only.
  ...row('apps/server', [NO_RENDERER, NO_SRC_ESCAPE, pkg(['@flat/viewer', '@flat/web', '@flat/mcp'], 'The server never imports the viewer or another app.')], { node: true, server: true, paths: SCENE_ASSET_PATHS }),
  // apps/mcp: node is fine; no renderer, viewer, capture or node entries of assets; the server only from the test harness.
  ...row('apps/mcp', [NO_RENDERER, NO_SRC_ESCAPE, pkg(['@flat/viewer', '@flat/capture', '@flat/assets/node', '@flat/web'], 'The MCP app imports scene, assets and site only.'), pkg(['@flat/server'], 'Only src/testing/** (the test harness) may import the server.')], { node: true, server: true, paths: SCENE_ASSET_PATHS, srcIgnores: ['apps/mcp/src/testing/**'] }),
  {
    files: ['apps/mcp/src/testing/**/*.ts'],
    // The harness reaches into @flat/server/src/** on purpose (dev-only edge, no exports on the server package).
    rules: restrictFor(true, [NO_RENDERER, NO_SRC_ESCAPE_EXCEPT_SERVER, pkg(['@flat/viewer', '@flat/capture', '@flat/assets/node', '@flat/web'], 'The MCP app imports scene, assets and site only.')], SCENE_ASSET_PATHS),
  },
  // Root-level consumers (not packages: they reach scene and assets by relative path). apps/web has the same rule (A3a).
  {
    files: ['scripts/**/*.{ts,mjs}', 'e2e/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: SCENE_ASSET_PATHS, patterns: [SCENE_ASSET_PATTERN] }] },
  },
  {
    // On stdio, stdout is the JSON-RPC channel: any console.log/info/debug would corrupt the protocol.
    // Log through `config.log` (stderr) or console.error/warn.
    files: ['apps/mcp/src/**/*.ts'],
    rules: { 'no-console': ['error', { allow: ['warn', 'error'] }] },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
