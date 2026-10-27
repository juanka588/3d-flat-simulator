import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Local-only boundary (D4): provider code (retailer scraping, product photos / models) lives in apps/server and
// must never be bundled into the web app or the shared packages, which end up on GitHub Pages.
const SERVER_BOUNDARY = [
  { group: ['**/apps/server', '**/apps/server/**', '**/server/src/**', '@flat/server', '@flat/server/**'], message: 'The web app and the packages must not import the local server (D4: no retailer code in the Pages bundle).' },
  { group: ['**/providers', '**/providers/**'], message: 'Provider code is server-only (D4); talk to it through the HTTP API.' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
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
  {
    // The scene package must stay renderer-agnostic so it runs in node, the MCP server and tests
    // (and, like the web app, it may not import the server). A later block replaces the rule's options, so both lists are here.
    files: ['packages/scene/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['three', 'three/*', '@react-three/*', 'react', 'react-dom'] }, ...SERVER_BOUNDARY] },
      ],
    },
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
