import { BUILTIN_MATERIALS, ITEM_MATERIALS, clampAlbedo, relativeLuminance } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { Color, DoubleSide, MeshStandardMaterial } from 'three';
import type { Material, Texture } from 'three';
import { libraryCatalog } from './catalog';
import type { CatalogSource } from './catalog';
import { MAX_ANISOTROPY, disposeSet, instantiateSet, libSlug, textureCache } from './texture-cache';
import type { Subscription, TextureCache, TextureSet } from './texture-cache';

export interface MaterialLibrary {
  get: (id: string) => Material;
  /** Releases textures and materials. Idempotent; `resume` re-acquires the textures of materials already handed out. */
  dispose: () => void;
  resume: () => void;
}

export interface MaterialLibraryOptions {
  /** Anisotropy for textured maps (default `MAX_ANISOTROPY`; pass `min(8, renderer max)`). */
  anisotropy?: number;
  /** Called when a texture arrives or is taken away, so a demand frameloop can redraw. */
  onChange?: () => void;
  cache?: TextureCache;
  catalog?: CatalogSource;
}

/**
 * Albedo clamp (viewer only; the scene keeps the user's colour): paint colours are clamped to
 * `ALBEDO_RANGE` so pure white or black cannot break the exposure model. A texture keeps its own
 * colour; `material.color` multiplies it, so it is scaled down uniformly only when the catalog's
 * mean colour lies outside the range (this never happens for the shipped library).
 */
export function textureTint(meanColor: string): number {
  const lum = relativeLuminance(meanColor);
  return lum > 0 ? Math.min(1, relativeLuminance(clampAlbedo(meanColor)) / lum) : 1;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Wires a library texture set onto a scene material, falling back to its (clamped) paint colour. */
class TexturedMaterial {
  private sub: Subscription | undefined;
  private applied: TextureSet | undefined;
  private epoch = 0;
  wanted = false;
  constructor(
    readonly material: MeshStandardMaterial,
    private readonly paintColor: string,
    private readonly paintRoughness: number,
    private readonly slug: string | undefined,
    private readonly url: string | undefined,
    private readonly scale: number | undefined,
    private readonly opts: Required<Pick<MaterialLibraryOptions, 'anisotropy'>> & MaterialLibraryOptions,
  ) {}

  start(): void {
    this.wanted = true;
    if (this.sub) return;
    const cache = this.opts.cache ?? textureCache;
    const catalog = this.opts.catalog ?? libraryCatalog;
    if (!this.slug) {
      warnOnce(`url:${this.url}`, `[materials] unsupported textureUrl "${this.url}" (only "lib:<slug>" loads); using the paint colour`);
      return;
    }
    const slug = this.slug;
    const epoch = ++this.epoch;
    // Subscription is created once the slug is vetted against the catalog; a release before that cancels it.
    let released = false;
    this.sub = {
      release: () => {
        released = true;
        this.epoch++;
      },
    };
    const placeholder = this.sub;
    void cache.track(catalog.entry(slug).then((entry) => {
      if (released || epoch !== this.epoch) return;
      if (!entry) {
        warnOnce(`slug:${slug}`, `[materials] unknown library texture "${slug}"; using the paint colour`);
        return;
      }
      const scale = this.scale ?? entry.tileSizeM;
      const inner = cache.acquire(slug, (set) => {
        if (epoch !== this.epoch) return;
        this.clear();
        if (set) this.apply(set, scale, Math.min(1, this.paintRoughness / Math.max(entry.roughness, 1e-6)), entry.meanColor);
        this.opts.onChange?.();
      });
      this.sub = {
        release: () => {
          inner.release();
          placeholder.release();
        },
      };
    }));
  }

  private apply(set: TextureSet, scale: number, roughness: number, mean: string): void {
    const t = instantiateSet(set, scale, this.opts.anisotropy);
    this.applied = t;
    const m = this.material;
    m.map = t.color;
    m.normalMap = t.normal;
    m.roughnessMap = t.roughness;
    // The roughness map carries the roughness; the scalar only keeps a user override relative to the library's mean.
    m.roughness = roughness;
    m.color.copy(new Color(1, 1, 1)).multiplyScalar(textureTint(mean));
    m.needsUpdate = true;
  }

  /** Back to the paint colour (maps released). */
  private clear(): void {
    const m = this.material;
    if (this.applied) {
      disposeSet(this.applied);
      this.applied = undefined;
    }
    m.map = null;
    m.normalMap = null;
    m.roughnessMap = null;
    m.roughness = this.paintRoughness;
    m.color.set(clampAlbedo(this.paintColor));
    m.needsUpdate = true;
  }

  stop(): void {
    this.sub?.release();
    this.sub = undefined;
    this.epoch++;
    if (this.applied) this.clear();
  }
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
    case ITEM_MATERIALS.tvBody:
      return new MeshStandardMaterial({ color: '#2b2c2f', roughness: 0.45, metalness: 0.3 });
    case ITEM_MATERIALS.tvScreen:
      return new MeshStandardMaterial({ color: '#08090b', roughness: 0.08, metalness: 0.2 });
    case ITEM_MATERIALS.placeholder:
      return new MeshStandardMaterial({ color: '#d048d0', roughness: 0.8, wireframe: true });
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
export function createMaterialLibrary(scene: Pick<Scene, 'materials'>, roomAmbient?: Texture, options: MaterialLibraryOptions = {}): MaterialLibrary {
  const cache = new Map<string, Material>();
  const textured = new Map<string, TexturedMaterial>();
  const opts = { ...options, anisotropy: options.anisotropy ?? MAX_ANISOTROPY };
  const ambient = (m: MeshStandardMaterial): MeshStandardMaterial => {
    if (roomAmbient) {
      m.aoMap = roomAmbient;
      m.aoMapIntensity = 1;
    }
    return m;
  };
  for (const m of scene.materials) {
    const material = ambient(new MeshStandardMaterial({ color: clampAlbedo(m.color), roughness: m.roughness }));
    cache.set(m.id, material);
    if (m.kind === 'texture') {
      textured.set(m.id, new TexturedMaterial(material, m.color, m.roughness, libSlug(m.textureUrl), m.textureUrl, m.textureScale, opts));
    }
  }
  return {
    get(id) {
      // Textures load when a material is first used by visible geometry; until then it shows its colour.
      textured.get(id)?.start();
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
      textured.forEach((t) => t.stop());
      cache.forEach((m) => m.dispose());
    },
    resume() {
      textured.forEach((t) => {
        if (t.wanted) t.start();
      });
    },
  };
}
