import type { GridLight, Vec2 } from '../schema';

/** Geometry of `grid` lights (a leaf module: the validator uses it too). Pure. */

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Rotates a local plan offset by `degrees` counter-clockwise seen from above (plan y grows down; three's `rotation.y`). */
export function rotatePlan(dx: number, dy: number, degrees: number): Vec2 {
  const c = Math.cos(rad(degrees));
  const s = Math.sin(rad(degrees));
  return [dx * c + dy * s, -dx * s + dy * c];
}

/** Plan positions of every fixture of a grid, row by row (rows run along local y, columns along local x). */
export function gridFixtures(grid: Pick<GridLight, 'position' | 'rows' | 'cols' | 'width' | 'depth' | 'rotation'>): Vec2[] {
  const out: Vec2[] = [];
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const [dx, dy] = rotatePlan(-grid.width / 2 + ((i + 0.5) * grid.width) / grid.cols, -grid.depth / 2 + ((j + 0.5) * grid.depth) / grid.rows, grid.rotation);
      out.push([grid.position[0] + dx, grid.position[1] + dy]);
    }
  }
  return out;
}

/** Pitch between neighbouring fixtures: `[along local x, along local y]` in metres. */
export function gridPitch(grid: Pick<GridLight, 'rows' | 'cols' | 'width' | 'depth'>): Vec2 {
  return [grid.width / grid.cols, grid.depth / grid.rows];
}

/** One representative light of a grid: the fixtures of a tile, lit as one source at their centroid. */
export interface GridCluster {
  position: Vec2;
  /** Fixtures the cluster stands for; its flux is `count x lumensEach`, so the grid's total flux is exact. */
  count: number;
}

function split(n: number, parts: number): number[] {
  const base = Math.floor(n / parts);
  const extra = n % parts;
  return Array.from({ length: parts }, (_, k) => base + (k < extra ? 1 : 0));
}

/**
 * Groups a grid into at most `maxClusters` tiles of neighbouring fixtures (the viewer lights each tile
 * with one real light; see docs/photometry.md "Grids"). The tile counts follow the grid's aspect ratio.
 * Every fixture belongs to exactly one tile, so the counts add up to `rows x cols`.
 */
export function gridClusters(grid: Pick<GridLight, 'position' | 'rows' | 'cols' | 'width' | 'depth' | 'rotation'>, maxClusters: number): GridCluster[] {
  const budget = Math.max(1, Math.floor(maxClusters));
  let best = { kr: 1, kc: 1, score: -Infinity };
  for (let kr = 1; kr <= Math.min(grid.rows, budget); kr++) {
    const kc = Math.min(grid.cols, Math.floor(budget / kr));
    if (kc < 1) continue;
    const used = kr * kc;
    // prefer more tiles, then square tiles
    const aspect = Math.abs(Math.log(grid.width / kc / (grid.depth / kr)));
    const score = used * 1000 - aspect;
    if (score > best.score) best = { kr, kc, score };
  }
  const rowParts = split(grid.rows, best.kr);
  const colParts = split(grid.cols, best.kc);
  const out: GridCluster[] = [];
  let r0 = 0;
  for (const nr of rowParts) {
    let c0 = 0;
    for (const nc of colParts) {
      // centroid of the tile's cells in the grid's local frame
      const lx = -grid.width / 2 + ((c0 + nc / 2) * grid.width) / grid.cols;
      const ly = -grid.depth / 2 + ((r0 + nr / 2) * grid.depth) / grid.rows;
      const [dx, dy] = rotatePlan(lx, ly, grid.rotation);
      out.push({ position: [grid.position[0] + dx, grid.position[1] + dy], count: nr * nc });
      c0 += nc;
    }
    r0 += nr;
  }
  return out;
}

