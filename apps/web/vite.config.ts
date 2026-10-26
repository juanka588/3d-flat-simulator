import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves the app from /<repo>/; set BASE_PATH there, '/' everywhere else.
  base: process.env.BASE_PATH ?? '/',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: { name: 'web', environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
