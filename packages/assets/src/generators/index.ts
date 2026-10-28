import type { AnyGenerator } from '@flat/scene';
import { cooktop, fridge } from './appliances';
import { bathtub, toilet, washbasin } from './bathroom';
import { island, kitchenBase, kitchenWall, nightstand, sideboard, tvUnit, wardrobe } from './cabinets';
import { bed, bookshelf, chair, desk, sofa, table } from './living';
import { mirror, rug, tv } from './misc';

export { GENERATOR_OWNER_ID } from './kit';
export { MIRROR_DEPTH, RUG_THICKNESS } from './misc';

/** Every parametric generator, in id order (D6: 15 furniture generators plus the TV, then the fixed bathroom and kitchen ware). */
export const ALL_GENERATORS: readonly AnyGenerator[] = [bathtub, bed, bookshelf, chair, cooktop, desk, fridge, island, kitchenBase, kitchenWall, mirror, nightstand, rug, sideboard, sofa, table, toilet, tv, tvUnit, wardrobe, washbasin];
