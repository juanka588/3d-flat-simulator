import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'scripts', environment: 'node', include: ['**/*.test.mjs', '**/*.test.ts'] } });
