import { describe, expect, it } from 'vitest';
import { categoryOf, mountOf, reclassify } from './category';

describe('bathroom, kitchen and storage categories', () => {
  it.each([
    ['Rideau de douche', 'shower_curtain'],
    ['Rideaux, 2 pièces', 'curtain'],
    ['Porte-serviettes avec 2 barres', 'towel_rail'],
    ['Portant serviettes', 'towel_rail'],
    ['Towel rail', 'towel_rail'],
    ['Radiateur à eau chaude', 'radiator'],
    ['Vasque avec siphon', 'washbasin'],
    ['Vasque semi-encastré avec siphon', 'washbasin'],
    ['Meuble lavabo avec tiroirs', 'vanity'],
    ['Meuble lavabo avec tiroirs/vasque', 'vanity'],
    ['Élément sous-lavabo', 'vanity'],
    ['Élément bas lavabo 2 portes', 'vanity'],
    ['Étagère douche', 'bath_accessory'],
    ['Panier à ventouse', 'bath_accessory'],
    ['Étagère murale', 'shelf'],
    ['Patère', 'hook'],
    ['Crochet adhésif pour cadre', 'hook'],
    ['Colonne', 'tall_cabinet'],
    ['Colonne avec portes et tiroirs', 'tall_cabinet'],
    ['Îlot de cuisine avec casier', 'kitchen_island'],
    ['Îlot cuisine av étagère', 'kitchen_island'],
    ['Armoire four + 2 portes/tablette', 'appliance_housing'],
    ['Armoire micro-ondes av porte/2 tir', 'appliance_housing'],
    ['Armoire réfrigérateur + 2 portes', 'appliance_housing'],
    ['Armoire 2 portes', 'wardrobe'],
    ['Four à micro-ondes encastrable', 'appliance'],
    ['Rangement TV/vitrines', 'tv_unit'],
    ['Combinaison TV/rangement', 'tv_unit'],
    ['Range-chaussures 4 casiers', 'sideboard'],
    ['Panier à linge', 'storage'],
    ['Poubelle', 'storage'],
    ['Élément haut avec portes', 'wall_cabinet'],
    ['Coiffeuse avec miroir', 'drawers'],
    ['Horloge murale', 'decor'],
    ['Commode 6 tiroirs', 'drawers'],
    ['Tapis de bain', 'rug'],
  ] as const)('%s is %s', (type, category) => {
    expect(categoryOf(type)).toBe(category);
  });
});

describe('mount', () => {
  it('hangs bathroom accessories and basins, and stands a floor mirror', () => {
    expect(mountOf('Porte-serviettes', 'towel_rail')).toBe('wall');
    expect(mountOf('Rideau de douche', 'shower_curtain')).toBe('wall');
    expect(mountOf('Vasque', 'washbasin')).toBe('wall');
    expect(mountOf('Patère', 'hook')).toBe('wall');
    expect(mountOf('Meuble lavabo', 'vanity')).toBe('floor');
    expect(mountOf('Colonne', 'tall_cabinet')).toBe('floor');
    expect(mountOf('Miroir sur pied', 'mirror')).toBe('floor');
    expect(mountOf('Applique, installation permanente', 'lamp')).toBe('wall');
    expect(mountOf('Lampe de table', 'lamp')).toBe('floor');
  });
});

describe('reclassify', () => {
  it('the shop type decides, the name only when the type is empty, the previous category when neither says anything', () => {
    expect(reclassify('Vasque avec siphon', 'ORRSJÖN Vasque avec siphon - blanc 82x49 cm', 'other')).toEqual({ category: 'washbasin', mount: 'wall' });
    expect(reclassify('', 'LOBERGET / MALSKÄR Chaise pivotante - blanc', 'desk')).toEqual({ category: 'chair', mount: 'floor' });
    expect(reclassify('Machin inconnu', 'XYZ Machin inconnu', 'desk')).toEqual({ category: 'desk', mount: 'floor' });
    expect(reclassify('Rideau de douche', 'NORDRÖNN Rideau de douche - blanc', 'curtain').category).toBe('shower_curtain');
  });
});
