import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from './apply';
import { FIXTURES, deepFreeze, env } from './testUtil';
import type { Command } from './schema';
import { Scene } from '../schema';
import { roomWallSides } from '../geometry/room-sides';

type Op = { k: number; a: number; b: number; c: number; n: number };
const opArb = fc.record({
  k: fc.nat(15),
  a: fc.nat(1000),
  b: fc.nat(1000),
  c: fc.nat(1000),
  n: fc.integer({ min: 0, max: 360 }),
});

/** Resolves an abstract op against the current scene, so most generated commands are valid. */
function resolve(scene: Scene, op: Op): Command {
  const pick = <T>(list: readonly T[], i: number): T => list[i % list.length]!;
  const mat = (i: number): string | null => (i % 5 === 0 ? null : pick(scene.materials, i).id);
  const wall = pick(scene.walls, op.a).id;
  const room = pick(scene.rooms, op.a).id;
  const hex = `#${(op.n * 40503 + op.b).toString(16).padStart(6, '0').slice(-6)}`;
  switch (op.k) {
    case 0: return { type: 'wall.setFinish', wallId: wall, side: pick(['left', 'right', 'both'] as const, op.b), materialId: mat(op.c) };
    case 1: return { type: 'room.setWallFinish', roomId: room, materialId: mat(op.c) };
    case 2: return { type: 'room.setFloor', roomId: room, materialId: mat(op.c) };
    case 3: return { type: 'room.setCeiling', roomId: room, materialId: mat(op.c) };
    case 4: return { type: 'scene.setDefaults', wall: mat(op.a), ...(op.b % 2 ? { floor: mat(op.c) } : {}) };
    case 5: return { type: 'site.set', site: { northAngle: op.n, ...(op.b % 3 === 0 ? { address: op.c % 2 ? null : `addr ${op.c}` } : {}) } };
    case 6: return { type: 'material.define', material: { id: `m-${op.a % 4}`, name: 'm', kind: 'paint', color: hex, roughness: 0.5 } };
    case 7: return { type: 'light.add', light: { type: 'point', position: [op.a / 100, op.b / 100], elevation: 2, lumens: op.c } };
    case 8: return scene.lights.length ? { type: 'light.update', id: pick(scene.lights, op.a).id, patch: { on: op.b % 2 === 0, lumens: op.c, ...(op.n % 2 ? { name: null } : { name: 'x' }) } } : { type: 'site.set', site: {} };
    case 9: return scene.lights.length ? { type: 'light.remove', id: pick(scene.lights, op.a).id } : { type: 'site.set', site: {} };
    case 10: return { type: 'wall.setStructural', wallId: wall, structural: pick([true, false, null] as const, op.b) };
    case 11: return { type: 'material.remove', id: pick(scene.materials, op.a).id };
    case 14: {
      // a real side of the room most of the time; sometimes any wall, to exercise the border check
      const sides = roomWallSides(scene, room);
      const s = sides.length && op.n % 7 !== 0 ? pick(sides, op.b) : undefined;
      return { type: 'wall.setFinish', wallId: s?.wallId ?? wall, side: s?.side ?? 'both', materialId: mat(op.c), roomId: room };
    }
    case 15: {
      const sides = roomWallSides(scene, room);
      const s = sides.length ? pick(sides, op.b) : undefined;
      const w = s?.wallId ?? wall;
      return { type: 'batch', label: 'scoped', commands: [
        { type: 'wall.setFinish', wallId: w, side: s?.side ?? 'both', materialId: mat(op.b), roomId: room },
        { type: 'room.setWallFinish', roomId: room, materialId: mat(op.c) },
        { type: 'wall.setFinish', wallId: w, side: 'left', materialId: mat(op.a) },
        { type: 'wall.setFinish', wallId: w, side: s?.side ?? 'both', materialId: mat(op.n), roomId: room },
      ] };
    }
    case 12: return { type: 'batch', label: 'b', commands: [
      { type: 'wall.setFinish', wallId: wall, side: 'both', materialId: mat(op.b) },
      { type: 'room.setFloor', roomId: room, materialId: mat(op.c) },
      { type: 'wall.setStructural', wallId: wall, structural: op.n % 2 === 0 },
    ] };
    default: return { type: 'batch', label: 'bad', commands: [
      { type: 'room.setFloor', roomId: room, materialId: mat(op.c) },
      { type: 'wall.setFinish', wallId: 'does-not-exist', side: 'left', materialId: null },
    ] };
  }
}

/** A failure must be one the scene state explains: no command in this generator fails for no reason. */
function expectedFailure(scene: Scene, cmd: Command, e: { code: string; message: string }): void {
  switch (cmd.type) {
    case 'material.remove': {
      const used = scene.walls.some((w) => w.finish.left === cmd.id || w.finish.right === cmd.id || Object.values(w.roomFinishes ?? {}).some((x) => x.left === cmd.id || x.right === cmd.id)) ||
        scene.rooms.some((r) => r.floorMaterial === cmd.id || r.ceilingMaterial === cmd.id || r.wallFinish === cmd.id) ||
        Object.values(scene.defaults).includes(cmd.id);
      expect(used, `material.remove ${cmd.id} failed (${e.message}) but nothing uses it`).toBe(true);
      expect(e.code).toBe('precondition_failed');
      return;
    }
    case 'batch':
      expect(['unknown_entity', 'precondition_failed', 'no_wall_sides'], e.message).toContain(e.code);
      return;
    case 'wall.setFinish':
      // only a scoped paint can fail, on a room that does not border the wall side
      expect(cmd.roomId, e.message).toBeDefined();
      expect(e.code).toBe('precondition_failed');
      return;
    case 'room.setWallFinish':
      expect(e.code).toBe('no_wall_sides');
      return;
    case 'material.define':
      expect(e.code, e.message).toBe('precondition_failed');
      return;
    default:
      throw new Error(`${cmd.type} failed unexpectedly: ${e.code} ${e.message}`);
  }
}

describe.each(Object.entries(FIXTURES))('properties on %s', (_name, base) => {
  deepFreeze(base);

  it('apply + inverse = identity, results valid, deterministic, inputs never mutated', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
        let scene: Scene = base;
        for (const op of ops) {
          const cmd = resolve(scene, op);
          const e = deepFreeze(env(cmd));
          const r = applyCommand(scene, e);
          expect(applyCommand(scene, e)).toEqual(r);
          if (!r.ok) {
            expect(r.errors.length).toBeGreaterThan(0);
            expectedFailure(scene, cmd, r.errors[0]!);
            continue;
          }
          expect(Scene.safeParse(r.scene).success).toBe(true);
          const back = applyCommand(r.scene, env(r.inverse));
          expect(back.ok).toBe(true);
          if (back.ok) expect(back.scene).toStrictEqual(scene);
          if (r.noop) expect(r.scene).toBe(scene);
          deepFreeze(r.scene);
          scene = r.scene;
        }
      }),
      { numRuns: 150 },
    );
  });

  it('finish then undo is identity for every room', () => {
    for (const room of base.rooms) {
      for (const material of [...base.materials.map((m) => m.id), null]) {
        const r = applyCommand(base, env({ type: 'room.setWallFinish', roomId: room.id, materialId: material }));
        if (!r.ok) {
          expect(r.errors[0]!.code).toBe('no_wall_sides');
          continue;
        }
        const back = applyCommand(r.scene, env(r.inverse));
        expect(back.ok && back.scene).toStrictEqual(base);
      }
    }
  });
});
