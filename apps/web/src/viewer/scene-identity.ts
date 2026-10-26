import type { Scene } from '@flat/scene';
import { adoptShell } from './shell-cache';

// Stable identity key per Scene object, so camera rigs remount when a new scene loads.
const keys = new WeakMap<Scene, number>();
let nextKey = 0;

export function sceneKey(scene: Scene): number {
  let k = keys.get(scene);
  if (k === undefined) {
    k = nextKey++;
    keys.set(scene, k);
  }
  return k;
}

/**
 * Makes `next` (a copy of `prev` that differs only in non-geometry data such as the site) share its
 * identity key and built shell, so editing the site neither re-frames the camera nor rebuilds meshes.
 */
export function adoptSceneIdentity(prev: Scene, next: Scene): void {
  keys.set(next, sceneKey(prev));
  adoptShell(prev, next);
}
