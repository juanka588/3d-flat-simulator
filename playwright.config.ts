import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5173);
/** The production build served by `vite preview` under the GitHub Pages base path (e2e/static.e2e.ts). */
const STATIC_PORT = 4173;
const STATIC_BASE = '/3d-flat-simulator/';
/** E2E_STATIC=only runs just the static project (CI `e2e-static`), E2E_STATIC=skip leaves it out; unset runs everything. */
const STATIC = process.env.E2E_STATIC ?? 'all';
const STATIC_SPEC = '**/static*.e2e.ts';
const MOBILE_SPEC = '**/mobile.e2e.ts';
/** Specs that also run on the mobile projects (they skip the tests that do not fit the layout). */
const MOBILE_SPECS = [MOBILE_SPEC, '**/finishes.e2e.ts'];
// e2e/sync.e2e.ts (live sync) is picked up by the desktop `chromium` project only: it boots its own
// apps/server per test (node --import tsx, a devDependency of @flat/server), so CI needs no extra step.
/** Software WebGL so the suite runs on machines/CI without a GPU. */
const SOFTWARE_GL = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    // The production build under the Pages base path (e2e/static.e2e.ts only).
    ...(STATIC !== 'skip'
      ? [
          {
            name: 'static',
            testMatch: STATIC_SPEC,
            use: {
              ...devices['Desktop Chrome'],
              baseURL: `http://127.0.0.1:${STATIC_PORT}${STATIC_BASE}`,
              viewport: { width: 1280, height: 800 },
              launchOptions: SOFTWARE_GL,
            },
          },
        ]
      : []),
    ...(STATIC === 'only'
      ? []
      : [
    {
      // The whole suite except the mobile spec, on desktop Chrome.
      name: 'chromium',
      testIgnore: [MOBILE_SPEC, STATIC_SPEC],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: SOFTWARE_GL,
      },
    },
    // Mobile projects run only e2e/mobile.e2e.ts. The iPhone 13 project is Chromium with the iPhone
    // viewport, DPR, user agent and touch (isMobile + hasTouch): software WebGL in WebKit is not
    // available on every CI image. Set E2E_WEBKIT=1 (after `npx playwright install webkit`) to also run
    // the same spec in real WebKit ("mobile-safari").
    {
      name: 'mobile-iphone',
      testMatch: MOBILE_SPECS,
      use: { ...devices['iPhone 13'], browserName: 'chromium' as const, launchOptions: SOFTWARE_GL },
    },
    {
      name: 'mobile-pixel',
      testMatch: MOBILE_SPECS,
      use: { ...devices['Pixel 7'], launchOptions: SOFTWARE_GL },
    },
    ...(process.env.E2E_WEBKIT
      ? [{ name: 'mobile-safari', testMatch: MOBILE_SPECS, use: { ...devices['iPhone 13'] } }]
      : []),
      ]),
  ],
  webServer: [
    ...(STATIC === 'only'
      ? []
      : [
          {
            command: `npx -y pnpm@10.34.7 --filter @flat/web exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
            url: `http://127.0.0.1:${PORT}`,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ]),
    ...(STATIC !== 'skip'
      ? [
          {
            // Build for the Pages base path, then serve dist exactly as Pages would.
            command: `npx -y pnpm@10.34.7 --filter @flat/web build && npx -y pnpm@10.34.7 --filter @flat/web exec vite preview --host 127.0.0.1 --port ${STATIC_PORT} --strictPort`,
            url: `http://127.0.0.1:${STATIC_PORT}${STATIC_BASE}`,
            env: { BASE_PATH: STATIC_BASE },
            reuseExistingServer: !process.env.CI,
            timeout: 240_000,
          },
        ]
      : []),
  ],
});
