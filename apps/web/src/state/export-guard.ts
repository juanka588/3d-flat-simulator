import { ItemBase, ProductRef, ProductSnapshot } from '@flat/scene';

/**
 * M5.14 / D4: what a saved or exported flat may contain about products. Only `productRef` and the `product`
 * snapshot, never photos or models; the only URL in the file is `product.url` (the buy link).
 */
export const FORBIDDEN_KEYS: readonly string[] = ['photoUrl', 'photo', 'photos', 'image', 'images', 'thumbnail', 'thumb', 'modelRef', 'model', 'glb', 'gltf', 'modelUrl', 'blob', 'base64', 'positions', 'indices', 'normals', 'uvs'];

const ITEM_KEYS = new Set(Object.keys(ItemBase.shape));
const PRODUCT_KEYS = new Set(Object.keys(ProductSnapshot.shape));
const REF_KEYS = new Set(Object.keys(ProductRef.shape));
const URL_RE = /(https?:)?\/\/|^data:|\.(glb|gltf|jpe?g|png|webp)(\?|$)/i;

/** Every way the document breaks the rule, as readable paths; empty when it is clean. */
export function findExportViolations(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (URL_RE.test(v) && !/^items\.\d+\.product\.url$/.test(path)) out.push(`${path}: a URL or file reference (${v.slice(0, 60)})`);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.includes(k)) out.push(`${path ? `${path}.` : ''}${k}: forbidden key`);
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(doc, '');
  const items = (doc as { items?: unknown })?.items;
  if (Array.isArray(items)) {
    items.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      const it = item as Record<string, unknown>;
      for (const k of Object.keys(it)) if (!ITEM_KEYS.has(k)) out.push(`items.${i}.${k}: not an item field`);
      const p = it['product'];
      if (p && typeof p === 'object') for (const k of Object.keys(p)) if (!PRODUCT_KEYS.has(k)) out.push(`items.${i}.product.${k}: not a snapshot field`);
      const r = it['productRef'];
      if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!REF_KEYS.has(k)) out.push(`items.${i}.productRef.${k}: not a reference field`);
    });
  }
  return out;
}
