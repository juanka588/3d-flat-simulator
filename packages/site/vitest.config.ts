import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'site',
    environment: 'node',
    silent: 'passed-only', // the CLI under test is chatty; its output only matters when a test fails
    // The golden test runs the rigid fit (Nelder-Mead over ~160 building rings): about 15 s on a developer machine.
    testTimeout: process.env.CI ? 180_000 : 60_000,
  },
});
