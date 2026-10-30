import { GENERATORS, solvePlacement, type Item, type Scene } from '@flat/scene';
import type { LayoutIntent } from './views';

/**
 * Layout placeholders for the reference control images. The layout of a zone is decided from the room (`layoutIntent`); this
 * drops plain parametric volumes for it into a SCRATCH copy of the scene so the depth and edge passes show the model where the
 * sofa, the table, the rug and the bed go. The real scene is never touched: the copy only goes to the renderer as a preview.
 * Spike result: with the placeholders in the control image the sofa faces the TV in every seed; without, it often sits against
 * the wrong wall or the kitchen is replaced.
 */

interface Block {
  generator: string;
  params: Record<string, unknown>;
}

/** Role of a `layoutIntent().place` entry -> generator and default size (metres). Pieces not listed here get no placeholder. */
const BLOCKS: Readonly<Record<string, Block>> = {
  sofa: { generator: 'sofa', params: { w: 2.1, d: 0.95, h: 0.85 } },
  'coffee table': { generator: 'table', params: { w: 0.9, d: 0.6, h: 0.4, legs: 4 } },
  rug: { generator: 'rug', params: { w: 2.4, d: 1.6, shape: 'rect', pattern: 'border' } },
  'media unit': { generator: 'tvUnit', params: { w: 1.6, d: 0.4, h: 0.45 } },
  bed: { generator: 'bed', params: { w: 1.6, l: 2, h: 0.9 } },
  'main piece': { generator: 'sofa', params: { w: 1.8, d: 0.9, h: 0.85 } },
};

export interface Blockout {
  /** The scratch scene: a deep copy of `scene` plus the placeholders. */
  scene: Scene;
  /** Roles that got a placeholder, in placement order. */
  placed: string[];
  /** Roles the solver refused (no room, walkway rule): left out of the control image. */
  skipped: string[];
}

/** Placeholders for a zone's layout intent, or undefined when the intent has no piece we can draw. */
export function blockoutScene(scene: Scene, roomId: string, intent: LayoutIntent): Blockout | undefined {
  const working: Scene = structuredClone(scene);
  const placed: string[] = [];
  const skipped: string[] = [];
  let n = 0;
  for (const p of intent.place) {
    const block = BLOCKS[p.role];
    const g = block ? GENERATORS.get(block.generator) : undefined;
    if (!block || !g) continue;
    const parsed = g.params.safeParse(block.params);
    if (!parsed.success) continue;
    const dims = g.describeParams(parsed.data).dims;
    const solved = solvePlacement(working, { roomId, dims, mount: 'floor', category: g.category, relation: p.relation as never, maxCandidates: 1 });
    if (!solved.ok) {
      skipped.push(p.role);
      continue;
    }
    const pl = solved.placement;
    const item = {
      id: `blockout-${++n}`,
      assetId: `param:${g.id}`,
      position: pl.position,
      rotation: pl.rotation,
      elevation: pl.elevation,
      roomId: pl.roomId,
      mount: 'floor',
      dims: { w: dims.w, d: dims.d, h: dims.h },
      mesh: { kind: 'parametric', generator: g.id, params: block.params },
      concept: true,
      relation: pl.relation,
    } as unknown as Item;
    working.items.push(item);
    placed.push(p.role);
  }
  return placed.length ? { scene: working, placed, skipped } : undefined;
}
