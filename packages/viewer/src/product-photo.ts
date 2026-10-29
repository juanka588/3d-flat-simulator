import { dominantColour } from '@flat/assets';
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { viewerConfig } from './config';

/**
 * Product photos for the stand-ins of products without a 3D model (CG8). The photo is read from the LOCAL scene server
 * (`/api/products/:id/photo`, with `fetch` so the server sees an Origin; never the retailer) and only when the viewer is
 * connected to one: in Pages / Local mode nothing is requested and the stand-ins keep their palette colours.
 *
 * Each photo becomes a small square `CanvasTexture` of its centre (the product on a white backdrop leaves the centre as
 * the pile, print or picture) plus its dominant colour. Results are cached per origin and product; only the newest
 * `MAX_PHOTOS` textures are kept (older ones are disposed, and re-read if they are needed again).
 */
export interface ProductPhoto {
  texture: CanvasTexture;
  /** Dominant colour of the photo (backdrop ignored), or undefined for an all-white product. */
  dominant: string | undefined;
}

export const MAX_PHOTOS = 24;
/** Side of the cropped texture in pixels. */
export const PHOTO_TEXTURE_SIZE = 256;
/** Share of the photo kept around its centre. */
export const PHOTO_CROP = 0.4;

const cache = new Map<string, Promise<ProductPhoto | null>>();

/** The centre crop of `source` as a `size` square canvas, and the dominant colour of the whole photo (sampled at 64 px). */
export function analysePhoto(source: CanvasImageSource & { width: number; height: number }, makeCanvas: (w: number, h: number) => HTMLCanvasElement): { canvas: HTMLCanvasElement; dominant: string | undefined } | null {
  const sw = source.width;
  const sh = source.height;
  if (!(sw > 0 && sh > 0)) return null;
  const canvas = makeCanvas(PHOTO_TEXTURE_SIZE, PHOTO_TEXTURE_SIZE);
  const ctx = canvas.getContext('2d');
  const small = makeCanvas(64, 64);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx || !sctx) return null;
  const side = Math.min(sw, sh) * PHOTO_CROP;
  ctx.drawImage(source, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, PHOTO_TEXTURE_SIZE, PHOTO_TEXTURE_SIZE);
  sctx.drawImage(source, 0, 0, sw, sh, 0, 0, 64, 64);
  return { canvas, dominant: dominantColour(sctx.getImageData(0, 0, 64, 64).data, 64, 64) };
}

async function read(origin: string, productId: string): Promise<ProductPhoto | null> {
  try {
    const res = await fetch(`${origin}/api/products/${encodeURIComponent(productId)}/photo`);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    const bitmap = await createImageBitmap(blob);
    const made = analysePhoto(bitmap, (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    });
    bitmap.close();
    if (!made) return null;
    const texture = new CanvasTexture(made.canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    return { texture, dominant: made.dominant };
  } catch {
    return null;
  }
}

/** The photo of a product, or null without a server, without a photo, or when it cannot be read (a stand-in then shows its colour). */
export function loadProductPhoto(productId: string): Promise<ProductPhoto | null> {
  const origin = viewerConfig.modelOrigin();
  if (!origin) return Promise.resolve(null);
  const key = `${origin}\u0000${productId}`;
  let hit = cache.get(key);
  if (hit) {
    cache.delete(key); // most recently used last
  } else {
    hit = read(origin, productId);
  }
  cache.set(key, hit);
  const mine = hit;
  void mine.then((p) => {
    if (!p && cache.get(key) === mine) cache.delete(key); // a failure is not remembered: the next request tries again
  });
  while (cache.size > MAX_PHOTOS) {
    const oldest = cache.keys().next().value as string;
    const gone = cache.get(oldest);
    cache.delete(oldest);
    void gone?.then((p) => p?.texture.dispose());
  }
  return hit;
}

/** Test hook: forgets every photo (and disposes the textures). */
export function resetProductPhotos(): void {
  for (const p of cache.values()) void p.then((x) => x?.texture.dispose());
  cache.clear();
}

/** Photos in the cache, for tests. */
export const productPhotoCount = (): number => cache.size;
