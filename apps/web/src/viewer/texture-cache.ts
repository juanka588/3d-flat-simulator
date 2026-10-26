import { LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader } from 'three';
import { materialsBase } from './catalog';

/** The three PBR maps of one library material. */
export interface TextureSet {
  color: Texture;
  normal: Texture;
  roughness: Texture;
}

export const MAP_NAMES = ['color', 'normal', 'roughness'] as const;

/** Loaded sets kept at most; beyond this the least recently used one is evicted. */
export const MAX_LOADED_SETS = 16;
/** Anisotropy cap (also limited by the renderer). */
export const MAX_ANISOTROPY = 8;

export interface TextureStats {
  /** Texture sets currently loaded. */
  loaded: number;
  /** Texture sets (and catalog lookups) still loading. */
  pending: number;
  /** Slugs of the loaded sets. */
  slugs: string[];
}

/** `lib:<slug>` -> slug; anything else (other schemes, relative paths) is not loadable and returns undefined. */
export function libSlug(textureUrl: string | undefined): string | undefined {
  const m = textureUrl ? /^lib:([a-z0-9][a-z0-9-]*)$/.exec(textureUrl) : null;
  return m?.[1];
}

/** URLs of a library material's maps. The slug must already be validated against the catalog. */
export function textureFileUrls(slug: string, base = materialsBase()): Record<(typeof MAP_NAMES)[number], string> {
  return {
    color: `${base}${slug}/color.webp`,
    normal: `${base}${slug}/normal.webp`,
    roughness: `${base}${slug}/roughness.webp`,
  };
}

/**
 * Per-material copies of a cached set (clones share the decoded image and the GPU upload), with the
 * sampling parameters: UVs are metres, so one repeat spans `tileSizeM` and `repeat = 1 / tileSizeM`.
 * Colour is sRGB; normal and roughness are data (no colour space).
 */
export function instantiateSet(set: TextureSet, tileSizeM: number, anisotropy: number): TextureSet {
  const make = (source: Texture, colorSpace: typeof SRGBColorSpace | typeof NoColorSpace): Texture => {
    const t = source.clone();
    t.colorSpace = colorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(1 / tileSizeM, 1 / tileSizeM);
    t.anisotropy = anisotropy;
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  };
  return { color: make(set.color, SRGBColorSpace), normal: make(set.normal, NoColorSpace), roughness: make(set.roughness, NoColorSpace) };
}

export const disposeSet = (set: TextureSet): void => {
  set.color.dispose();
  set.normal.dispose();
  set.roughness.dispose();
};

export interface SetLoad {
  promise: Promise<TextureSet>;
  /** Ignore the result (and free it if it still arrives). */
  cancel: () => void;
}
export type SetLoader = (slug: string) => SetLoad;

/** Loads a slug's three maps with the three.js TextureLoader. Image loads cannot be aborted, so cancel discards the result. */
export function defaultSetLoader(base?: string): SetLoader {
  return (slug) => {
    const urls = textureFileUrls(slug, base);
    const loader = new TextureLoader();
    const loaded: Texture[] = [];
    let cancelled = false;
    const one = (url: string) =>
      new Promise<Texture>((resolve, reject) =>
        loader.load(
          url,
          (t) => {
            loaded.push(t);
            resolve(t);
          },
          undefined,
          () => reject(new Error(`failed to load ${url}`)),
        ),
      );
    const promise = Promise.all([one(urls.color), one(urls.normal), one(urls.roughness)]).then(([color, normal, roughness]) => {
      if (cancelled) {
        loaded.forEach((t) => t.dispose());
        throw new Error('cancelled');
      }
      return { color: color!, normal: normal!, roughness: roughness! };
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
      },
    };
  };
}

export interface Subscription {
  release: () => void;
}

export interface TextureCache {
  /**
   * Starts (or joins) the load of a slug. `onSet` receives the set when it is available, and `null` when
   * it is taken away (evicted, or the GL context was lost); it may fire again after a reload.
   */
  acquire: (slug: string, onSet: (set: TextureSet | null) => void) => Subscription;
  /** Counts a promise (e.g. a catalog lookup) as pending work for `settled` and `stats`. */
  track: <T>(promise: Promise<T>) => Promise<T>;
  stats: () => TextureStats;
  /** Resolves when nothing is loading. */
  settled: () => Promise<void>;
  /** Drops every loaded set and reloads the referenced ones (after a WebGL context restore). */
  reset: () => void;
}

interface Entry {
  slug: string;
  subs: Set<(set: TextureSet | null) => void>;
  state: 'pending' | 'loaded' | 'failed';
  set?: TextureSet;
  load?: SetLoad;
  lastUsed: number;
}

export function createTextureCache(loader: SetLoader, maxLoaded = MAX_LOADED_SETS): TextureCache {
  const entries = new Map<string, Entry>();
  let clock = 0;
  let tracked = 0;
  let waiters: (() => void)[] = [];

  const pendingCount = () => tracked + [...entries.values()].filter((e) => e.state === 'pending').length;
  const flush = () => {
    if (pendingCount() > 0) return;
    const ready = waiters;
    waiters = [];
    ready.forEach((r) => r());
  };

  const drop = (e: Entry) => {
    if (entries.get(e.slug) === e) entries.delete(e.slug);
    if (e.state === 'pending') e.load?.cancel();
    if (e.set) disposeSet(e.set);
    e.set = undefined;
  };

  const evictIfNeeded = (keep: Entry) => {
    for (;;) {
      const loaded = [...entries.values()].filter((e) => e.state === 'loaded');
      if (loaded.length <= maxLoaded) return;
      const victim = loaded.filter((e) => e !== keep).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) return;
      const subs = [...victim.subs];
      drop(victim);
      victim.state = 'failed'; // detached: later releases are no-ops
      subs.forEach((cb) => cb(null));
    }
  };

  const start = (e: Entry) => {
    e.state = 'pending';
    const load = loader(e.slug);
    e.load = load;
    load.promise.then(
      (set) => {
        if (e.load !== load || entries.get(e.slug) !== e) {
          // Superseded: nobody wants this load any more.
          disposeSet(set);
          flush();
          return;
        }
        e.state = 'loaded';
        e.set = set;
        e.lastUsed = ++clock;
        [...e.subs].forEach((cb) => cb(set));
        evictIfNeeded(e);
        flush();
      },
      (error: unknown) => {
        if (e.load === load && entries.get(e.slug) === e) {
          e.state = 'failed';
          console.warn(`[materials] texture set "${e.slug}" failed to load; using the paint colour`, error);
        }
        flush();
      },
    );
  };

  return {
    acquire(slug, onSet) {
      let e = entries.get(slug);
      if (!e) {
        e = { slug, subs: new Set(), state: 'pending', lastUsed: ++clock };
        entries.set(slug, e);
        e.subs.add(onSet);
        start(e);
      } else {
        e.subs.add(onSet);
        e.lastUsed = ++clock;
        if (e.state === 'loaded' && e.set) onSet(e.set);
      }
      const entry = e;
      return {
        release() {
          if (!entry.subs.delete(onSet)) return;
          if (entry.subs.size === 0 && entries.get(entry.slug) === entry) {
            drop(entry);
            flush();
          }
        },
      };
    },
    track(promise) {
      tracked++;
      const done = () => {
        tracked--;
        flush();
      };
      promise.then(done, done);
      return promise;
    },
    stats() {
      const loaded = [...entries.values()].filter((e) => e.state === 'loaded');
      return { loaded: loaded.length, pending: pendingCount(), slugs: loaded.map((e) => e.slug).sort() };
    },
    settled() {
      return pendingCount() === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
    },
    reset() {
      for (const e of [...entries.values()]) {
        const subs = [...e.subs];
        if (e.state === 'pending') e.load?.cancel();
        if (e.set) disposeSet(e.set);
        e.set = undefined;
        subs.forEach((cb) => cb(null));
        if (e.subs.size > 0) start(e);
        else entries.delete(e.slug);
      }
      flush();
    },
  };
}

/** The app-wide cache. */
export const textureCache: TextureCache = createTextureCache(defaultSetLoader());

/** Texture cache state for the test hook (`FlatStats.textures`-style): `{loaded, pending, slugs}`. */
export const textureStats = (): TextureStats => textureCache.stats();
/** Resolves once no texture (or catalog lookup) is loading; await it from `whenRendered`. */
export const texturesSettled = (): Promise<void> => textureCache.settled();
