// Scene behaviour that depends on the REAL generators. Scene's own tests run against an empty registry (modules.md step 11),
// so the cases that need `@flat/assets` registered live here, in the package that owns the generators.
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { describe, expect, it } from 'vitest';
import { parseScene, validateScene } from '@flat/scene';
import '../register';

function load(input: unknown) {
  const r = parseScene(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}

describe('validateScene on the Charme fixture, generators registered', () => {
  it('Charme 3205 is clean: every room edge is backed, no overlaps, lights inside, no openings near junctions (bar the two hall-facing cupboards)', () => {
    // 1. The closet of Chambre 2 is in the wall thickness and opens onto the Entrée: Chambre 2 keeps its polygon (the official
    //    area includes the closet) and neither room has a wall along the closet doors -> ch2 edge + entree edge.
    // 2. The TE cupboard is recessed into the SDB's north-east corner and opens onto the Entrée: w-sdb-north is split around
    //    the 0.44 m gap (5.95 -> 6.39). The SDB polygon keeps the recess (official area) and the Entrée's south edge has no
    //    wall along the cupboard front -> entree edge + sdb edge.
    // Columns (w-kitchen-column, w-ch1-column, w-sdb-column) and the 7 cm stub w-sdb-north-east raise nothing.
    expect(validateScene(load(charme)).warnings.map((w) => [w.code, ...w.entityIds])).toEqual([
      ['room-edge-unwalled', 'ch2'],
      ['room-edge-unwalled', 'entree'],
      ['room-edge-unwalled', 'entree'],
      ['room-edge-unwalled', 'sdb'],
    ]);
  });

});
