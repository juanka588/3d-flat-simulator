import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BufferGeometry } from 'three';
import { hdModelsBase } from './model-env';
import { shadeByNormal } from './person-model';

/** The HD library model the person ghost is drawn with when it can be fetched (see scripts/models/manifest-hd.json, `person_standing`). */
export const PERSON_GLB_FILE = 'person_standing.glb';

export interface PersonGlb {
  /** One merged geometry in the item frame (soles on y = 0, centred on the plan, front +z), with baked soft shading colours. */
  geometry: BufferGeometry;
  /** Its native height, metres. */
  height: number;
}

let loading: Promise<PersonGlb | null> | undefined;

/**
 * Loads the person GLB once (lazily, from the HD tier folder). Resolves `null` when it is not there (offline, a static
 * build without the file, a broken file): the ghost then keeps the parametric mannequin.
 */
export function loadPersonGlb(url = `${hdModelsBase()}${PERSON_GLB_FILE}`): Promise<PersonGlb | null> {
  return (loading ??= (async () => {
    try {
      // Lazy, like the item models: the glTF decoders are only downloaded when a figure is drawn.
      const { loadGlb } = await import('./model-loader');
      const { value: template } = await loadGlb(url);
      const parts = template.parts.map((p) => p.geometry.clone().toNonIndexed());
      const merged = mergeGeometries(parts, false);
      parts.forEach((g) => g.dispose());
      template.dispose();
      if (!merged) return null;
      merged.computeBoundingBox();
      const height = merged.boundingBox!.max.y - merged.boundingBox!.min.y;
      if (!(height > 0.1)) return null;
      if (!merged.getAttribute('normal')) merged.computeVertexNormals();
      shadeByNormal(merged);
      return { geometry: merged, height };
    } catch {
      return null;
    }
  })());
}

/** Forgets the cached result (tests). */
export function resetPersonGlb(): void {
  loading = undefined;
}
