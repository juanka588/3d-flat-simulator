import type { AnyGenerator } from '@flat/scene';
import { cooktop, fridge } from './appliances';
import { bathtub, toilet, washbasin } from './bathroom';
import { island, kitchenBase, kitchenWall, nightstand, sideboard, tvUnit, wardrobe } from './cabinets';
import { bed, bookshelf, chair, desk, sofa, table } from './living';
import { mirror, tv } from './misc';
import { RUG_THICKNESS, rug } from './rug';
import { curtains, pendant } from './soft';

export { GENERATOR_OWNER_ID } from './kit';
export { MIRROR_DEPTH } from './misc';
export { RUG_THICKNESS };

/** Every parametric generator, in id order (D6: 15 furniture generators plus the TV, then the fixed bathroom and kitchen ware). */
export const ALL_GENERATORS: readonly AnyGenerator[] = [bathtub, bed, bookshelf, chair, cooktop, curtains, desk, fridge, island, kitchenBase, kitchenWall, mirror, nightstand, pendant, rug, sideboard, sofa, table, toilet, tv, tvUnit, wardrobe, washbasin];
