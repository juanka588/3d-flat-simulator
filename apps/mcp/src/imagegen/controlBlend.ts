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

/** Base64 PNG of the blend control: depth at 55 % with the (2 px dilated) edge pixels of `edgesPngB64` white. */
export function blendControl(depthPngB64: string, edgesPngB64: string): string {
  const d = inverseDepthGray(depthPngB64);
  const e = decode(edgesPngB64);
  if (e.width !== d.width || e.height !== d.height) throw new Error('depth and edge passes differ in size');
  const { width: w, height: h } = d;
  const out = new PNG({ width: w, height: h });
  const edge = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h && e.data[(y * w + x) * 4]! > 0 ? 1 : 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // 2x2 dilation: a pixel is white when it or its left, upper or upper-left neighbour is an edge
      const white = edge(x, y) || edge(x - 1, y) || edge(x, y - 1) || edge(x - 1, y - 1);
      const v = white ? 255 : Math.floor(d.gray[i]! * 0.55);
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
      out.data[i * 4 + 3] = 255;
    }
  }
  return PNG.sync.write(out).toString('base64');
}
