import type { AnyGenerator } from '@flat/scene';
import { cooktop, fridge, ovenColumn } from './appliances';
import { bathtub, toilet, washbasin } from './bathroom';
import { island, kitchenBase, kitchenWall, nightstand, sideboard, tvUnit, wardrobe } from './cabinets';
import { bed, bookshelf, chair, desk, sofa, table } from './living';
import { mirror, tv } from './misc';
import { RUG_THICKNESS, rug } from './rug';
import { curtains, pendant } from './soft';
import { basket, wallFitting, wallTiles } from './fittings';
import { radiator } from './heating';
import { cushion, frame, lamp, plant, throwBlanket, vase } from './standins';

export { GENERATOR_OWNER_ID } from './kit';
export { MIRROR_DEPTH } from './misc';
export { RUG_THICKNESS };

/** Every parametric generator, in id order (D6: 15 furniture generators plus the TV, then the fixed bathroom and kitchen ware). */
export const ALL_GENERATORS: readonly AnyGenerator[] = [basket, bathtub, bed, bookshelf, chair, cooktop, curtains, cushion, desk, frame, fridge, island, kitchenBase, kitchenWall, lamp, mirror, nightstand, ovenColumn, pendant, plant, radiator, rug, sideboard, sofa, table, throwBlanket, toilet, tv, tvUnit, vase, wallFitting, wallTiles, wardrobe, washbasin];
