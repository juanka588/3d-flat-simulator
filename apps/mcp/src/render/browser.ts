import type { Browser } from 'playwright';

/**
 * Launching the one warm Chromium. `playwright` is imported lazily here and nowhere else, so the
 * non-render tools (and stdio start-up) never load it.
 *
 * Default: the Chromium bundled with Playwright with software WebGL (SwiftShader), the same flags as
 * `playwright.config.ts`: no GPU needed, identical output everywhere. `FLAT_RENDER_CHANNEL=chrome`
 * uses the installed Google Chrome with its GPU instead (nicer, faster; pixels differ by GPU).
 */

export const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export type RenderChannel = 'chrome' | undefined;

export function launchArgs(channel: RenderChannel): string[] {
  return channel === 'chrome' ? ['--ignore-gpu-blocklist'] : SWIFTSHADER_ARGS;
}

export async function launchBrowser(channel: RenderChannel): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, args: launchArgs(channel), ...(channel === 'chrome' ? { channel: 'chrome' } : {}) });
}
