import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture } from 'three';
import { createCatalogSource } from './catalog';
import { createMaterialLibrary, textureTint } from './materials';
import { createTextureCache, defaultSetLoader, disposeSet, instantiateSet, libSlug, textureFileUrls } from './texture-cache';
import type { MapLoader } from './texture-cache';
import type { SetLoad, TextureSet } from './texture-cache';

const makeSet = (): TextureSet => ({ color: new Texture(), normal: new Texture(), roughness: new Texture() });

/** A loader whose loads resolve when the test says so. */
function mockLoader() {
  const calls: string[] = [];
  const pending = new Map<string, { resolve: (s: TextureSet) => void; reject: (e: Error) => void; cancelled: boolean }[]>();
  const loader = (slug: string): SetLoad => {
    calls.push(slug);
    let ctl!: { resolve: (s: TextureSet) => void; reject: (e: Error) => void; cancelled: boolean };
    const promise = new Promise<TextureSet>((resolve, reject) => {
      ctl = { resolve, reject, cancelled: false };
    });
    pending.set(slug, [...(pending.get(slug) ?? []), ctl]);
    return { promise, cancel: () => (ctl.cancelled = true) };
  };
  const finish = async (slug: string, index = 0) => {
    const set = makeSet();
    pending.get(slug)![index]!.resolve(set);
    await Promise.resolve();
    await Promise.resolve();
    return set;
  };
  return { loader, calls, finish, pending };
}

describe('texture cache', () => {
  it('loads each slug once however many users, and hands the set to late joiners', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader);
    const got: (TextureSet | null)[] = [];
    cache.acquire('a', (s) => got.push(s));
    cache.acquire('a', (s) => got.push(s));
    expect(m.calls).toEqual(['a']);
    expect(cache.stats()).toEqual({ loaded: 0, pending: 1, slugs: [], idle: 0 });
    const set = await m.finish('a');
    expect(got).toEqual([set, set]);
    cache.acquire('a', (s) => got.push(s));
    expect(got).toHaveLength(3);
    expect(m.calls).toEqual(['a']);
    expect(cache.stats()).toEqual({ loaded: 1, pending: 0, slugs: ['a'], idle: 0 });
  });

  it('keeps a released set idle (no re-download) and disposes it only when evicted', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader, 2);
    const s1 = cache.acquire('a', () => undefined);
    const s2 = cache.acquire('a', () => undefined);
    const setA = await m.finish('a');
    const spy = vi.spyOn(setA.color, 'dispose');
    s1.release();
    expect(spy).not.toHaveBeenCalled();
    s2.release();
    s2.release();
    expect(spy).not.toHaveBeenCalled();
    expect(cache.stats()).toEqual({ loaded: 0, pending: 0, slugs: [], idle: 1 });
    // A -> B -> A: coming back to A needs no download
    cache.acquire('b', () => undefined);
    await m.finish('b');
    const got: (TextureSet | null)[] = [];
    cache.acquire('a', (set) => got.push(set));
    expect(got).toEqual([setA]);
    expect(m.calls).toEqual(['a', 'b']);
    // idle sets are evicted before any in-use set
    cache.acquire('c', () => undefined); // 3 loaded > cap 2 once it arrives; idle ones go first
    await m.finish('c');
    expect(cache.stats().loaded).toBe(2);
  });

  it('evicts idle sets first, then the least recently used in-use set, and brings it back when room frees', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader, 2);
    const events: Record<string, (TextureSet | null)[]> = { a: [], b: [], c: [] };
    const subs: Record<string, { release: () => void }> = {};
    for (const slug of ['a', 'b']) {
      subs[slug] = cache.acquire(slug, (set) => events[slug]!.push(set));
      await m.finish(slug);
    }
    subs.b!.release(); // b idle
    subs.c = cache.acquire('c', (set) => events.c!.push(set));
    await m.finish('c');
    expect(cache.stats()).toMatchObject({ slugs: ['a', 'c'], idle: 0 });
    expect(events.a!.at(-1)).not.toBeNull(); // the in-use a was spared: idle b went
    // now three in use at once: a (older) is taken away from its user...
    const b2 = cache.acquire('b', (set) => events.b!.push(set));
    await m.finish('b', 1);
    expect(events.a!.at(-1)).toBeNull();
    expect(cache.stats().loaded).toBe(2);
    // ...and returns once somebody lets go
    b2.release();
    await m.finish('a', 1);
    expect(events.a!.at(-1)).not.toBeNull();
    expect(cache.stats().slugs).toEqual(['a', 'c']);
  });

  it('ignores a load that was superseded (released, then re-acquired) and frees its result', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader);
    const got: (TextureSet | null)[] = [];
    cache.acquire('a', () => got.push(null)).release();
    expect(m.pending.get('a')![0]!.cancelled).toBe(true);
    cache.acquire('a', (s) => got.push(s));
    const stale = makeSet();
    const spy = vi.spyOn(stale.color, 'dispose');
    m.pending.get('a')![0]!.resolve(stale);
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
    expect(got).toEqual([]);
    const fresh = await m.finish('a', 1);
    expect(got).toEqual([fresh]);
    expect(cache.stats().loaded).toBe(1);
  });

  it('evicts the least recently used set beyond the cap and tells its users', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader, 2);
    const events: Record<string, (TextureSet | null)[]> = { a: [], b: [], c: [] };
    for (const slug of ['a', 'b', 'c']) {
      cache.acquire(slug, (s) => events[slug]!.push(s));
      if (slug === 'c') cache.acquire('a', () => undefined); // touch a: b becomes the oldest
      await m.finish(slug);
    }
    expect(cache.stats()).toEqual({ loaded: 2, pending: 0, slugs: ['a', 'c'], idle: 0 });
    expect(events.b!.at(-1)).toBeNull();
    expect(events.a!.at(-1)).not.toBeNull();
  });

  it('keeps loaded at the cap across many one-after-another slugs', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader);
    for (let i = 0; i < 20; i++) {
      cache.acquire(`s${i}`, () => undefined);
      await m.finish(`s${i}`);
      expect(cache.stats().loaded).toBeLessThanOrEqual(16);
    }
    expect(cache.stats().loaded).toBe(16);
  });

  it('reset reloads the referenced slugs', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader);
    const got: (TextureSet | null)[] = [];
    cache.acquire('a', (s) => got.push(s));
    await m.finish('a');
    cache.reset();
    expect(got.at(-1)).toBeNull();
    expect(cache.stats().pending).toBe(1);
    const again = await m.finish('a', 1);
    expect(got.at(-1)).toBe(again);
  });

  it('settled resolves once loading is done', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader);
    cache.acquire('a', () => undefined);
    let done = false;
    void cache.settled().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await m.finish('a');
    await Promise.resolve();
    expect(done).toBe(true);
  });
});

describe('default set loader', () => {
  /** A loader whose maps finish when the test says so. */
  function fakeMapLoader() {
    const jobs: { url: string; ok: () => Texture; fail: () => void }[] = [];
    const loader: MapLoader = {
      load: (url, onLoad, _p, onError) => {
        jobs.push({ url, ok: () => { const t = new Texture(); onLoad(t); return t; }, fail: onError });
      },
    };
    return { loader, jobs };
  }

  it('disposes the maps that did load when another map fails, even if they finish after the failure', async () => {
    const f = fakeMapLoader();
    const load = defaultSetLoader('/m/', () => f.loader)('oak');
    const failed = load.promise.catch((e: Error) => e.message);
    const color = f.jobs[0]!.ok();
    const colorSpy = vi.spyOn(color, 'dispose');
    f.jobs[1]!.fail();
    expect(await failed).toMatch(/normal\.webp/);
    expect(colorSpy).toHaveBeenCalledTimes(1);
    // the roughness map arriving after the failure is freed on arrival
    const late = f.jobs[2]!.ok();
    expect(late).toBeInstanceOf(Texture);
  });

  it('frees every map of a cancelled load', async () => {
    const f = fakeMapLoader();
    const load = defaultSetLoader('/m/', () => f.loader)('oak');
    load.cancel();
    const maps = f.jobs.map((j) => j.ok());
    const spies = maps.map((t) => vi.spyOn(t, 'dispose'));
    await expect(load.promise).rejects.toThrow('cancelled');
    spies.forEach((spy) => expect(spy).toHaveBeenCalled());
  });
});

describe('texture parameters', () => {
  it('uses repeat = 1 / tile size, repeat wrapping, mipmaps, anisotropy and the right colour spaces', () => {
    const base = makeSet();
    const t = instantiateSet(base, 2.5, 8);
    for (const map of [t.color, t.normal, t.roughness]) {
      expect(map.repeat.x).toBeCloseTo(0.4);
      expect(map.repeat.y).toBeCloseTo(0.4);
      expect(map.wrapS).toBe(RepeatWrapping);
      expect(map.wrapT).toBe(RepeatWrapping);
      expect(map.generateMipmaps).toBe(true);
      expect(map.anisotropy).toBe(8);
    }
    expect(t.color.colorSpace).toBe(SRGBColorSpace);
    expect(t.normal.colorSpace).toBe(NoColorSpace);
    expect(t.roughness.colorSpace).toBe(NoColorSpace);
    expect(base.color.repeat.x).toBe(1);
    disposeSet(t);
  });
});

describe('url guard', () => {
  it('accepts only lib:<slug>', () => {
    expect(libSlug('lib:parquet-light-oak')).toBe('parquet-light-oak');
    for (const bad of ['materials/oak/', 'https://evil.example/x', 'lib:../x', 'lib:', 'LIB:oak', undefined]) expect(libSlug(bad)).toBeUndefined();
  });
  it('resolves files below the materials base', () => {
    expect(textureFileUrls('oak', '/m/')).toEqual({ color: '/m/oak/color.webp', normal: '/m/oak/normal.webp', roughness: '/m/oak/roughness.webp' });
  });
});

describe('material library textures', () => {
  const entry = {
    id: 'oak',
    tileSizeM: 2,
    roughness: 0.5,
    meanColor: '#93704d',
  };
  const catalog = {
    entry: (slug: string) => Promise.resolve(slug === 'oak' ? (entry as never) : undefined),
    all: () => Promise.resolve([entry as never]),
  };
  const scene = {
    materials: [
      { id: 'm-oak', name: 'oak', kind: 'texture' as const, color: '#93704d', roughness: 0.5, textureUrl: 'lib:oak', textureScale: 2 },
      { id: 'm-bad', name: 'bad', kind: 'texture' as const, color: '#ffffff', roughness: 0.5, textureUrl: 'lib:nope' },
      { id: 'm-rel', name: 'rel', kind: 'texture' as const, color: '#112233', roughness: 0.5, textureUrl: 'materials/x/' },
      { id: 'm-white', name: 'white', kind: 'paint' as const, color: '#ffffff', roughness: 0.9 },
    ],
  };

  it('shows the colour first, then maps; unknown or relative urls and loads of unused materials never fetch', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader);
    const changes = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lib = createMaterialLibrary(scene, undefined, { cache, catalog, anisotropy: 4, onChange: changes });
    expect(m.calls).toEqual([]);
    const oak = lib.get('m-oak') as import('three').MeshStandardMaterial;
    lib.get('m-bad');
    lib.get('m-rel');
    expect(oak.map).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(m.calls).toEqual(['oak']);
    expect(warn).toHaveBeenCalledTimes(2);
    await m.finish('oak');
    expect(oak.map?.repeat.x).toBeCloseTo(0.5);
    expect(oak.map?.colorSpace).toBe(SRGBColorSpace);
    expect(oak.normalMap?.colorSpace).toBe(NoColorSpace);
    expect(oak.roughnessMap?.anisotropy).toBe(4);
    expect(oak.roughness).toBe(1);
    expect(changes).toHaveBeenCalled();
    lib.dispose();
    expect(oak.map).toBeNull();
    expect(cache.stats().loaded).toBe(0);
    warn.mockRestore();
  });

  it('one library across 50 edits: the loader runs once per slug and the textured floor never shows paint again', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader);
    const onChange = vi.fn();
    const lib = createMaterialLibrary(null, undefined, { cache, catalog, anisotropy: 4, onChange });
    lib.update(scene.materials);
    const oak = lib.get('m-oak') as import('three').MeshStandardMaterial;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await m.finish('oak');
    expect(oak.map).not.toBeNull();
    const map = oak.map;
    const versionOf = () => [oak.map?.version, oak.normalMap?.version, oak.roughnessMap?.version, oak.version];
    const before = versionOf();
    for (let i = 0; i < 50; i++) {
      // an unrelated swatch click, a drag frame, and a re-tiling: new scene objects, same oak definition
      const next = {
        materials: scene.materials.map((mat) => (mat.id === 'm-white' ? { ...mat, color: `#${(0x100000 + i * 997).toString(16).padStart(6, '0')}` } : { ...mat })),
      };
      lib.update(next.materials);
      expect(lib.get('m-oak')).toBe(oak);
      expect(oak.map).toBe(map);
      await Promise.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(m.calls).toEqual(['oak']);
    expect(cache.stats()).toMatchObject({ loaded: 1, slugs: ['oak'] });
    expect(versionOf()).toEqual(before); // no re-upload, no shader recompile
    // re-tiling updates in place without touching the maps
    lib.update(scene.materials.map((mat) => (mat.id === 'm-oak' ? { ...mat, textureScale: 4 } : mat)));
    expect(oak.map).toBe(map);
    expect(oak.map?.repeat.x).toBeCloseTo(0.25);
    expect(m.calls).toEqual(['oak']);
    lib.dispose();
  });

  it('retargeting to another slug keeps the old maps until the new set arrives, and the old set goes idle', async () => {
    const m = mockLoader();
    const cache = createTextureCache(m.loader);
    const both = { ...catalog, entry: (slug: string) => Promise.resolve({ ...entry, id: slug } as never) };
    const lib = createMaterialLibrary(null, undefined, { cache, catalog: both });
    const def = { id: 'm', name: 'm', kind: 'texture' as const, color: '#93704d', roughness: 0.5, textureUrl: 'lib:oak', textureScale: 2 };
    lib.update([def]);
    const mat = lib.get('m') as import('three').MeshStandardMaterial;
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await m.finish('oak');
    const oakMap = mat.map;
    expect(oakMap).not.toBeNull();
    lib.update([{ ...def, textureUrl: 'lib:ash' }]);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(mat.map).toBe(oakMap); // no flash back to paint
    await m.finish('ash');
    expect(mat.map).not.toBe(oakMap);
    expect(mat.map).not.toBeNull();
    expect(cache.stats()).toMatchObject({ loaded: 1, slugs: ['ash'], idle: 1 });
    // paint -> texture -> paint on the same object, releasing the set
    lib.update([{ ...def, kind: 'paint' as const, textureUrl: undefined } as never]);
    expect(lib.get('m')).toBe(mat);
    expect(mat.map).toBeNull();
    lib.dispose();
  });

  it('a material removed by update is disposed at commit, not before', () => {
    const lib = createMaterialLibrary({ materials: scene.materials });
    const white = lib.get('m-white');
    const spy = vi.spyOn(white, 'dispose');
    lib.update(scene.materials.filter((mat) => mat.id !== 'm-white'));
    expect(spy).not.toHaveBeenCalled();
    lib.commit();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('clamps pure white paint in the viewer only', () => {
    const lib = createMaterialLibrary(scene);
    const white = lib.get('m-white') as import('three').MeshStandardMaterial;
    expect(white.color.getHexString()).not.toBe('ffffff');
    expect(scene.materials[3]!.color).toBe('#ffffff');
    expect(textureTint('#93704d')).toBe(1);
  });
});

describe('catalog source', () => {
  it('fetches once, lazily, and answers by slug', async () => {
    const fetcher = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve([]) }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const src = createCatalogSource(fetcher, '/materials/catalog.json');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await src.entry('x')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('serves the viewer (entry) and the Finish panel (all) from one fetch, and retries after a failure', async () => {
    const json = JSON.parse(readFileSync(resolve(__dirname, '../../public/materials/catalog.json'), 'utf8')) as { id: string }[];
    let ok = false;
    const fetcher = vi.fn(() => Promise.resolve({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(json) }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const src = createCatalogSource(fetcher, '/materials/catalog.json');
    await expect(src.all()).rejects.toThrow('HTTP 503');
    expect(await src.entry(json[0]!.id)).toBeUndefined();
    ok = true;
    expect((await src.all()).map((e) => e.id)).toEqual(json.map((e) => e.id));
    expect((await src.entry(json[0]!.id))?.id).toBe(json[0]!.id);
    await src.entry(json[1]!.id);
    await src.all();
    expect(fetcher).toHaveBeenCalledTimes(3); // two failures, one success; nothing after that
    warn.mockRestore();
  });
});
