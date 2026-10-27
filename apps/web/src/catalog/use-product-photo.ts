import { useEffect, useState } from 'react';
import { fetchProductPhoto, serverRef } from './api';

/** Blob URLs of photos already read through the server's proxy, newest last (a blob URL is revoked when it falls out). */
const MAX_PHOTOS = 80;
const photos = new Map<string, Promise<string | null>>();

function load(productId: string): Promise<string | null> {
  let hit = photos.get(productId);
  if (!hit) {
    hit = fetchProductPhoto(serverRef(), productId).then(
      (blob) => URL.createObjectURL(blob),
      () => null, // no photo, no server or no proxy yet: the card shows its initial
    );
    photos.set(productId, hit);
    if (photos.size > MAX_PHOTOS) {
      const oldest = photos.keys().next().value as string;
      const gone = photos.get(oldest);
      photos.delete(oldest);
      void gone?.then((u) => u && URL.revokeObjectURL(u));
    }
  }
  return hit;
}

/**
 * The photo of a product as a blob URL read from the LOCAL server (`/api/products/:id/photo`, with `fetch` so the
 * server sees an Origin), or null while loading, without a photo, or without a server. Never the retailer's URL.
 */
export function useProductPhoto(productId: string | undefined, hasPhoto: boolean): string | null {
  const [loaded, setLoaded] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!productId || !hasPhoto || !serverRef()) return;
    let live = true;
    void load(productId).then((url) => live && setLoaded({ id: productId, url }));
    return () => {
      live = false;
    };
  }, [productId, hasPhoto]);
  return productId && hasPhoto && loaded?.id === productId ? loaded.url : null;
}
