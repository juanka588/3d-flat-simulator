import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import sample from '../fixtures/sample.flat.json';
import { applyCommand } from './commands/apply';
import { makeEnvelope } from './commands/parse';
import type { Command } from './commands/schema';
import { parseScene } from './parse';
import { planFixes } from './plan-fix';
import type { Scene } from './schema';
import { PLAN_CODES, planCheck, validateScene } from './validate';

function load(input: unknown): Scene {
  const r = parseScene(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}
const clone = <T>(v: T): T => structuredClone(v);
const apply = (scene: Scene, cmd: Command, kind: 'user' | 'llm' = 'user') => applyCommand(scene, makeEnvelope(cmd, { id: 'x', ts: 0, author: { kind } }));
const must = (scene: Scene, cmd: Command) => {
  const r = apply(scene, cmd);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const finding = (scene: Scene, code: string) => planCheck(scene).filter((f) => f.code === code);

/** The two documented exceptions of the Charme flat: the closet fronts of Chambre 2 and the Entrée. */
const DOCUMENTED = [
  ['room-edge-unwalled', 'ch2'],
  ['room-edge-unwalled', 'entree'],
];

/** The Charme fixture as it was before the lead's two fixes: slot beside the Chambre 2 placard, TE cupboard inside the SDB with butt joints. */
function charmeSlot(): Scene {
  const s = clone(charme) as any;
  s.items = s.items.filter((i: any) => i.id !== 'placard-ch2');
  return load(s);
}
function charmeTeInSdb(): Scene {
  const s = clone(charme) as any;
  const wall = (id: string) => s.walls.find((w: any) => w.id === id);
  wall('w-te-west').start = [5.95, 6.1];
  wall('w-te-south').end = [6.39, 6.435];
  s.rooms.find((r: any) => r.id === 'entree').polygon = [[4.54, 4.19], [6.91, 4.19], [6.91, 4.49], [8.7, 4.49], [8.7, 6.03], [4.54, 6.03]];
  s.rooms.find((r: any) => r.id === 'sdb').polygon = [[4.54, 6.1], [6.39, 6.1], [6.39, 8.28], [3.78, 8.28], [3.78, 6.65], [4.54, 6.65]];
  return load(s);
}

/** Minimal 4 x 3 room with four 0.2 m walls (centrelines on the polygon offset by 0.1). */
function box(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: 't',
    site: { latitude: 0, longitude: 0 },
    walls: [
      { id: 'n', start: [-0.1, 0], end: [4.3, 0], thickness: 0.2 },
      { id: 'e', start: [4.2, -0.1], end: [4.2, 3.3], thickness: 0.2 },
      { id: 's', start: [4.3, 3.2], end: [-0.1, 3.2], thickness: 0.2 },
      { id: 'w', start: [0, 3.3], end: [0, -0.1], thickness: 0.2 },
    ],
    rooms: [{ id: 'r', name: 'R', type: 'living', polygon: [[0.1, 0.1], [4.1, 0.1], [4.1, 3.1], [0.1, 3.1]] }],
    ...extra,
  };
}

describe('plan check on the Charme fixture', () => {
  const scene = load(charme);

  it('reports nothing but the documented exceptions as warnings', () => {
    expect(validateScene(scene).warnings.filter((w) => PLAN_CODES.has(w.code)).map((w) => [w.code, ...w.entityIds])).toEqual(DOCUMENTED);
    expect(planCheck(scene).filter((f) => f.severity === 'warning').map((f) => [f.code, ...f.entityIds])).toEqual(DOCUMENTED);
  });

  it('lists the joints drawn exactly at a face as advisories with a safe fix, and applying them leaves only the documented exceptions', () => {
    const advisories = planCheck(scene).filter((f) => f.severity === 'advisory');
    expect(advisories.length).toBeGreaterThan(0);
    expect(advisories.every((f) => f.code === 'wall-joint-no-overlap' && f.fix?.safe === true)).toBe(true);
    const plan = planFixes(scene, 'safe');
    expect(plan.applied.length).toBe(advisories.length);
    const after = planCheck(plan.scene);
    expect(after.map((f) => [f.code, ...f.entityIds])).toEqual(DOCUMENTED);
    // The openings stay where they were in the plan.
    const doorAt = (s: Scene, id: string) => {
      const o = s.openings.find((x) => x.id === id)!;
      const w = s.walls.find((x) => x.id === o.wallId)!;
      const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
      return [w.start[0] + ((w.end[0] - w.start[0]) / len) * o.offset, w.start[1] + ((w.end[1] - w.start[1]) / len) * o.offset];
    };
    for (const o of scene.openings) {
      const [x0, y0] = doorAt(scene, o.id);
      const [x1, y1] = doorAt(plan.scene, o.id);
      expect(Math.hypot(x1! - x0!, y1! - y0!)).toBeLessThan(1e-4);
    }
  });

  it('the sample flat gains no plan warnings', () => {
    expect(planCheck(load(sample)).map((f) => f.code)).toEqual(['opening-near-junction', 'opening-near-junction', 'room-edge-unwalled', 'room-edge-unwalled']);
  });

  it('is fast and deterministic', () => {
    const t = performance.now();
    const a = JSON.stringify(planCheck(scene));
    expect(performance.now() - t).toBeLessThan(500);
    expect(JSON.stringify(planCheck(scene))).toBe(a);
  });
});

describe('wall-gap: the slot beside the Chambre 2 placard', () => {
  const broken = charmeSlot();

  it('warns about the 11.5 cm slot and proposes joining the two walls', () => {
    const [gap] = finding(broken, 'wall-gap');
    expect(gap!.entityIds.sort()).toEqual(['w-ch2-south-west', 'w-sejour-entree']);
    expect(gap!.message).toContain('11.5 cm');
    expect(gap!.fix!.command.commands).toEqual([
      { type: 'wall.setEnds', wallId: 'w-ch2-south-west', end: [4.505, 4.155] },
      { type: 'wall.setEnds', wallId: 'w-sejour-entree', start: [4.505, 4.155] },
    ]);
    expect(validateScene(broken).warnings.map((w) => w.code)).toContain('wall-gap');
  });

  it('applying the fix removes the warning, leaves a valid scene, and undo restores the plan', () => {
    const gap = finding(broken, 'wall-gap')[0]!;
    const done = must(broken, gap.fix!.command);
    expect(finding(done.scene, 'wall-gap')).toEqual([]);
    expect(planCheck(done.scene).filter((f) => f.severity === 'warning').map((f) => f.code)).toEqual(['room-edge-unwalled', 'room-edge-unwalled']);
    expect(must(done.scene, done.inverse).scene).toEqual(broken);
  });

  it('is closed by the locked fitting: no warning with the placard in place', () => {
    expect(finding(load(charme), 'wall-gap')).toEqual([]);
  });
});

describe('the TE cupboard inside the SDB with butt joints', () => {
  const broken = charmeTeInSdb();

  it('warns about the foreign recess and the joint with no overlap', () => {
    const recess = finding(broken, 'room-includes-foreign-recess');
    expect(recess.map((f) => f.entityIds)).toEqual([['sdb', 'entree']]);
    expect(recess[0]!.fix!.safe).toBe(false);
    const joint = finding(broken, 'wall-joint-no-overlap').find((f) => f.entityIds[0] === 'w-te-south');
    expect(joint!.entityIds).toEqual(['w-te-south', 'w-sdb-east']);
    expect(joint!.severity).toBe('advisory');
    expect(joint!.fix!.command.commands).toEqual([{ type: 'wall.setEnds', wallId: 'w-te-south', end: [6.49, 6.435] }]);
  });

  it('the fix carves the recess out of the SDB and adds it to the Entrée, as the lead did by hand', () => {
    const recess = finding(broken, 'room-includes-foreign-recess')[0]!;
    const done = must(broken, recess.fix!.command).scene;
    expect(done.rooms.find((r) => r.id === 'sdb')!.polygon).toEqual([[4.54, 6.1], [5.915, 6.1], [5.915, 6.47], [6.39, 6.47], [6.39, 8.28], [3.78, 8.28], [3.78, 6.65], [4.54, 6.65]]);
    expect(done.rooms.find((r) => r.id === 'entree')!.polygon).toEqual([[4.54, 4.19], [6.91, 4.19], [6.91, 4.49], [8.7, 4.49], [8.7, 6.03], [6.39, 6.03], [6.39, 6.4], [5.985, 6.4], [5.985, 6.03], [4.54, 6.03]]);
    expect(finding(done, 'room-includes-foreign-recess')).toEqual([]);
  });

  it('applying all the proposed fixes ends at the documented exceptions only', () => {
    const ids = planCheck(broken).filter((f) => f.fix).map((f) => f.id!);
    const plan = planFixes(broken, ids);
    expect(plan.skipped).toEqual([]);
    expect(plan.command!.commands.length).toBeGreaterThan(2);
    expect(planCheck(plan.scene).map((f) => [f.code, ...f.entityIds])).toEqual(DOCUMENTED);
    // One batch, one undo.
    const done = must(broken, plan.command!);
    expect(done.scene).toEqual(plan.scene);
    expect(must(done.scene, done.inverse).scene).toEqual(broken);
  });

  it('a closet inside a bedroom is not a foreign recess', () => {
    expect(finding(load(charme), 'room-includes-foreign-recess')).toEqual([]);
  });
});

describe('wall-gap on small scenes', () => {
  it('extends an end that stops short of a wall to its centreline (T), and ignores a free end far from everything', () => {
    const scene = load(box({ walls: [...box().walls, { id: 'p', start: [2, 0.1], end: [2, 2.9], thickness: 0.1 }] }));
    const [gap] = finding(scene, 'wall-gap');
    expect(gap!.id).toBe('wall-gap:p.end:s');
    expect(gap!.fix!.command.commands).toEqual([{ type: 'wall.setEnds', wallId: 'p', end: [2, 3.2] }]);
    expect(finding(load(box({ walls: [...box().walls, { id: 'p', start: [2, 0.1], end: [2, 1.5], thickness: 0.1 }] })), 'wall-gap')).toEqual([]);
  });

  it('does not call a low balcony rail beside a full-height wall a gap', () => {
    const scene = load(box({ walls: [...box().walls, { id: 'rail', start: [1, 3.45], end: [3, 3.45], thickness: 0.05, height: 1 }] }));
    expect(finding(scene, 'wall-gap')).toEqual([]);
  });

  it('a structural wall only gets a snap of a few centimetres from the proposals, and the command refuses more', () => {
    const scene = load(box({ walls: [...box().walls, { id: 'p', start: [2, 0.1], end: [2, 2.85], thickness: 0.1, structural: true }] }));
    const [gap] = finding(scene, 'wall-gap');
    expect(gap!.fix).toBeUndefined();
    expect(gap!.message).toContain('structural');
    const refused = apply(scene, { type: 'wall.setEnds', wallId: 'p', end: [2, 3.2] });
    expect(refused.ok).toBe(false);
    expect(apply(scene, { type: 'wall.setEnds', wallId: 'p', end: [2, 3.0] }).ok).toBe(true);
  });
});

describe('wall-joint-no-overlap', () => {
  it('flags a wall ending exactly at the face of another and extends it by half the other thickness', () => {
    const scene = load(box({ walls: [...box().walls, { id: 'p', start: [2, 0.1], end: [2, 3.1], thickness: 0.1 }] }));
    const joints = finding(scene, 'wall-joint-no-overlap');
    expect(joints.map((j) => j.entityIds)).toEqual([['p', 'n'], ['p', 's']]);
    expect(joints[0]!.fix!.command.commands).toEqual([{ type: 'wall.setEnds', wallId: 'p', start: [2, 0] }]);
    const done = planFixes(scene, 'safe').scene;
    expect(finding(done, 'wall-joint-no-overlap')).toEqual([]);
  });

  it('is not raised for a joint that already overlaps, nor in validateScene warnings', () => {
    const scene = load(box({ walls: [...box().walls, { id: 'p', start: [2, 0.05], end: [2, 3.15], thickness: 0.1 }] }));
    expect(finding(scene, 'wall-joint-no-overlap')).toEqual([]);
    const butt = load(box({ walls: [...box().walls, { id: 'p', start: [2, 0.1], end: [2, 3.1], thickness: 0.1 }] }));
    expect(validateScene(butt).warnings.map((w) => w.code)).not.toContain('wall-joint-no-overlap');
  });
});

describe('room-polygon-off-wall and room-edge-unwalled', () => {
  it('proposes snapping an edge parallel to a wall onto its inner face', () => {
    const scene = load(box({ rooms: [{ id: 'r', name: 'R', type: 'living', polygon: [[0.1, 0.1], [4.1, 0.1], [4.1, 3.0], [0.1, 3.0]] }] }));
    const off = finding(scene, 'room-polygon-off-wall');
    expect(off.map((f) => f.id)).toEqual(['room-polygon-off-wall:r:2']);
    expect(off[0]!.entityIds).toEqual(['r', 's']);
    expect(off[0]!.fix!.safe).toBe(false); // 10 cm is more than a safe snap
    const done = must(scene, off[0]!.fix!.command).scene;
    expect(done.rooms[0]!.polygon).toEqual([[0.1, 0.1], [4.1, 0.1], [4.1, 3.1], [0.1, 3.1]]);
    expect(planCheck(done)).toEqual([]);
  });

  it('a 4 cm offset is a safe snap; an edge far from any wall keeps the plain unwalled warning', () => {
    const near = load(box({ rooms: [{ id: 'r', name: 'R', type: 'living', polygon: [[0.1, 0.1], [4.1, 0.1], [4.1, 3.06], [0.1, 3.06]] }] }));
    const [off] = finding(near, 'room-polygon-off-wall');
    expect(off!.fix!.safe).toBe(true);
    const far = load(box({ rooms: [{ id: 'r', name: 'R', type: 'living', polygon: [[0.1, 0.1], [4.1, 0.1], [4.1, 2.3], [0.1, 2.3]] }] }));
    expect(finding(far, 'room-edge-unwalled').map((f) => f.id)).toEqual(['room-edge-unwalled:rooms[0].polygon[2]']);
    expect(finding(far, 'room-polygon-off-wall')).toEqual([]);
  });
});

describe('degenerate walls and overlapping walls', () => {
  it('reports duplicates, overlaps and zero-length walls without proposing to remove anything', () => {
    const scene = load(
      box({
        walls: [
          ...box().walls,
          { id: 'dup', start: [-0.1, 0], end: [4.3, 0], thickness: 0.2 },
          { id: 'over', start: [1, 0.02], end: [3, 0.02], thickness: 0.1 },
          { id: 'dot', start: [2, 1], end: [2, 1.001], thickness: 0.1 },
        ],
      }),
    );
    const overlaps = finding(scene, 'walls-overlap');
    expect(overlaps.some((f) => f.entityIds.join() === 'n,dup' && f.message.includes('duplicates'))).toBe(true);
    expect(overlaps.some((f) => f.entityIds.includes('over'))).toBe(true);
    expect(overlaps.every((f) => f.fix === undefined)).toBe(true);
    expect(finding(scene, 'wall-zero-length').map((f) => f.entityIds)).toEqual([['dot']]);
  });
});

describe('wall.setEnds and room.setPolygon', () => {
  it('moves an end, keeps the openings in place, and undoes exactly', () => {
    const scene = load(
      box({
        walls: [...box().walls, { id: 'p', start: [2, 0.1], end: [2, 3.1], thickness: 0.1 }],
        openings: [{ id: 'd', wallId: 'p', type: 'door', offset: 1.5, width: 0.9, height: 2.1 }],
      }),
    );
    const done = must(scene, { type: 'wall.setEnds', wallId: 'p', start: [2, 0] });
    expect(done.scene.openings[0]!.offset).toBe(1.6);
    expect(done.changed.walls).toEqual(['p']);
    expect(must(done.scene, done.inverse).scene).toEqual(scene);
  });

  it('refuses a wall shorter than a millimetre, an unknown wall and an opening pushed off the wall', () => {
    const scene = load(box({ walls: [...box().walls, { id: 'p', start: [2, 0.1], end: [2, 3.1], thickness: 0.1 }], openings: [{ id: 'd', wallId: 'p', type: 'door', offset: 0.5, width: 0.9, height: 2.1 }] }));
    expect(apply(scene, { type: 'wall.setEnds', wallId: 'p', end: [2, 0.1] }).ok).toBe(false);
    expect(apply(scene, { type: 'wall.setEnds', wallId: 'nope', end: [2, 1] }).ok).toBe(false);
    expect(apply(scene, { type: 'wall.setEnds', wallId: 'p', start: [2, 0.95] }).ok).toBe(false);
    expect(apply(scene, { type: 'wall.setEnds', wallId: 'p', start: [2, 0.1] }).ok && (apply(scene, { type: 'wall.setEnds', wallId: 'p', start: [2, 0.1] }) as { noop?: boolean }).noop).toBe(true);
  });

  it('room.setPolygon replaces the outline, must stay a simple polygon, and undoes', () => {
    const scene = load(box());
    const done = must(scene, { type: 'room.setPolygon', roomId: 'r', polygon: [[0.1, 0.1], [4.1, 0.1], [4.1, 3.0], [0.1, 3.0]] });
    expect(done.changed.rooms).toEqual(['r']);
    expect(must(done.scene, done.inverse).scene).toEqual(scene);
    expect(apply(scene, { type: 'room.setPolygon', roomId: 'r', polygon: [[0, 0], [4, 3], [4, 0], [0, 3]] }).ok).toBe(false);
  });
});
