import { buildShell } from '@flat/scene';
import type { Scene, ShellMeshes } from '@flat/scene';

const cache = new WeakMap<Scene, ShellMeshes>();

/** `buildShell` memoised per Scene object (stable across re-renders and StrictMode double renders). */
export function shellFor(scene: Scene): ShellMeshes {
  let shell = cache.get(scene);
  if (!shell) {
    shell = buildShell(scene);
    cache.set(scene, shell);
  }
  return shell;
}
