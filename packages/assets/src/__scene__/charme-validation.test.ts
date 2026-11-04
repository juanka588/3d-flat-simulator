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
  it('Charme 3205 is clean: every room edge is backed, no overlaps, lights inside, no openings near junctions (bar door-ch1, whose jamb is the Chambre 1 placard side wall, and the two hall-facing cupboards)', () => {
    // 1. The closet of Chambre 2 is in the wall thickness and opens onto the Entrée: Chambre 2 keeps its polygon (the official
    //    area includes the closet) and neither room has a wall along the closet doors -> ch2 edge + entree edge.
    // 2. The TE cupboard is recessed into the SDB's north-east corner and opens onto the Entrée: it is part of the Entrée's
    //    polygon (walled by w-te-west / w-te-south), so it raises nothing; the SDB polygon goes around it.
    // 3. door-ch1 ends at the side wall of the Chambre 1 placard (w-placard-ch1-west is flush with the door jamb, on purpose):
    //    a real opening-near-junction, documented -> door-ch1 on w-ch1-south.
    // Columns (w-kitchen-column, w-ch1-column, w-sdb-column) and the 7 cm stub w-sdb-north-east raise nothing.
    expect(validateScene(load(charme)).warnings.map((w) => [w.code, ...w.entityIds])).toEqual([
      ['opening-near-junction', 'door-ch1', 'w-ch1-south'],
      ['room-edge-unwalled', 'ch2'],
      ['room-edge-unwalled', 'entree'],
    ]);
  });

});
