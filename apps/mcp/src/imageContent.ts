import type { CallToolResult } from '@modelcontextprotocol/server';
import { chromiumShrinker, type ImageShrinker, type RawImage } from './render/shrink';

/**
 * Pictures for the model (CG3). Product photos are retailer content, personal use, local only: they are shrunk in memory and
 * returned in the tool result of the local session. They are never written to a file, a log or a scene, and never sent to an
 * image API (the providers refuse them by construction, see `ImageProvenance`).
 */

/** `get_product {photo}`. */
export const PHOTO_MAX_SIDE = 384;
/** `search_products {thumbs}`, `search_assets {thumbs}`, `match_crop`. */
export const THUMB_MAX_SIDE = 160;
/** Thumbnails per call. */
export const MAX_THUMBS = 8;

let override: ImageShrinker | undefined;
export const setImageShrinker = (s: ImageShrinker | undefined): void => {
  override = s;
};

type Item = CallToolResult['content'][number];

export interface Labelled {
  label: string;
  raw: RawImage;
}

/** `[text label, image]` pairs (the label tells which product the picture is), JPEG of at most `maxSide`. Undecodable pictures are listed in `skipped`. */
export async function pictureContent(items: readonly Labelled[], maxSide: number): Promise<{ content: Item[]; skipped: string[] }> {
  const content: Item[] = [];
  const skipped: string[] = [];
  let shrunk: Awaited<ReturnType<ImageShrinker['shrinkAll']>>;
  try {
    shrunk = await (override ?? chromiumShrinker).shrinkAll(
      items.map((i) => i.raw),
      maxSide,
    );
  } catch {
    shrunk = items.map(() => undefined);
  }
  items.forEach((it, i) => {
    const s = shrunk[i];
    if (!s) {
      skipped.push(it.label);
      return;
    }
    content.push({ type: 'text', text: it.label }, { type: 'image', data: s.data, mimeType: s.mimeType });
  });
  return { content, skipped };
}
