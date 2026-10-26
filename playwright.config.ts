import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
const MOBILE_SPEC = '**/mobile.e2e.ts';
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
    {
      // The whole suite except the mobile spec, on desktop Chrome.
      name: 'chromium',
      testIgnore: MOBILE_SPEC,
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
      testMatch: MOBILE_SPEC,
      use: { ...devices['iPhone 13'], browserName: 'chromium', launchOptions: SOFTWARE_GL },
    },
    {
      name: 'mobile-pixel',
      testMatch: MOBILE_SPEC,
      use: { ...devices['Pixel 7'], launchOptions: SOFTWARE_GL },
    },
    ...(process.env.E2E_WEBKIT
      ? [{ name: 'mobile-safari', testMatch: MOBILE_SPEC, use: { ...devices['iPhone 13'] } }]
      : []),
  ],
  webServer: {
    command: 'npx -y pnpm@10.34.7 --filter @flat/web dev',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
