import { BUILTIN_MATERIALS } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { DoubleSide, MeshStandardMaterial } from 'three';
import type { Material, Texture } from 'three';

export interface MaterialLibrary {
  get: (id: string) => Material;
  dispose: () => void;
}

function builtin(id: string): MeshStandardMaterial {
  switch (id) {
    case BUILTIN_MATERIALS.glass:
      return new MeshStandardMaterial({
        color: '#bfd9e8',
        roughness: 0.05,
        metalness: 0,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        side: DoubleSide,
      });
    case BUILTIN_MATERIALS.frame:
      return new MeshStandardMaterial({ color: '#3b3b3f', roughness: 0.6 });
    case BUILTIN_MATERIALS.door:
      return new MeshStandardMaterial({ color: '#8a6a4b', roughness: 0.7 });
    case BUILTIN_MATERIALS.fallbackFloor:
      return new MeshStandardMaterial({ color: '#c8b89e', roughness: 0.8 });
    case BUILTIN_MATERIALS.fallbackCeiling:
      return new MeshStandardMaterial({ color: '#f6f6f6', roughness: 1 });
    case BUILTIN_MATERIALS.fallbackWall:
    default:
      return new MeshStandardMaterial({ color: '#e9e6e0', roughness: 0.95 });
  }
}

/**
 * Builds three materials for a scene (scene materials plus builtins); dispose when the scene changes.
 * With `roomAmbient`, every opaque material gets it as `aoMap` (channel 1), which scales only the
 * indirect (hemisphere) light per room; glass is left alone. Meshes drawn with such materials
 * must carry a `uv1` attribute (see room-ambient.ts).
 */
export function createMaterialLibrary(scene: Pick<Scene, 'materials'>, roomAmbient?: Texture): MaterialLibrary {
  const cache = new Map<string, Material>();
  const ambient = (m: MeshStandardMaterial): MeshStandardMaterial => {
    if (roomAmbient) {
      m.aoMap = roomAmbient;
      m.aoMapIntensity = 1;
    }
    return m;
  };
  for (const m of scene.materials) {
    cache.set(m.id, ambient(new MeshStandardMaterial({ color: m.color, roughness: m.roughness })));
  }
  return {
    get(id) {
      let material = cache.get(id);
      if (!material) {
        const made = builtin(id);
        material = id === BUILTIN_MATERIALS.glass ? made : ambient(made);
        cache.set(id, material);
      }
      return material;
    },
    // Idempotent and non-clearing: the cache keeps handing out the same objects, so a library that
    // is disposed and then reused (React StrictMode re-runs effects) still disposes everything it
    // ever created on the final dispose.
    dispose() {
      cache.forEach((m) => m.dispose());
    },
  };
}
