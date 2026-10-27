import { GENERATORS } from '../catalog';
import type { AnyGenerator, GeneratorRegistry } from '../catalog';
import { cooktop, fridge } from './appliances';
import { bathtub, toilet, washbasin } from './bathroom';
import { kitchenBase, kitchenWall, nightstand, sideboard, tvUnit, wardrobe } from './cabinets';
import { bed, bookshelf, chair, desk, sofa, table } from './living';
import { mirror, rug, tv } from './misc';

export { GENERATOR_OWNER_ID } from './kit';
export { MIRROR_DEPTH, RUG_THICKNESS, TV_55_DIAGONAL_M, tvDims } from './misc';

/** Every parametric generator, in id order (D6: 14 furniture generators plus the TV, then the fixed bathroom and kitchen ware). */
export const ALL_GENERATORS: readonly AnyGenerator[] = [bathtub, bed, bookshelf, chair, cooktop, desk, fridge, kitchenBase, kitchenWall, mirror, nightstand, rug, sideboard, sofa, table, toilet, tv, tvUnit, wardrobe, washbasin];

/** Registers every generator in `registry` (default: the process-wide `GENERATORS`). Idempotent. */
export function registerGenerators(registry: GeneratorRegistry = GENERATORS): void {
  for (const g of ALL_GENERATORS) if (!registry.get(g.id)) registry.register(g);
}

// Side effect: importing this module (the `assets` barrel does, hence `@flat/scene`) fills the process-wide registry,
// so parsing a scene with a parametric mesh checks its params and dims against the generator.
registerGenerators();
