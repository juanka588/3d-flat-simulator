import { BUILTIN_MATERIALS, ITEM_MATERIALS, clampAlbedo, relativeLuminance } from '@flat/scene';
import type { CatalogEntry, Scene } from '@flat/scene';
import { Color, DoubleSide, MeshStandardMaterial } from 'three';
import type { Material, Texture } from 'three';
import { libraryCatalog } from './catalog';
import type { CatalogSource } from './catalog';
import { MAX_ANISOTROPY, disposeSet, instantiateSet, libSlug, textureCache } from './texture-cache';
import type { Subscription, TextureCache, TextureSet } from './texture-cache';

export interface MaterialLibrary {
  /** The material for an id (scene materials, else a builtin). The same object is returned for as long as the id exists. */
  get: (id: string) => Material;
  /**
   * Brings the library in line with a scene's materials without rebuilding it: changed materials are updated in
   * place (same object, no re-upload when the maps are unchanged), new ones are created, removed ones are queued
   * for disposal (see `commit`). Idempotent for the same input, so it is safe to call while rendering.
   * `roomAmbient` replaces the per-room ambient `aoMap` of every opaque material, `roomBounce` its per-room lamp
   * bounce `emissiveMap` (see room-ambient.ts).
   */
  update: (materials: SceneMaterial[], roomAmbient?: Texture, roomBounce?: Texture) => void;
  /** Disposes the materials `update` removed. Call once the render that stopped using them is committed. */
  commit: () => void;
  /** A handle for `get` whose identity changes only when `get` may start returning different objects (a material was created or removed). */
  snapshot: () => MaterialLibrary;
  /** Releases textures and materials. Idempotent; `resume` re-acquires the textures of materials already handed out. */
  dispose: () => void;
  resume: () => void;
}

type SceneMaterial = Scene['materials'][number];

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

/** The surface's own colour (what a bounce is reflected with); kept apart because `color` of a textured material is only a tint. */
function setAlbedo(m: MeshStandardMaterial, hex: string): void {
  m.userData['albedo'] = new Color(hex);
}

/**
 * The lamp bounce is the room's inter-reflected light, reflected by the surface: radiance = albedo x E / pi. It rides on
 * `emissive` (so neither shadows nor the lights' count touch it): emissive colour = albedo, `emissiveMap` = E / pi per
 * room. Without a bounce map the emissive colour is black, so nothing glows.
 */
function syncEmissive(m: MeshStandardMaterial): void {
  const albedo = m.userData['albedo'] as Color | undefined;
  if (m.emissiveMap && albedo) m.emissive.copy(albedo);
  else m.emissive.setRGB(0, 0, 0);
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

interface TextureSpec {
  color: string;
  roughness: number;
  url: string | undefined;
  scale: number | undefined;
}

/** One subscription to a slug's texture set; `catalog` resolves the entry before the set is acquired. */
interface Target {
  slug: string;
  entry?: CatalogEntry;
  sub?: Subscription;
  cancelled: boolean;
}

/**
 * Wires a library texture set onto a scene material, falling back to its (clamped) paint colour. It can be
 * re-targeted in place (`update`): the old set stays on screen until the new one has arrived, and the new
 * subscription is acquired before the old one is released, so the cache never sees the count hit zero.
 */
class TexturedMaterial {
  private target: Target | undefined;
  private shown: Target | undefined;
  private applied: TextureSet | undefined;
  wanted = false;
  constructor(
    readonly material: MeshStandardMaterial,
    private spec: TextureSpec,
    private readonly opts: Required<Pick<MaterialLibraryOptions, 'anisotropy'>> & MaterialLibraryOptions,
  ) {}

  private get slug(): string | undefined {
    return libSlug(this.spec.url);
  }

  /** Applies a new definition in place. */
  update(spec: TextureSpec): void {
    const old = this.spec;
    this.spec = spec;
    if (old.url !== spec.url) {
      if (this.wanted) this.start();
      else if (!this.slug) this.drop();
    }
    this.restyle();
  }

  /** Re-applies colour / roughness / tiling to what is shown now, touching no texture upload. */
  private restyle(): void {
    const m = this.material;
    const t = this.shown?.entry;
    if (this.applied && t) {
      const scale = this.spec.scale ?? t.tileSizeM;
      for (const map of [this.applied.color, this.applied.normal, this.applied.roughness]) map.repeat.set(1 / scale, 1 / scale);
      m.roughness = Math.min(1, this.spec.roughness / Math.max(t.roughness, 1e-6));
      m.color.setScalar(1).multiplyScalar(textureTint(t.meanColor));
      setAlbedo(m, clampAlbedo(t.meanColor));
    } else {
      m.roughness = this.spec.roughness;
      m.color.set(clampAlbedo(this.spec.color));
      setAlbedo(m, clampAlbedo(this.spec.color));
    }
    syncEmissive(m);
    this.opts.onChange?.();
  }

  start(): void {
    this.wanted = true;
    const slug = this.slug;
    if (!slug) {
      warnOnce(`url:${this.spec.url}`, `[materials] unsupported textureUrl "${this.spec.url}" (only "lib:<slug>" loads); using the paint colour`);
      this.drop();
      return;
    }
    if (this.target?.slug === slug && !this.target.cancelled) return; // already showing or loading it
    const cache = this.opts.cache ?? textureCache;
    const catalog = this.opts.catalog ?? libraryCatalog;
    const next: Target = { slug, cancelled: false };
    if (this.target) this.retire(this.target);
    this.target = next;
    void cache.track(
      catalog.entry(slug).then((entry) => {
        if (next.cancelled) return;
        if (!entry) {
          warnOnce(`slug:${slug}`, `[materials] unknown library texture "${slug}"; using the paint colour`);
          this.drop();
          return;
        }
        next.entry = entry;
        // Acquire the new set first; the old subscription is released only when this one delivers.
        next.sub = cache.acquire(slug, (set) => {
          if (next.cancelled) return;
          if (set) {
            this.apply(next, set);
          } else if (this.shown === next) {
            this.clear(); // taken away (evicted / GL context lost): back to paint until it returns
          }
          this.opts.onChange?.();
        });
      }),
    );
  }

  /** Cancels a target unless it is the one currently shown (that one is released when its replacement arrives). */
  private retire(t: Target): void {
    if (t === this.shown) return;
    t.cancelled = true;
    t.sub?.release();
  }

  private apply(next: Target, set: TextureSet): void {
    const entry = next.entry!;
    const scale = this.spec.scale ?? entry.tileSizeM;
    const hadMaps = this.applied !== undefined;
    const t = instantiateSet(set, scale, this.opts.anisotropy);
    if (this.applied) disposeSet(this.applied);
    this.applied = t;
    const m = this.material;
    m.map = t.color;
    m.normalMap = t.normal;
    m.roughnessMap = t.roughness;
    if (!hadMaps) m.needsUpdate = true; // only a map appearing changes the shader; swapping or re-tiling does not
    const previous = this.shown;
    this.shown = next;
    if (previous && previous !== next) {
      previous.sub?.release(); // after the new one is held
      previous.cancelled = true;
    }
    this.restyle();
  }

  /** Back to the paint colour (maps freed), keeping the subscription so the set can come back. */
  private clear(): void {
    const m = this.material;
    if (this.applied) {
      disposeSet(this.applied);
      this.applied = undefined;
      m.map = null;
      m.normalMap = null;
      m.roughnessMap = null;
      m.needsUpdate = true;
    }
    this.restyle();
  }

  /** No texture wanted any more (url removed or unusable): release everything and show paint. */
  private drop(): void {
    for (const t of [this.target, this.shown]) {
      if (!t) continue;
      t.cancelled = true;
      t.sub?.release();
    }
    this.target = this.shown = undefined;
    this.clear();
  }

  stop(): void {
    this.drop();
  }
}

/**
 * The door leaf as drawn in walk mode: see-through (about 0.35 opacity) so a closed or open leaf does not hide
 * what is behind it. A separate material instance from `builtin:door`, so switching modes only swaps which one
 * the fittings mesh draws (each compiles once; no flag flips on a shared material).
 */
export const DOOR_WALK_MATERIAL = 'builtin:door-walk';
export const DOOR_WALK_OPACITY = 0.35;

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
    case DOOR_WALK_MATERIAL:
      return new MeshStandardMaterial({ color: '#8a6a4b', roughness: 0.7, transparent: true, opacity: DOOR_WALK_OPACITY, depthWrite: false });
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
 * A material library for one canvas: scene materials plus builtins. Create it once and `update` it as the scene
 * changes (see `MaterialLibrary.update`); `dispose` it with the canvas.
 * With `roomAmbient`, every opaque material gets it as `aoMap` (channel 1), which scales only the
 * indirect (hemisphere) light per room; glass is left alone. Meshes drawn with such materials
 * must carry a `uv1` attribute (see room-ambient.ts).
 */
export function createMaterialLibrary(initial: Pick<Scene, 'materials'> | null = null, roomAmbient?: Texture, options: MaterialLibraryOptions = {}): MaterialLibrary {
  const cache = new Map<string, Material>();
  const defs = new Map<string, SceneMaterial>();
  const textured = new Map<string, TexturedMaterial>();
  const removed: { id: string; material: Material; textured?: TexturedMaterial }[] = [];
  const opts = { ...options, anisotropy: options.anisotropy ?? MAX_ANISOTROPY };
  let ambientTexture: Texture | undefined = roomAmbient;
  let bounceTexture: Texture | undefined;
  let version = 0;
  const handedOut = new Set<string>();

  const applyAmbient = (m: MeshStandardMaterial): MeshStandardMaterial => {
    const had = m.aoMap !== null;
    m.aoMap = ambientTexture ?? null;
    m.aoMapIntensity = 1;
    if (had !== (m.aoMap !== null)) m.needsUpdate = true;
    const hadBounce = m.emissiveMap !== null;
    m.emissiveMap = bounceTexture ?? null;
    m.emissiveIntensity = 1;
    if (m.userData['albedo'] === undefined) setAlbedo(m, `#${m.color.getHexString()}`);
    syncEmissive(m);
    if (hadBounce !== (m.emissiveMap !== null)) m.needsUpdate = true;
    return m;
  };
  const isGlass = (id: string) => id === BUILTIN_MATERIALS.glass;
  const specOf = (m: SceneMaterial): TextureSpec => ({ color: m.color, roughness: m.roughness, url: m.textureUrl, scale: m.textureScale });
  const same = (a: SceneMaterial, b: SceneMaterial) =>
    a.kind === b.kind && a.color === b.color && a.roughness === b.roughness && a.textureUrl === b.textureUrl && a.textureScale === b.textureScale;

  const update = (materials: SceneMaterial[], ambient?: Texture, bounce?: Texture): void => {
    if (ambient !== ambientTexture || bounce !== bounceTexture) {
      ambientTexture = ambient;
      bounceTexture = bounce;
      cache.forEach((m, id) => {
        if (!isGlass(id)) applyAmbient(m as MeshStandardMaterial);
      });
    }
    const ids = new Set<string>();
    for (const def of materials) {
      ids.add(def.id);
      const prev = defs.get(def.id);
      if (prev && same(prev, def)) continue;
      defs.set(def.id, def);
      let material = cache.get(def.id) as MeshStandardMaterial | undefined;
      if (!material || !prev) {
        // New id (or one that so far only existed as a builtin look-alike): a fresh material.
        if (material) removed.push({ id: def.id, material, textured: textured.get(def.id) });
        material = new MeshStandardMaterial({ color: clampAlbedo(def.color), roughness: def.roughness });
        setAlbedo(material, clampAlbedo(def.color));
        applyAmbient(material);
        cache.set(def.id, material);
        textured.delete(def.id);
        version++;
      }
      const tm = textured.get(def.id);
      if (def.kind === 'texture') {
        if (tm) tm.update(specOf(def));
        else {
          const created = new TexturedMaterial(material, specOf(def), opts);
          textured.set(def.id, created);
          if (handedOut.has(def.id)) created.start(); // already on screen as paint: its geometry will not ask again
        }
      } else {
        // Texture -> paint: release the set, show the colour.
        if (tm) {
          tm.stop();
          textured.delete(def.id);
        }
        material.color.set(clampAlbedo(def.color));
        setAlbedo(material, clampAlbedo(def.color));
        syncEmissive(material);
        material.roughness = def.roughness;
      }
    }
    for (const id of [...defs.keys()]) {
      if (ids.has(id)) continue;
      defs.delete(id);
      const material = cache.get(id);
      if (material) removed.push({ id, material, textured: textured.get(id) });
      cache.delete(id);
      textured.delete(id);
      version++;
    }
    opts.onChange?.();
  };
  if (initial) update(initial.materials, roomAmbient);

  let handle: MaterialLibrary | null = null;
  let handleVersion = -1;
  const lib: MaterialLibrary = {
    get(id) {
      // Textures load when a material is first used by visible geometry; until then it shows its colour.
      handedOut.add(id);
      textured.get(id)?.start();
      let material = cache.get(id);
      if (!material) {
        const made = builtin(id);
        setAlbedo(made, `#${made.color.getHexString()}`);
        made.name = id; // lets the test hook (and devtools) tell the shell's materials apart
        material = isGlass(id) ? made : applyAmbient(made);
        cache.set(id, material);
      }
      return material;
    },
    update,
    commit() {
      for (const r of removed.splice(0)) {
        r.textured?.stop();
        // A re-created material with the same id lives in `cache` under a new object; only the old one is disposed.
        if (cache.get(r.id) !== r.material) r.material.dispose();
      }
    },
    snapshot() {
      if (!handle || handleVersion !== version) {
        handleVersion = version;
        handle = { ...lib, get: (id) => lib.get(id) };
      }
      return handle;
    },
    // Idempotent and non-clearing: the cache keeps handing out the same objects, so a library that
    // is disposed and then reused (React StrictMode re-runs effects) still disposes everything it
    // ever created on the final dispose.
    dispose() {
      lib.commit();
      textured.forEach((t) => t.stop());
      cache.forEach((m) => m.dispose());
    },
    resume() {
      textured.forEach((t) => {
        if (t.wanted) t.start();
      });
    },
  };
  return lib;
}
