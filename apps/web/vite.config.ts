import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * three's DRACOLoader names its five decoder files with `new URL(..., import.meta.url)`, so Vite would ship all of
 * them (a 700 kB asm.js fallback included) although we only ever use the glTF wasm pair, which model-loader.ts
 * imports explicitly (`?url`). Blank the default URLs so only the two files we load are emitted.
 */
const trimDracoDefaults = {
  name: 'flat:trim-draco-defaults',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!/[\\/]loaders[\\/]DRACOLoader\.js$/.test(id.split('?')[0]!)) return null;
    return code.replace(/new URL\(\s*'\.\.\/libs\/draco\/[^']+',\s*import\.meta\.url\s*\)\.toString\(\)/g, "''");
  },
};

export default defineConfig({
  plugins: [react(), trimDracoDefaults],
  // GitHub Pages serves the app from /<repo>/; set BASE_PATH there, '/' everywhere else.
  base: process.env.BASE_PATH ?? '/',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: { name: 'web', environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
