import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser';

/**
 * Shrinks pictures to a small JPEG for the model to look at (CG3: product photos and library thumbnails come as WebP / JPEG /
 * PNG of any size). The MCP has no image library, so one tiny Chromium page does the decode and the JPEG encode; the browser
 * is started on first use and closed after a minute idle. Nothing is written to disk: bytes in, base64 out.
 */

export interface RawImage {
  data: Uint8Array;
  contentType: string;
}
export interface ShrunkImage {
  /** Base64 JPEG. */
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
}
export interface ImageShrinker {
  /** Each result is undefined when that picture could not be decoded. Never upscales. */
  shrinkAll(images: readonly RawImage[], maxSide: number): Promise<(ShrunkImage | undefined)[]>;
}

const IDLE_MS = 60_000;
let browser: Browser | undefined;
let page: Page | undefined;
let starting: Promise<Page> | undefined;
let idle: NodeJS.Timeout | undefined;

async function getPage(): Promise<Page> {
  if (page && browser?.isConnected()) return page;
  starting ??= (async () => {
    browser = await launchBrowser(undefined);
    browser.on('disconnected', () => {
      browser = undefined;
      page = undefined;
    });
    page = await browser.newPage();
    return page;
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

export async function closeShrinker(): Promise<void> {
  if (idle) clearTimeout(idle);
  const b = browser;
  browser = undefined;
  page = undefined;
  await b?.close().catch(() => undefined);
}

export const chromiumShrinker: ImageShrinker = {
  async shrinkAll(images, maxSide) {
    if (images.length === 0) return [];
    const p = await getPage();
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => void closeShrinker(), IDLE_MS);
    idle.unref();
    const input = images.map((i) => ({ b64: Buffer.from(i.data).toString('base64'), type: i.contentType }));
    const result = await p.evaluate(
      async ({ input, max }) => {
        const out: ({ data: string; width: number; height: number } | null)[] = [];
        for (const it of input) {
          try {
            const bin = atob(it.b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const bmp = await createImageBitmap(new Blob([bytes], { type: it.type }));
            const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
            const w = Math.max(1, Math.round(bmp.width * k));
            const h = Math.max(1, Math.round(bmp.height * k));
            const c = new OffscreenCanvas(w, h);
            const g = c.getContext('2d')!;
            g.fillStyle = '#fff';
            g.fillRect(0, 0, w, h);
            g.drawImage(bmp, 0, 0, w, h);
            const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
            const buf = new Uint8Array(await blob.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            out.push({ data: btoa(s), width: w, height: h });
          } catch {
            out.push(null);
          }
        }
        return out;
      },
      { input, max: maxSide },
    );
    return result.map((x) => (x ? { ...x, mimeType: 'image/jpeg' as const } : undefined));
  },
};
