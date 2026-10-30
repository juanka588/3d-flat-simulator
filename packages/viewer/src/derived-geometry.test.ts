import { readFileSync } from 'node:fs';
import { buildItems } from '@flat/assets';
import { buildShell, loadSceneText } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { CEILING_CASTER_LIFT_M, CLOSED_CASTER_SWELL_M, closedCasterGeometry, partyRecessGeometry, partyWallIds, shadowCasterGeometry } from './derived-geometry';

const loaded = loadSceneText(readFileSync(new URL('../../scene/fixtures/charme-3205.flat.json', import.meta.url), 'utf8'));
if (!loaded.ok) throw new Error('fixture does not load');

describe('shadow casters', () => {
  it('leave out the clear glass of the bath screen (it casts no shadow) and keep everything else', () => {
    const shell = buildShell(loaded.scene, { items: buildItems });
    const glass = shell.items.groups.filter((g) => g.materialId === 'builtin:furniture-glass-clear').reduce((n, g) => n + g.count, 0);
    expect(glass).toBeGreaterThan(0);
    const all = [shell.walls, shell.fittings, shell.items, shell.ceilings, shell.floors, shell.ceilings].reduce((n, m) => n + m.indices.length, 0);
    expect(shadowCasterGeometry(shell).getIndex()!.count).toBe(all - glass);
  });
});

const scene = loaded.scene;
const shell = buildShell(scene);

describe('closedCasterGeometry (no sun slides along a joint of the walls)', () => {
  const geometry = closedCasterGeometry(shell);
  const positions = geometry.getAttribute('position').array as Float32Array;

  it('holds the walls and the ceilings, indexed against its own vertices', () => {
    const vertices = shell.walls.positions.length / 3 + shell.ceilings.positions.length / 3;
    expect(positions.length / 3).toBe(vertices);
    expect(geometry.getIndex()!.count).toBe(shell.walls.indices.length + shell.ceilings.indices.length);
    for (let i = 0; i < geometry.getIndex()!.count; i++) expect(geometry.getIndex()!.getX(i)).toBeLessThan(vertices);
  });

  it('swells the walls by a few mm (outward, less than the depth bias) and keeps every box closed', () => {
    // Every wall vertex sits at most the swell away from where it was, along the sum of the normals of the faces that share it.
    let moved = 0;
    for (let v = 0; v < shell.walls.positions.length / 3; v++) {
      const d = Math.hypot(positions[v * 3]! - shell.walls.positions[v * 3]!, positions[v * 3 + 1]! - shell.walls.positions[v * 3 + 1]!, positions[v * 3 + 2]! - shell.walls.positions[v * 3 + 2]!);
      expect(d).toBeLessThanOrEqual(CLOSED_CASTER_SWELL_M + 1e-6);
      if (d > 1e-6) moved++;
    }
    expect(moved).toBeGreaterThan(shell.walls.positions.length / 3 / 2);
    expect(CLOSED_CASTER_SWELL_M).toBeLessThan(0.015);
    // Vertices that were one point stay one point (the faces still meet).
    const seen = new Map<string, string>();
    for (let v = 0; v < shell.walls.positions.length / 3; v++) {
      const before = [0, 1, 2].map((k) => Math.round(shell.walls.positions[v * 3 + k]! * 1e4)).join(',');
      const after = [0, 1, 2].map((k) => positions[v * 3 + k]!.toFixed(5)).join(',');
      if (seen.has(before)) expect(after).toBe(seen.get(before));
      seen.set(before, after);
    }
  });

  it('lifts the ceilings above the room, so the top of every wall under the roof is in shadow', () => {
    const offset = shell.walls.positions.length / 3;
    for (let v = 0; v < shell.ceilings.positions.length / 3; v++) {
      expect(positions[(offset + v) * 3 + 1]! - shell.ceilings.positions[v * 3 + 1]!).toBeCloseTo(CEILING_CASTER_LIFT_M, 5);
      expect(positions[(offset + v) * 3]).toBe(shell.ceilings.positions[v * 3]);
    }
  });
});

describe('party walls and what lies behind a door in one', () => {
  it('are the walls towards the landing and the neighbours, not the facade or a partition', () => {
    const party = partyWallIds(scene);
    for (const id of ['w-sdb-east', 'w-landing', 'w-wc-south']) expect(party.has(id), id).toBe(true);
    for (const id of ['w-north', 'w-south', 'w-east', 'w-sdb-north', 'w-wc-west']) expect(party.has(id), id).toBe(false);
  });

  it('the front door opens on a closed dark recess: five faces looking inward, 1.2 m deep, on the landing side of the wall', () => {
    const geometry = partyRecessGeometry(scene)!;
    expect(geometry).not.toBeNull();
    const positions = geometry.getAttribute('position').array as Float32Array;
    const normals = geometry.getAttribute('normal').array as Float32Array;
    // door-entry: w-landing (y 6.115, 17 cm), centre x 7.78, 0.9 wide; the hall is to the north (y < 6.03), the landing to the south.
    expect(positions.length / 3).toBe(20);
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let v = 0; v < positions.length / 3; v++) {
      minX = Math.min(minX, positions[v * 3]!);
      maxX = Math.max(maxX, positions[v * 3]!);
      minZ = Math.min(minZ, positions[v * 3 + 2]!);
      maxZ = Math.max(maxZ, positions[v * 3 + 2]!);
    }
    expect(minX).toBeCloseTo(7.78 - 0.45, 2);
    expect(maxX).toBeCloseTo(7.78 + 0.45, 2);
    expect(minZ).toBeGreaterThan(6.115);
    expect(maxZ).toBeCloseTo(6.115 + 0.085 + 1.2, 2);
    // The winding agrees with the normals (a face seen from inside the box is a front face), and the faces look at the box's centre.
    const index = geometry.getIndex()!;
    const centre = [(minX + maxX) / 2, 1, (minZ + maxZ) / 2];
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      const e1 = [0, 1, 2].map((k) => positions[b * 3 + k]! - positions[a * 3 + k]!);
      const e2 = [0, 1, 2].map((k) => positions[c * 3 + k]! - positions[a * 3 + k]!);
      const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const n = [normals[a * 3]!, normals[a * 3 + 1]!, normals[a * 3 + 2]!];
      expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
      const toCentre = [0, 1, 2].map((k) => centre[k]! - positions[a * 3 + k]!);
      expect(toCentre[0]! * n[0]! + toCentre[1]! * n[1]! + toCentre[2]! * n[2]!).toBeGreaterThan(0);
    }
  });

  it('is nothing for a flat with no door in a party wall', () => {
    expect(partyRecessGeometry({ ...scene, openings: scene.openings.filter((o) => o.wallId !== 'w-landing') })).toBeNull();
  });
});
