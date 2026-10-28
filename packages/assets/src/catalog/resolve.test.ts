import { describe, expect, it } from 'vitest';
import '../register'; // fills GENERATORS
import { GENERATORS, createGeneratorRegistry } from '@flat/scene';
import { EMPTY_MESH_CATALOG, MAX_LOOKALIKE_DISTORTION, MeshAsset, createMeshCatalog } from './mesh-catalog';
import { resolveMesh } from './resolve';

const asset = {
  id: 'polyhaven:sofa_03',
  name: 'Sofa 03',
  source: 'cc0',
  licence: 'CC0-1.0',
  credit: 'Poly Haven',
  category: 'sofa',
  styleTags: ['modern'],
  nativeDims: { w: 2.1, d: 0.95, h: 0.8 },
  file: 'sofa_03.glb',
};

const lib = (id: string, category: MeshAsset['category'], nativeDims: MeshAsset['nativeDims'], styleTags: string[] = []): MeshAsset =>
  MeshAsset.parse({ ...asset, id, category, nativeDims, styleTags });


describe('resolveMesh', () => {
  const dims = { w: 1.6, d: 2.0, h: 0.9 };
  const snapshot = {
    provider: 'mock',
    sku: 'MOCK-BED-160',
    name: 'Bed',
    url: 'https://shop.mock.example/p/bed',
    price: 299,
    currency: 'EUR',
    dims,
    category: 'bed' as const,
    snapshotAt: '2026-10-27T10:00:00.000Z',
  };
  const sofaLib = lib('lib:bed', 'bed', { w: 1.5, d: 1.9, h: 0.85 });
  const catalog = createMeshCatalog([sofaLib]);
  const ctx = { catalog, generators: GENERATORS, providerModelAvailable: (id: string) => id === 'mock:MOCK-BED-160' };
  const base = { assetId: 'x', product: snapshot, productRef: { provider: 'mock', sku: 'MOCK-BED-160' }, dims } as const;

  it('legacy builtin items resolve to builtin at the asset dims', () => {
    expect(resolveMesh({ assetId: 'builtin:tv-55' }, ctx)).toMatchObject({ source: 'builtin', dims: { w: 1.23, d: 0.05, h: 0.71 } });
  });
  it('a provider mesh wins when the local server has the model', () => {
    const r = resolveMesh({ ...base, mesh: { kind: 'provider' } }, ctx);
    expect(r).toMatchObject({ source: 'provider', product: 'mock:MOCK-BED-160', dims });
  });
  it('degrades provider -> lookalike -> parametric -> placeholder', () => {
    const noModel = { ...ctx, providerModelAvailable: () => false };
    const r1 = resolveMesh({ ...base, mesh: { kind: 'provider' } }, noModel);
    expect(r1).toMatchObject({ source: 'lookalike', asset: { id: 'lib:bed' }, dims });
    expect(r1.distortion).toBeLessThanOrEqual(MAX_LOOKALIKE_DISTORTION);
    expect(r1.scale[0]).toBeCloseTo(1.6 / 1.5, 9);
    const r2 = resolveMesh({ ...base, mesh: { kind: 'provider' } }, { ...noModel, catalog: EMPTY_MESH_CATALOG });
    expect(r2).toMatchObject({ source: 'parametric', generator: { id: 'bed' }, dims });
    expect(r2.generator!.params).toMatchObject({ w: 1.6, l: 2, h: 0.9 });
    const r3 = resolveMesh({ ...base, mesh: { kind: 'provider' } }, { ...noModel, catalog: EMPTY_MESH_CATALOG, generators: createGeneratorRegistry() });
    expect(r3).toMatchObject({ source: 'placeholder', dims });
    expect(r3.reason).toMatch(/labelled box/);
  });
  it('a stored lookalike that would distort too much falls through to parametric', () => {
    const odd = createMeshCatalog([lib('lib:odd', 'bed', { w: 3, d: 2, h: 0.9 })]);
    const r = resolveMesh({ ...base, mesh: { kind: 'lookalike', assetId: 'lib:odd' } }, { ...ctx, catalog: odd });
    expect(r.source).toBe('parametric');
    expect(r.reason).toMatch(/default bed generator/);
    expect(resolveMesh({ ...base, mesh: { kind: 'lookalike', assetId: 'lib:bed' } }, ctx)).toMatchObject({ source: 'lookalike', asset: { id: 'lib:bed' } });
    expect(resolveMesh({ ...base, mesh: { kind: 'lookalike', assetId: 'gone' } }, { ...ctx, catalog: EMPTY_MESH_CATALOG }).source).toBe('parametric');
  });
  it('a stored parametric mesh is honoured, even when a provider model exists; invalid params fall back to the default', () => {
    const r = resolveMesh({ ...base, mesh: { kind: 'parametric', generator: 'bed', params: { w: 1.6, l: 2, h: 0.9, headboard: false } } }, ctx);
    expect(r).toMatchObject({ source: 'parametric', generator: { id: 'bed', params: { headboard: false } } });
    const bad = resolveMesh({ ...base, mesh: { kind: 'parametric', generator: 'bed', params: { w: -1 } } }, ctx);
    expect(bad).toMatchObject({ source: 'parametric', generator: { id: 'bed', params: { headboard: true } } });
  });
  it('without a mesh, a product runs the whole chain; without anything it is a 0.3 m labelled box', () => {
    expect(resolveMesh({ ...base }, ctx).source).toBe('provider');
    expect(resolveMesh({ ...base }, { ...ctx, providerModelAvailable: undefined }).source).toBe('lookalike');
    expect(resolveMesh({ assetId: 'mystery' }, ctx)).toMatchObject({ source: 'placeholder', dims: { w: 0.3, d: 0.3, h: 0.3 } });
    expect(resolveMesh({ assetId: 'param:bed', dims }, ctx)).toMatchObject({ source: 'placeholder', dims });
  });
  it('categories without a parametric shape end as a labelled box at the exact dims', () => {
    const lamp = { ...base, product: { ...snapshot, category: 'lamp' as const } };
    expect(resolveMesh(lamp, { ...ctx, catalog: EMPTY_MESH_CATALOG, providerModelAvailable: undefined })).toMatchObject({ source: 'placeholder', dims });
  });
  it('is deterministic', () => {
    expect(resolveMesh({ ...base }, ctx)).toEqual(resolveMesh({ ...base }, ctx));
  });
});
