// Scene tests run against an empty generator registry (core modules do not import @flat/assets). The few that need a
// parametric `bed` register this stand-in, which mirrors the real generator's contract (params w / l / h / headboard,
// dims { w, d: l, h }) without any geometry. Tests that need the REAL generators live in packages/assets/src/__scene__/.
import { afterAll, beforeAll } from 'vitest';
import { z } from 'zod';
import { GENERATORS, type Generator } from '../src/items/mesh-source';

const params = z.object({ w: z.number().positive(), l: z.number().positive(), h: z.number().positive(), headboard: z.boolean().optional() });

export const fakeBedGenerator: Generator<z.infer<typeof params>> = {
  id: 'bed',
  label: 'fake bed (scene tests)',
  category: 'bed',
  params,
  describeParams: ({ w, l, h }) => ({ dims: { w, d: l, h }, anchors: [], clearance: {} }),
  generate: () => {
    throw new Error('the fake bed has no geometry');
  },
};

/** Registers the fake `bed` for the tests of the calling file (beforeAll / afterAll). */
export function useFakeBed(): void {
  beforeAll(() => GENERATORS.register(fakeBedGenerator));
  afterAll(() => GENERATORS.unregister('bed'));
}
