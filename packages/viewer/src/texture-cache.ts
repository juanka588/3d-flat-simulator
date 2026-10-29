import { LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader } from 'three';
import { materialsBase } from './catalog';

/** The three PBR maps of one library material. */
export interface TextureSet {
  color: Texture;
  normal: Texture;
  roughness: Texture;
}

export const MAP_NAMES = ['color', 'normal', 'roughness'] as const;

/**
 * Loaded sets kept at most (in use or idle). Beyond this, idle sets (no user) are evicted first, least
 * recently used first; only when more sets than this are in use at once is an in-use set evicted too.
 */
export const MAX_LOADED_SETS = 16;
/** Anisotropy cap (also limited by the renderer). */
export const MAX_ANISOTROPY = 8;

export interface TextureStats {
  /** Texture sets loaded and in use by at least one material. */
  loaded: number;
  /** Texture sets (and catalog lookups) still loading. */
  pending: number;
  /** Slugs of the loaded, in-use sets. */
  slugs: string[];
  /** Loaded sets nobody uses right now, kept so that going back to them needs no download (evicted first). */
  idle: number;
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

/** The part of `TextureLoader` the set loader uses (a seam for tests). */
export interface MapLoader {
  load: (url: string, onLoad: (t: Texture) => void, onProgress: undefined, onError: () => void) => unknown;
}

/**
 * Loads a slug's three maps with the three.js TextureLoader. Image loads cannot be aborted, so cancel discards
 * the result. Maps that did load are disposed whenever the set as a whole is not delivered (one map failed, or
 * the load was cancelled), including maps that finish after the failure.
 */
export function defaultSetLoader(base?: string, makeLoader: () => MapLoader = () => new TextureLoader()): SetLoader {
  return (slug) => {
    const urls = textureFileUrls(slug, base);
    const loader = makeLoader();
    const loaded: Texture[] = [];
    let cancelled = false;
    let abandoned = false;
    const abandon = () => {
      abandoned = true;
      loaded.splice(0).forEach((t) => t.dispose());
    };
    const one = (url: string) =>
      new Promise<Texture>((resolve, reject) =>
        loader.load(
          url,
          (t) => {
            if (abandoned) {
              t.dispose(); // a sibling already failed
              reject(new Error('abandoned'));
              return;
            }
            loaded.push(t);
            resolve(t);
          },
          undefined,
          () => reject(new Error(`failed to load ${url}`)),
        ),
      );
    const promise = Promise.all([one(urls.color), one(urls.normal), one(urls.roughness)]).then(
      ([color, normal, roughness]) => {
        if (cancelled) {
          abandon();
          throw new Error('cancelled');
        }
        return { color: color!, normal: normal!, roughness: roughness! };
      },
      (error: unknown) => {
        abandon();
        throw error;
      },
    );
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
  /** 'evicted': taken away while in use (more sets in use than the cap); reloaded when room frees up. */
  state: 'pending' | 'loaded' | 'failed' | 'evicted';
  set?: TextureSet;
  load?: SetLoad;
  lastUsed: number;
}

export function createTextureCache(loader: SetLoader, maxLoaded = MAX_LOADED_SETS): TextureCache {
  const entries = new Map<string, Entry>();
  let clock = 0;
  let tracked = 0;
  let waiters: (() => void)[] = [];

  const all = () => [...entries.values()];
  const loadedEntries = () => all().filter((e) => e.state === 'loaded');
  const pendingCount = () => tracked + all().filter((e) => e.state === 'pending').length;
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

  /** Over the cap: idle sets go first (LRU); an in-use set is taken away only when everything loaded is in use. */
  const evictIfNeeded = (keep: Entry) => {
    for (;;) {
      const loaded = loadedEntries();
      if (loaded.length <= maxLoaded) return;
      const candidates = loaded.filter((e) => e !== keep).sort((a, b) => a.lastUsed - b.lastUsed);
      const idle = candidates.find((e) => e.subs.size === 0);
      if (idle) {
        drop(idle);
        continue;
      }
      const victim = candidates[0];
      if (!victim) return;
      if (victim.set) disposeSet(victim.set);
      victim.set = undefined;
      victim.state = 'evicted';
      [...victim.subs].forEach((cb) => cb(null));
    }
  };

  /** Room freed up: bring back evicted in-use sets, most recently used first (idle sets make room, they are only a cache). */
  const revive = () => {
    const evicted = all()
      .filter((e) => e.state === 'evicted' && e.subs.size > 0)
      .sort((a, b) => b.lastUsed - a.lastUsed);
    for (const e of evicted) {
      const inUse = all().filter((x) => x.subs.size > 0 && (x.state === 'loaded' || x.state === 'pending')).length;
      if (inUse >= maxLoaded) return;
      const idle = loadedEntries()
        .filter((x) => x.subs.size === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      while (idle.length > 0 && loadedEntries().length + all().filter((x) => x.state === 'pending').length >= maxLoaded) drop(idle.shift()!);
      start(e);
    }
  };

  function start(e: Entry): void {
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
  }

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
        else if (e.state === 'evicted') revive();
      }
      const entry = e;
      return {
        release() {
          if (!entry.subs.delete(onSet)) return;
          if (entry.subs.size > 0 || entries.get(entry.slug) !== entry) return;
          // Last user gone: a loaded set stays as idle (evicted first); anything else is not worth keeping.
          if (entry.state !== 'loaded') drop(entry);
          else evictIfNeeded(entry);
          revive();
          flush();
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
      const loaded = loadedEntries();
      const inUse = loaded.filter((e) => e.subs.size > 0);
      return { loaded: inUse.length, pending: pendingCount(), slugs: inUse.map((e) => e.slug).sort(), idle: loaded.length - inUse.length };
    },
    settled() {
      return pendingCount() === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
    },
    reset() {
      for (const e of all()) {
        const subs = [...e.subs];
        if (e.state === 'pending') e.load?.cancel();
        if (e.set) disposeSet(e.set);
        e.set = undefined;
        if (e.subs.size > 0) {
          subs.forEach((cb) => cb(null));
          start(e);
        } else entries.delete(e.slug);
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
