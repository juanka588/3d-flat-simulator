import { defineProject } from 'vitest/config';

export default defineProject({
  // A cold render (browser, viewer, ~30 shader programs under SwiftShader) takes 15-30 s on a 4-vCPU runner.
  test: { name: 'mcp', environment: 'node', testTimeout: process.env.CI ? 120_000 : 30_000 },
});
