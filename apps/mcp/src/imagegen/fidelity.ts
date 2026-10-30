import { PNG } from 'pngjs';

/**
 * Fidelity of a generated reference image to OUR control passes: the cheap part of the CG depth spike's metric, pure TypeScript
 * on a 256x192 grid so it runs in the MCP server without a model.
 *  - ceiling sanity: the pixels the ids pass says are ceiling must be pale and unsaturated (the failure it catches is herringbone
 *    parquet or a green wall painted on the ceiling, which the spike saw with depth-only and canny-only controls);
 *  - edge recall: the share of our structural edges that have an image edge within 1 cell (about 4 px at 1024).
 * The full metric (Depth Anything Spearman, CLIP crops of the placeholders) lives in the spike scripts; it is too heavy to run
 * on every candidate.
 */

export const GRID = { w: 256, h: 192 } as const;
/** Colour of the `ceiling` class in the ids pass (the legend of `render_passes` is fixed). */
export const CEILING_RGB = [200, 200, 255] as const;

/** Candidates below these are filtered out. Calibrated on the spike (30 images, 3 views): all wood-ceiling images fail the first. */
export const FIDELITY_THRESHOLDS = { ceilingPale: 0.5, edgeRecall: 0.12 } as const;

export interface FidelityRef {
  ceiling: Uint8Array;
  ceilingCells: number;
  edges: Uint8Array;
  edgeCells: number;
}

export interface Fidelity {
  /** 0..1: the mean of the ceiling check (1 or 0, when the ceiling is in view) and the edge recall. */
  score: number;
  ceilingPale: number | null;
  edgeRecall: number;
  ok: boolean;
  reasons: string[];
}

const png = (b64: string) => PNG.sync.read(Buffer.from(b64, 'base64'));

/** Max-pools `get` (a boolean per source pixel) onto the grid, so a thin edge survives the downsampling. */
function pool(w: number, h: number, get: (i: number) => boolean): Uint8Array {
  const out = new Uint8Array(GRID.w * GRID.h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(GRID.h - 1, Math.floor((y * GRID.h) / h));
    for (let x = 0; x < w; x++) if (get(y * w + x)) out[gy * GRID.w + Math.min(GRID.w - 1, Math.floor((x * GRID.w) / w))] = 1;
  }
  return out;
}

const erode = (m: Uint8Array, r: number): Uint8Array => {
  const out = new Uint8Array(m.length);
  for (let y = r; y < GRID.h - r; y++) {
    for (let x = r; x < GRID.w - r; x++) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r; dx++) if (!m[(y + dy) * GRID.w + x + dx]) { all = 0; break; }
      out[y * GRID.w + x] = all;
    }
  }
  return out;
};

/** The reference side, from the ids pass and the structural edge pass of the control camera (base64 PNGs of the same size). */
export function fidelityRef(idsPngB64: string, edgesPngB64: string): FidelityRef {
  const ids = png(idsPngB64);
  const e = png(edgesPngB64);
  const isCeiling = (i: number) => ids.data[i * 4] === CEILING_RGB[0] && ids.data[i * 4 + 1] === CEILING_RGB[1] && ids.data[i * 4 + 2] === CEILING_RGB[2];
  // a ceiling cell needs the whole pooled cell to be ceiling: pool the complement and invert, then erode off the borders
  const notCeiling = pool(ids.width, ids.height, (i) => !isCeiling(i));
  const ceiling = erode(notCeiling.map((v) => (v ? 0 : 1)), 2);
  const edges = pool(e.width, e.height, (i) => e.data[i * 4]! > 0);
  const sum = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);
  return { ceiling, ceilingCells: sum(ceiling), edges, edgeCells: sum(edges) };
}

/** Box-downsamples an RGBA image onto the grid: [r, g, b] means in 0..1. */
function toGrid(p: PNG): Float32Array {
  const out = new Float32Array(GRID.w * GRID.h * 3);
  const count = new Float32Array(GRID.w * GRID.h);
  for (let y = 0; y < p.height; y++) {
    const gy = Math.min(GRID.h - 1, Math.floor((y * GRID.h) / p.height));
    for (let x = 0; x < p.width; x++) {
      const g = gy * GRID.w + Math.min(GRID.w - 1, Math.floor((x * GRID.w) / p.width));
      const i = (y * p.width + x) * 4;
      out[g * 3] = out[g * 3]! + p.data[i]! / 255;
      out[g * 3 + 1] = out[g * 3 + 1]! + p.data[i + 1]! / 255;
      out[g * 3 + 2] = out[g * 3 + 2]! + p.data[i + 2]! / 255;
      count[g] = count[g]! + 1;
    }
  }
  for (let g = 0; g < count.length; g++) if (count[g]) for (let c = 0; c < 3; c++) out[g * 3 + c] = out[g * 3 + c]! / count[g]!;
  return out;
}

/** Scores a generated PNG (bytes) against the reference side. Throws when the bytes are not a PNG. */
export function scoreFidelity(imagePng: Buffer, ref: FidelityRef): Fidelity {
  const rgb = toGrid(PNG.sync.read(imagePng));
  const n = GRID.w * GRID.h;
  const gray = new Float32Array(n);
  for (let g = 0; g < n; g++) gray[g] = 0.299 * rgb[g * 3]! + 0.587 * rgb[g * 3 + 1]! + 0.114 * rgb[g * 3 + 2]!;

  // ceiling: share of pale, unsaturated cells
  let ceilingPale: number | null = null;
  if (ref.ceilingCells >= 400) {
    let pale = 0;
    for (let g = 0; g < n; g++) {
      if (!ref.ceiling[g]) continue;
      const r = rgb[g * 3]!, gg = rgb[g * 3 + 1]!, b = rgb[g * 3 + 2]!;
      const v = Math.max(r, gg, b);
      const s = v === 0 ? 0 : (v - Math.min(r, gg, b)) / v;
      if (s < 0.4 && v > 0.55) pale++;
    }
    ceilingPale = pale / ref.ceilingCells;
  }

  // image edges: the strongest 12 % of the gradient magnitudes (a Sobel on the grid)
  const mag = new Float32Array(n);
  for (let y = 1; y < GRID.h - 1; y++) {
    for (let x = 1; x < GRID.w - 1; x++) {
      const i = y * GRID.w + x;
      const gx = gray[i - GRID.w + 1]! + 2 * gray[i + 1]! + gray[i + GRID.w + 1]! - gray[i - GRID.w - 1]! - 2 * gray[i - 1]! - gray[i + GRID.w - 1]!;
      const gy = gray[i + GRID.w - 1]! + 2 * gray[i + GRID.w]! + gray[i + GRID.w + 1]! - gray[i - GRID.w - 1]! - 2 * gray[i - GRID.w]! - gray[i - GRID.w + 1]!;
      mag[i] = Math.hypot(gx, gy);
    }
  }
  const sorted = Float32Array.from(mag).sort();
  const cut = sorted[Math.floor(n * 0.88)]!;
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) strong[i] = mag[i]! > Math.max(cut, 1e-3) ? 1 : 0;
  let hit = 0;
  for (let y = 0; y < GRID.h; y++) {
    for (let x = 0; x < GRID.w; x++) {
      if (!ref.edges[y * GRID.w + x]) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && xx >= 0 && yy < GRID.h && xx < GRID.w && strong[yy * GRID.w + xx]) { near = true; break; }
        }
      }
      if (near) hit++;
    }
  }
  const edgeRecall = ref.edgeCells ? hit / ref.edgeCells : 1;

  const reasons: string[] = [];
  if (ceilingPale !== null && ceilingPale < FIDELITY_THRESHOLDS.ceilingPale) reasons.push(`the ceiling is not pale (${Math.round(ceilingPale * 100)} % pale; wood, wallpaper or colour painted on it)`);
  if (edgeRecall < FIDELITY_THRESHOLDS.edgeRecall) reasons.push(`the room's walls, windows and doors are not where the drawing puts them (edge recall ${edgeRecall.toFixed(2)})`);
  const parts = [edgeRecall, ...(ceilingPale === null ? [] : [ceilingPale >= FIDELITY_THRESHOLDS.ceilingPale ? 1 : 0])];
  return { score: Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 1000) / 1000, ceilingPale: ceilingPale === null ? null : Math.round(ceilingPale * 1000) / 1000, edgeRecall: Math.round(edgeRecall * 1000) / 1000, ok: reasons.length === 0, reasons };
}
