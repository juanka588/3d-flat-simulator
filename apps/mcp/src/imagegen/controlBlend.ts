import { PNG } from 'pngjs';

/**
 * The single control image for the Qwen ControlNet Union checkpoint (mflux takes ONE control image): normalised inverse depth
 * (near = bright, the way depth ControlNets are trained) at 55 % brightness with the structural edges drawn white over it.
 * The CG depth spike found canny alone lets the model invent the ceiling and the layout, depth alone paints parquet on the
 * ceiling, and this blend keeps both the shapes and the depth order.
 */

const decode = (b64: string, raw = false): PNG => PNG.sync.read(Buffer.from(b64, 'base64'), raw ? { skipRescale: true } : {});

/** Inverse depth in 0..255 from a 16-bit millimetre depth PNG (0 mm = nothing drawn): 2nd to 98th percentile, gamma 0.5. */
export function inverseDepthGray(depthPngB64: string): { width: number; height: number; gray: Uint8Array } {
  const png = decode(depthPngB64, true);
  const n = png.width * png.height;
  const px = png.data as unknown as ArrayLike<number>;
  const disp = new Float32Array(n);
  const valid: number[] = [];
  for (let i = 0; i < n; i++) {
    const mm = px[i * 4]!;
    if (mm > 0) {
      disp[i] = 1000 / mm;
      valid.push(disp[i]!);
    }
  }
  const gray = new Uint8Array(n);
  if (!valid.length) return { width: png.width, height: png.height, gray };
  valid.sort((a, b) => a - b);
  const lo = valid[Math.floor(valid.length * 0.02)]!;
  const hi = valid[Math.min(valid.length - 1, Math.floor(valid.length * 0.98))]!;
  const span = Math.max(hi - lo, 1e-6);
  for (let i = 0; i < n; i++) {
    if (disp[i]! <= 0) continue;
    const t = Math.min(1, Math.max(0, (disp[i]! - lo) / span));
    gray[i] = Math.round(Math.sqrt(t) * 255);
  }
  return { width: png.width, height: png.height, gray };
}

/** Colour of the `wall` class in the ids pass (the legend of `render_passes` is fixed). */
const WALL_RGB = [128, 128, 128] as const;

/** Mean of `gray` over a (2r+1)^2 window, only over the pixels of `mask` (separable box blur with a mask-aware denominator). */
function maskedBlur(gray: Uint8Array, mask: Uint8Array, w: number, h: number, r: number): Float32Array {
  const num = new Float32Array(w * h);
  const den = new Float32Array(w * h);
  const tn = new Float32Array(w * h);
  const td = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      let c = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w || !mask[y * w + xx]) continue;
        n += gray[y * w + xx]!;
        c++;
      }
      tn[y * w + x] = n;
      td[y * w + x] = c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      let c = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        n += tn[yy * w + x]!;
        c += td[yy * w + x]!;
      }
      num[y * w + x] = n;
      den[y * w + x] = c;
    }
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = den[i]! > 0 ? num[i]! / den[i]! : gray[i]!;
  return out;
}

export interface BlendOptions {
  /** The ids pass of the same camera (base64 PNG). With it, the wall pixels are drawn solid (see `passControls`). */
  idsPngB64?: string | undefined;
}

/**
 * Base64 PNG of the blend control: depth at 55 % with the (2 px dilated) edge pixels of `edgesPngB64` white.
 * With `idsPngB64` (a view that must not gain a window) the wall-class pixels are smoothed to a flat tone (no depth structure for a
 * window to grow from) and the outline of every wall region is drawn white 4 px thick, so the walls read as solid, closed planes.
 */
export function blendControl(depthPngB64: string, edgesPngB64: string, opts: BlendOptions = {}): string {
  const d = inverseDepthGray(depthPngB64);
  const e = decode(edgesPngB64);
  if (e.width !== d.width || e.height !== d.height) throw new Error('depth and edge passes differ in size');
  const { width: w, height: h } = d;
  const out = new PNG({ width: w, height: h });
  const edge = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h && e.data[(y * w + x) * 4]! > 0 ? 1 : 0);
  let wall: Uint8Array | undefined;
  let flat: Float32Array | undefined;
  let outline: Uint8Array | undefined;
  if (opts.idsPngB64) {
    const ids = decode(opts.idsPngB64);
    if (ids.width !== w || ids.height !== h) throw new Error('depth and ids passes differ in size');
    wall = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) wall[i] = ids.data[i * 4] === WALL_RGB[0] && ids.data[i * 4 + 1] === WALL_RGB[1] && ids.data[i * 4 + 2] === WALL_RGB[2] ? 1 : 0;
    flat = maskedBlur(d.gray, wall, w, h, 12);
    // outline: wall pixels with a non-wall (or edge of the picture, not counted) 4-neighbour within 2 px
    outline = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const here = wall[y * w + x]!;
        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (wall[yy * w + xx] !== here) {
            outline[y * w + x] = 1;
            break;
          }
        }
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // 2x2 dilation: a pixel is white when it or its left, upper or upper-left neighbour is an edge
      const white = edge(x, y) || edge(x - 1, y) || edge(x, y - 1) || edge(x - 1, y - 1) || Boolean(outline?.[i]);
      const g = wall?.[i] && flat ? flat[i]! : d.gray[i]!;
      const v = white ? 255 : Math.floor(g * 0.55);
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
      out.data[i * 4 + 3] = 255;
    }
  }
  return PNG.sync.write(out).toString('base64');
}
