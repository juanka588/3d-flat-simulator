import { describe, expect, it, vi } from 'vitest';
import { PageSession, SessionError, type PageJob } from './pageSession';

/** Fast: the start-up race of the render page (no real browser): a cold start that was abandoned must not leak Chromium. */

const launch = vi.hoisted(() => ({ browsers: [] as Array<{ closed: boolean; close: () => Promise<void> }>, release: undefined as undefined | (() => void), entered: undefined as undefined | (() => void) }));

vi.mock('./browser', () => ({
  launchBrowser: vi.fn(async () => {
    const page = {
      on: () => undefined,
      goto: async () => undefined,
      waitForFunction: async () => undefined,
      evaluate: async () => undefined,
      close: async () => undefined,
    };
    const context = { addInitScript: async () => undefined, newPage: async () => page };
    const browser = {
      closed: false,
      on: () => undefined,
      close: async () => {
        browser.closed = true;
      },
      // The slow step of a cold start: the test holds it open while the render is abandoned.
      newContext: async () => {
        launch.entered?.();
        await new Promise<void>((ok) => (launch.release = ok));
        return context;
      },
    };
    launch.browsers.push(browser);
    return browser;
  }),
}));

const job = { scene: { epoch: 'e', rev: 0, scene: {} }, preview: false, pose: {}, lighting: {}, size: { width: 64, height: 64 }, format: 'png' } as unknown as PageJob;

describe('PageSession start-up race (#11: Chromium leak on a cold start that timed out)', () => {
  it('an open() that finishes after discard() closes its own browser and installs nothing', async () => {
    const session = new PageSession({ distDir: '/unused', webUrl: 'http://127.0.0.1:1/', channel: undefined, log: () => undefined });
    const entered = new Promise<void>((ok) => (launch.entered = ok));
    const pending = session.render(job).catch((e: unknown) => e);
    await entered; // the browser is launched, the context is being created
    expect(launch.browsers).toHaveLength(1);

    await session.discard(); // what a render timeout does
    expect(session.isWarm).toBe(false);

    launch.release!(); // the abandoned start now continues
    const error = await pending;
    expect(error).toBeInstanceOf(SessionError);
    expect((error as SessionError).kind).toBe('dead');
    expect(launch.browsers[0]!.closed).toBe(true);
    expect(session.isWarm).toBe(false);
    expect(session.browser).toBeUndefined();
  });
});
