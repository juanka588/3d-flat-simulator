import { Color, MeshLambertMaterial } from 'three';
import type { Material, MeshStandardMaterial } from 'three';

/**
 * Diffuse stand-ins for the materials of the scene while the probes are baked. Indirect light only depends on how much
 * light each surface gives back, i.e. its albedo, so the bake draws every standard (PBR) material as a Lambert one with the
 * same albedo: far fewer shader programs to compile (a few seconds of software GL saved) and a cheaper fragment shader for
 * each of the thousands of cube faces. Textured materials use their mean colour (`userData.albedo`, set by the material
 * library), vertex-coloured ones keep their vertex colours.
 */
export class BakeMaterials {
  private readonly cache = new WeakMap<Material, MeshLambertMaterial>();
  private readonly made = new Set<MeshLambertMaterial>();
  private readonly tmp = new Color();

  /** The stand-in for `source` (the source itself for anything that is not a standard material), glowing with `emissive` radiance. */
  get(source: Material, emissive = 0): Material {
    const std = source as MeshStandardMaterial;
    if (!std.isMeshStandardMaterial) return source;
    let m = this.cache.get(source);
    if (!m) {
      m = new MeshLambertMaterial({ vertexColors: std.vertexColors, side: std.side, transparent: std.transparent, depthWrite: std.depthWrite });
      this.cache.set(source, m);
      this.made.add(m);
    }
    const albedo = std.userData['albedo'] as Color | undefined;
    if (std.vertexColors) m.color.setRGB(1, 1, 1);
    else m.color.copy(albedo ?? std.color);
    m.opacity = std.opacity;
    if (emissive > 0) m.emissive.setScalar(emissive);
    else m.emissive.setRGB(0, 0, 0);
    this.tmp.set(0);
    return m;
  }

  dispose(): void {
    for (const m of this.made) m.dispose();
    this.made.clear();
  }
}
