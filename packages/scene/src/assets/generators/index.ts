import { GENERATORS } from '../catalog';
import type { AnyGenerator, GeneratorRegistry } from '../catalog';
import { kitchenBase, kitchenWall, nightstand, sideboard, tvUnit, wardrobe } from './cabinets';
import { bed, bookshelf, chair, desk, sofa, table } from './living';
import { mirror, rug, tv } from './misc';

export { GENERATOR_OWNER_ID } from './kit';
export { MIRROR_DEPTH, RUG_THICKNESS, TV_55_DIAGONAL_M, tvDims } from './misc';

/** Every parametric generator, in id order (D6: 14 furniture generators plus the TV). */
export const ALL_GENERATORS: readonly AnyGenerator[] = [bed, bookshelf, chair, desk, kitchenBase, kitchenWall, mirror, nightstand, rug, sideboard, sofa, table, tv, tvUnit, wardrobe];

/** Registers every generator in `registry` (default: the process-wide `GENERATORS`). Idempotent. */
export function registerGenerators(registry: GeneratorRegistry = GENERATORS): void {
  for (const g of ALL_GENERATORS) if (!registry.get(g.id)) registry.register(g);
}

// Side effect: importing this module (the `assets` barrel does, hence `@flat/scene`) fills the process-wide registry,
// so parsing a scene with a parametric mesh checks its params and dims against the generator.
registerGenerators();
