import { describe, expect, it } from 'vitest';
import { parseScene } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { readFileSync } from 'node:fs';
import { checkGhost, fullGhostCheck, ghostColor, GHOST_INVALID_COLOR, GHOST_VALID_COLOR } from './ghost';

const parsed = parseScene(JSON.parse(readFileSync(new URL('../../../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url), 'utf8')));
if (!parsed.ok) throw new Error('fixture');
const scene: Scene = parsed.scene;
const bed = { dims: { w: 1.6, d: 2, h: 0.9 }, mount: 'floor' as const };
const at = (x: number, y: number, rotation = 0) => ({ position: [x, y] as [number, number], rotation, elevation: 0 });

describe('ghost validity', () => {
  it('is green on a free spot of Chambre 1', () => {
    const v = checkGhost(scene, bed, at(8.2, 2));
    expect(v.valid).toBe(true);
    expect(v.roomId).toBe('ch1');
    expect(ghostColor(v)).toBe(GHOST_VALID_COLOR);
  });
  it('is red over the door swing, with the violation message', () => {
    const v = checkGhost(scene, bed, at(8.05, 2.75));
    expect(v.valid).toBe(false);
    expect(v.message).toMatch(/swing|landing/);
    expect(ghostColor(v)).toBe(GHOST_INVALID_COLOR);
  });
  it('is red outside every room and over the locked placard', () => {
    expect(checkGhost(scene, bed, at(-5, -5)).message).toMatch(/Outside every room/);
    expect(checkGhost(scene, bed, at(8.7, 3.6)).valid).toBe(false);
  });
  it('the full check agrees with the cheap one on a free spot and adds the walkway analysis', () => {
    expect(fullGhostCheck(scene, bed, at(8.2, 2), { assetId: 'product:mock' }).valid).toBe(true);
    const tight = fullGhostCheck(scene, bed, at(8.2, 2.7), { assetId: 'product:mock' });
    expect(tight.valid).toBe(false);
  });
  it('a moved item is not an obstacle to itself', () => {
    const wardrobe = scene.items.find((i) => i.id === 'placard-ch1')!;
    const v = checkGhost(scene, { id: wardrobe.id, dims: wardrobe.dims!, mount: 'floor' }, { position: wardrobe.position, rotation: wardrobe.rotation, elevation: 0 });
    expect(v.violations.filter((x) => x.code === 'overlap')).toEqual([]);
  });
});
