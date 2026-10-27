import { GENERATORS } from '@flat/scene';

/**
 * Short human names of the parametric generators. A generator's own `label` is a long description written for the
 * assistant (it names mounts, French terms, parameters), so the UI uses these for cards, item names and history,
 * and keeps the description as a tooltip.
 */
const TITLES: Readonly<Record<string, string>> = {
  mirror: 'Mirror',
  rug: 'Rug',
  tv: 'TV',
  bookshelf: 'Bookshelf',
  table: 'Table',
  chair: 'Chair',
  sofa: 'Sofa',
  desk: 'Desk',
  bed: 'Bed',
  wardrobe: 'Wardrobe',
  kitchenBase: 'Kitchen base unit',
  kitchenWall: 'Kitchen wall unit',
  sideboard: 'Sideboard',
  tvUnit: 'TV unit',
  nightstand: 'Bedside table',
  bathtub: 'Bathtub',
  toilet: 'Toilet',
  washbasin: 'Washbasin',
  cooktop: 'Cooktop',
  fridge: 'Fridge',
};

/** The short name of a generator; an unlisted one falls back to the first words of its description. */
export function generatorTitle(g: { id: string; label?: string }): string {
  const known = TITLES[g.id];
  if (known) return known;
  const first = (g.label ?? g.id).split(/[(:,/]/)[0]!.trim();
  return first || g.id;
}

/** Title by generator id (also for ids the registry does not know). */
export function generatorTitleById(id: string): string {
  const g = GENERATORS.get(id);
  return generatorTitle(g ?? { id });
}

export const GENERATOR_TITLE_IDS: readonly string[] = Object.keys(TITLES);
