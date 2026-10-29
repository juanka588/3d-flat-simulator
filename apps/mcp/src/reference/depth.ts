import { inflateSync } from 'node:zlib';
import { cameraFromMatrixWorld, pixelToPlan, type PinholeCamera } from '@flat/scene';
import type { DescriptorItem } from './descriptor';

/**
 * Position hints from OUR depth (CG1): the reference image was generated from our room camera, so a pixel of the image is the
 * same pixel of our depth pass. The bottom-centre of an item's `box` is where it touches the floor (or the wall, for hung
 * things); unprojecting it with the depth and the camera gives a plan point. Everything here is pure.
 */

export interface DepthMap {
  width: number;
  height: number;
  /** Raw 16-bit values (0 = nothing drawn). */
  data: Uint16Array;
  /** Metres per unit (`depth.unitM` of the pass, 0.001). */
  unitM: number;
}

/** A 16-bit grayscale PNG (what the depth pass stores): non-interlaced, any filter. Throws on anything else. */
export function decodePng16Gray(png: Uint8Array): { width: number; height: number; data: Uint16Array } {
  const b = Buffer.from(png);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 16 || colorType !== 0 || interlace !== 0) throw new Error(`expected a 16-bit grayscale PNG (got bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 2;
  if (raw.length !== (stride + 1) * height) throw new Error('unexpected PNG data size');
  const out = Buffer.alloc(stride * height);
  const bpp = 2;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : undefined;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const up = prev ? prev[i]! : 0;
      const c = prev && i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      switch (filter) {
        case 1:
          v += a;
          break;
        case 2:
          v += up;
          break;
        case 3:
          v += (a + up) >> 1;
          break;
        case 4: {
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
          break;
        }
        default:
          break;
      }
      cur[i] = v & 0xff;
    }
  }
  const data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = out.readUInt16BE(i * 2);
  return { width, height, data };
}

/** The pinhole camera of a pass payload's `camera` object (`matrixWorld` column-major, `fovDeg`, `width`, `height`). */
export function cameraOfPayload(camera: Record<string, unknown>, size: { width: number; height: number }): PinholeCamera {
  const m = camera['matrixWorld'];
  const fov = camera['fovDeg'];
  if (!Array.isArray(m) || m.length !== 16 || !m.every((x) => typeof x === 'number') || typeof fov !== 'number' || camera['type'] !== 'perspective') throw new Error('the pass camera is not a perspective camera with a matrixWorld');
  return cameraFromMatrixWorld(m as number[], fov, size.width, size.height);
}

/** Median depth in metres around pixel `(x, y)` (a `radius`-pixel square), ignoring "nothing drawn"; `undefined` when the window is empty. */
export function sampleDepthM(depth: DepthMap, x: number, y: number, radius = 3): number | undefined {
  const vals: number[] = [];
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let j = Math.max(0, cy - radius); j <= Math.min(depth.height - 1, cy + radius); j++) {
    for (let i = Math.max(0, cx - radius); i <= Math.min(depth.width - 1, cx + radius); i++) {
      const v = depth.data[j * depth.width + i]!;
      if (v > 0) vals.push(v);
    }
  }
  if (vals.length === 0) return undefined;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)]! * depth.unitM;
}

export interface PlanHint {
  /** Where the item meets the floor (or the wall, for hung things) at the bottom centre of its box: plan [x, y], metres. */
  contact: [number, number];
  /** Estimated centre of the footprint: the contact point pushed back along the view by half the item depth (floor items); the contact point for hung ones. */
  centre: [number, number];
  /** Height of the contact point above the floor in metres (about 0 for floor items; the hang height for wall items). */
  heightM: number;
  /** Depth of the contact point along the optical axis, in metres. */
  depthM: number;
  /** Width of the box at the contact depth, metres (compare with the descriptor's `approxDims.w`). */
  widthM: number;
  /** `ok`, or why the hint is weak. */
  note?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The plan hint of one descriptor item. `imageSize` is the size of the reference image the box is in; the depth map may be a
 * different size (the box is scaled). Returns `undefined` when our depth has nothing at that pixel (outside the room).
 */
export function planHintOf(cam: PinholeCamera, depth: DepthMap, imageSize: { width: number; height: number }, item: Pick<DescriptorItem, 'box' | 'approxDims' | 'placementHint'>): PlanHint | undefined {
  const sx = depth.width / imageSize.width;
  const sy = depth.height / imageSize.height;
  const [x0, y0, x1, y1] = item.box;
  void y0;
  const hung = item.placementHint.relation === 'wall_mounted' || item.placementHint.relation === 'ceiling_hung';
  const bx = ((x0 + x1) / 2) * sx;
  // a few pixels above the lowest edge: the edge pixel often belongs to what is behind or below
  const by = Math.min(depth.height - 1, y1 * sy - 2);
  const d = sampleDepthM(depth, bx, by);
  if (d === undefined) return undefined;
  // pixel coordinates of the camera are those of the depth map
  const at = pixelToPlan(cam, bx, by, d);
  const left = pixelToPlan(cam, x0 * sx, by, d);
  const right = pixelToPlan(cam, x1 * sx, by, d);
  const widthM = Math.hypot(right.world[0] - left.world[0], right.world[1] - left.world[1], right.world[2] - left.world[2]);
  const camPlan: [number, number] = [cam.position[0], cam.position[2]];
  const dir: [number, number] = [at.plan[0] - camPlan[0], at.plan[1] - camPlan[1]];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const push = hung ? 0 : item.approxDims.d / 2;
  const centre: [number, number] = [at.plan[0] + (dir[0] / len) * push, at.plan[1] + (dir[1] / len) * push];
  const notes: string[] = [];
  if (!hung && at.height > 0.3) notes.push(`our depth is ${r2(at.height)} m above the floor there (a wall or furniture behind the item): the contact point is a wall point, treat it as "against that wall"`);
  if (!hung && at.height < -0.05) notes.push('below the floor level');
  return { contact: [r2(at.plan[0]), r2(at.plan[1])], centre: [r2(centre[0]), r2(centre[1])], heightM: r2(at.height), depthM: r2(d), widthM: r2(widthM), ...(notes.length ? { note: notes.join('; ') } : {}) };
}
