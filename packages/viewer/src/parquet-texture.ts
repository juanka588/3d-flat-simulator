import { CanvasTexture, LinearMipmapLinearFilter, LinearFilter, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * Procedural parquet for materials with a `pattern` (herringbone or chevron): one seamless tile drawn on a canvas,
 * repeated at real scale (the floor UVs are plan metres). No image files, no extra texture units beyond the colour map,
 * and it works on software GL like any other canvas texture.
 */

export type ParquetPattern = 'herringbone' | 'chevron';

export interface ParquetSpec {
  pattern: ParquetPattern;
  /** Plank width in metres. */
  plankWidthM: number;
  /** Wood tone, `#rrggbb`. */
  color: string;
}

/** Plank length as a multiple of the width (a 90 mm plank is 630 mm long). */
export const PLANK_RATIO = 7;
export const DEFAULT_PLANK_WIDTH_MM = 90;
/** Longest side of the tile canvas, in pixels. */
export const MAX_TILE_PX = 1024;
/** Pixels per metre of the tile, at most (a small tile is not blown up beyond this). */
export const MAX_PX_PER_M = 640;

/** A plank outline in tile metres, with a shade factor around 1. */
export interface Plank {
  points: [number, number][];
  shade: number;
}

export interface ParquetTile {
  /** Tile size in metres: the pattern repeats at this period in u and v. */
  widthM: number;
  heightM: number;
  planks: Plank[];
}

/** Deterministic noise in [0, 1) from integers (so a tile is the same on every run). */
function noise(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const shadeOf = (a: number, b: number, c = 0): number => 0.88 + 0.24 * noise(a, b, c);

const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Herringbone: planks `k` x 1 cells (k = PLANK_RATIO), horizontal ones step along the diagonal and vertical ones
 * fill the gaps. A cell (x, y) is horizontal when `(x - y) mod 2k < k`, vertical otherwise; the tile is 4k cells
 * wide so that the shade variation does not repeat every few planks.
 */
export function herringboneTile(plankWidthM: number): ParquetTile {
  const k = PLANK_RATIO;
  const n = 4 * k;
  const w = plankWidthM;
  const planks: Plank[] = [];
  const rect = (x0: number, y0: number, cw: number, ch: number, shade: number) => {
    // Draw copies shifted by whole tiles so planks crossing the edge wrap around.
    for (const dx of [-n, 0, n]) {
      for (const dy of [-n, 0, n]) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x >= n || y >= n || x + cw <= 0 || y + ch <= 0) continue;
        planks.push({ points: [[x * w, y * w], [(x + cw) * w, y * w], [(x + cw) * w, (y + ch) * w], [x * w, (y + ch) * w]], shade });
      }
    }
  };
  for (let y = 0; y < n; y++) {
    // Horizontal planks of row y start at x = y + 2k m.
    for (let m = 0; m < n / (2 * k); m++) {
      const x = mod(y, 2 * k) + 2 * k * m;
      rect(x, y, k, 1, shadeOf(mod(x, n), y, 1));
    }
  }
  for (let x = 0; x < n; x++) {
    // Vertical planks of column x start at y = x - 2k + 1 + 2k m.
    for (let m = 0; m < n / (2 * k); m++) {
      const y = mod(x - 2 * k + 1, 2 * k) + 2 * k * m;
      rect(x, y, 1, k, shadeOf(x, mod(y, n), 2));
    }
  }
  return { widthM: n * w, heightM: n * w, planks };
}

/**
 * Chevron: planks cut at 45 degrees meet along a vertical line, so each row zigzags. A band is `p` high (the plank
 * width over cos 45), a half plank spans `h` horizontally (its length over sqrt 2). The tile holds 4 half planks
 * across and 8 bands.
 */
export function chevronTile(plankWidthM: number): ParquetTile {
  const L = plankWidthM * PLANK_RATIO;
  const h = L / Math.SQRT2;
  const p = plankWidthM * Math.SQRT2;
  const bands = 8;
  const halves = 4;
  const planks: Plank[] = [];
  for (let i = -Math.ceil(h / p) - 1; i <= bands; i++) {
    for (let j = 0; j < halves; j++) {
      const x0 = j * h;
      const base = i * p;
      const rising = j % 2 === 0;
      const points: [number, number][] = rising
        ? [[x0, base], [x0 + h, base + h], [x0 + h, base + h + p], [x0, base + p]]
        : [[x0, base + h], [x0 + h, base], [x0 + h, base + p], [x0, base + h + p]];
      planks.push({ points, shade: shadeOf(mod(i, bands), j, 3) });
    }
  }
  return { widthM: halves * h, heightM: bands * p, planks };
}

export function parquetTile(spec: Pick<ParquetSpec, 'pattern' | 'plankWidthM'>): ParquetTile {
  return spec.pattern === 'chevron' ? chevronTile(spec.plankWidthM) : herringboneTile(spec.plankWidthM);
}

/** Pixels per metre such that the tile fits the canvas limit, and not more than `MAX_PX_PER_M`. */
export function tilePixelsPerMetre(tile: Pick<ParquetTile, 'widthM' | 'heightM'>): number {
  return Math.min(MAX_PX_PER_M, MAX_TILE_PX / Math.max(tile.widthM, tile.heightM));
}

function shaded(hex: string, factor: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

/** Draws a tile into a 2D context of `width` x `height` pixels. */
export function drawParquet(ctx: CanvasRenderingContext2D, tile: ParquetTile, color: string, pxPerM: number): void {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = shaded(color, 0.45); // the joints
  ctx.fillRect(0, 0, width, height);
  ctx.lineJoin = 'miter';
  for (const plank of tile.planks) {
    ctx.beginPath();
    plank.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * pxPerM, y * pxPerM) : ctx.lineTo(x * pxPerM, y * pxPerM)));
    ctx.closePath();
    ctx.fillStyle = shaded(color, plank.shade);
    ctx.fill();
    ctx.lineWidth = Math.max(1, 0.002 * pxPerM);
    ctx.strokeStyle = shaded(color, 0.5);
    ctx.stroke();
  }
}

export interface ParquetTexture {
  texture: CanvasTexture;
  tile: ParquetTile;
}

/**
 * The parquet as a repeating colour map in plan metres (`repeat` = 1 / tile size); the herringbone is turned 45 degrees
 * so its planks run diagonally to the walls. Null where there is no canvas (node without DOM).
 */
export function createParquetTexture(spec: ParquetSpec, anisotropy = 1): ParquetTexture | null {
  if (typeof document === 'undefined') return null;
  const tile = parquetTile(spec);
  const px = tilePixelsPerMetre(tile);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(8, Math.round(tile.widthM * px));
  canvas.height = Math.max(8, Math.round(tile.heightM * px));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  drawParquet(ctx, tile, spec.color, canvas.width / tile.widthM);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  texture.repeat.set(1 / tile.widthM, 1 / tile.heightM);
  if (spec.pattern === 'herringbone') {
    texture.center.set(0, 0);
    texture.rotation = Math.PI / 4;
  }
  texture.needsUpdate = true;
  return { texture, tile };
}
