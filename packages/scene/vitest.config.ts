import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'scene',
    environment: 'node',
    // The fast-check property tests (400 runs on the Charme fixture) take 1-3 s on a developer machine but 5-8 s on
    // 2-vCPU shared runners while other workers compete, which tripped the 5 s default (camera-presets, commands/property).
    // Wall-clock budgets that matter are asserted explicitly in solve.test.ts, not through this timeout.
    testTimeout: process.env.CI ? 30_000 : 5_000,
  },
});
