import type { Rgba } from './png';

/** Colour maths of the palette metric (CG5): sRGB to CIE Lab (D65), CIEDE2000, and a deterministic k-means in Lab. */

export type Lab = [number, number, number];

const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const delin = (v: number): number => Math.max(0, Math.min(255, Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))));

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const G = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [delin(R), delin(G), delin(B)];
}

export const hexToRgb = (hex: string): [number, number, number] => {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const rgbToHex = (c: readonly [number, number, number]): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
export const hexToLab = (hex: string): Lab => rgbToLab(...hexToRgb(hex));
export const labToHex = (l: Lab): string => rgbToHex(labToRgb(...l));

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference (Sharma, Wu, Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(p: Lab, q: Lab): number {
  const [L1, a1, b1] = p;
  const [L2, a2, b2] = q;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1p = h(b1, a1p);
  const h2p = h(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm += h1p + h2p < 360 ? 360 : -360;
    hpm /= 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hpm - 30)) + 0.24 * Math.cos(rad(2 * hpm)) + 0.32 * Math.cos(rad(3 * hpm + 6)) - 0.2 * Math.cos(rad(4 * hpm - 63));
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export interface Cluster {
  lab: Lab;
  hex: string;
  /** Share of the sampled pixels, 0 to 1. */
  area: number;
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const d2 = (a: Lab, b: Lab) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * K-means (k-means++ start, fixed seed, at most `iters` rounds) in Lab on a grid sample of the image (about `maxSamples` pixels).
 * Clusters come back by decreasing area. Transparent pixels are skipped. Identical images give identical clusters.
 */
export function kmeansLab(img: Rgba, k = 6, maxSamples = 24_000, iters = 14): Cluster[] {
  const total = img.width * img.height;
  const step = Math.max(1, Math.floor(Math.sqrt(total / maxSamples)));
  const pts: Lab[] = [];
  for (let y = 0; y < img.height; y += step)
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3]! < 128) continue;
      pts.push(rgbToLab(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!));
    }
  if (pts.length === 0) return [];
  const rand = rng(1234567);
  const kk = Math.min(k, pts.length);
  const centres: Lab[] = [pts[Math.floor(rand() * pts.length)]!];
  const dist = new Float64Array(pts.length).fill(Infinity);
  while (centres.length < kk) {
    const last = centres[centres.length - 1]!;
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      dist[i] = Math.min(dist[i]!, d2(pts[i]!, last));
      sum += dist[i]!;
    }
    if (sum === 0) break; // fewer distinct colours than k
    let r = rand() * sum;
    let pick = pts.length - 1;
    for (let i = 0; i < pts.length; i++) {
      r -= dist[i]!;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centres.push([...pts[pick]!] as Lab);
  }
  const assign = new Int32Array(pts.length);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = d2(pts[i]!, centres[c]!);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved = true;
      }
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const s = sums[assign[i]!]!;
      s[0]! += pts[i]![0];
      s[1]! += pts[i]![1];
      s[2]! += pts[i]![2];
      s[3]! += 1;
    }
    sums.forEach((s, c) => {
      if (s[3]! > 0) centres[c] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
    });
    if (!moved) break;
  }
  const counts = new Array<number>(centres.length).fill(0);
  for (let i = 0; i < pts.length; i++) counts[assign[i]!]!++;
  return centres
    .map((lab, c) => ({ lab, hex: labToHex(lab), area: counts[c]! / pts.length }))
    .filter((c) => c.area > 0)
    .sort((a, b) => b.area - a.area);
}
