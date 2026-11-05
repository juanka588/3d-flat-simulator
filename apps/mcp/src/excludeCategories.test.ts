import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { connect, json } from './testing/inproc';

/** The brief's exclusions (FLAT_EXCLUDE_CATEGORIES): place_item refuses an excluded category with a clear error, everything else still works. */

describe('excluded categories (no curtains)', () => {
  it('are read from FLAT_EXCLUDE_CATEGORIES', () => {
    expect(loadConfig({ FLAT_EXCLUDE_CATEGORIES: ' Curtain, shower_curtain ,' }).excludeCategories).toEqual(['curtain', 'shower_curtain']);
    expect(loadConfig({}).excludeCategories).toBeUndefined();
  });

  it('place_item refuses a curtain concept shape with a clear error, and places other shapes', async () => {
    const { client } = await connect({ excludeCategories: ['curtain'] });
    const curtain = await client.callTool({ name: 'place_item', arguments: { concept: true, generator: 'curtains', params: { w: 1.4, h: 2.2 }, roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-east' } } });
    expect(curtain.isError).toBe(true);
    const err = json(curtain as never);
    expect(err).toMatchObject({ ok: false, code: 'invalid_command', message: expect.stringMatching(/category "curtain", which this brief excludes/) });
    expect(err.hint).toMatch(/curtains and drapes are never part of this design/);
    const rug = await client.callTool({ name: 'place_item', arguments: { concept: true, generator: 'rug', params: { shape: 'round', w: 1.6, d: 1.6 }, roomId: 'ch1', relation: { kind: 'centered_in', roomId: 'ch1' } } });
    expect(rug.isError, JSON.stringify(rug)).toBeFalsy();
  });

  it('without the exclusion a curtain is placed as before', async () => {
    const { client } = await connect({});
    const curtain = await client.callTool({ name: 'place_item', arguments: { concept: true, generator: 'curtains', params: { w: 1.4, h: 2.2 }, roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-east' } } });
    expect(json(curtain as never).code).not.toBe('invalid_command');
  });
});
