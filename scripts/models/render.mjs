/* global Buffer */
// Tiny software rasteriser for catalog thumbnails (no GPU, deterministic): orthographic 3/4 view from the
// front-right, Lambert shading, base-colour textures sampled per pixel.
import { getBounds } from '@gltf-transform/functions';
import sharp from 'sharp';

const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

async function decodeTexture(tex) {
  if (!tex) return null;
  const { data, info } = await sharp(Buffer.from(tex.getImage()), { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** Renders the (unquantised) document to a `size` x `size` WebP with transparent background. */
export async function renderThumb(doc, size = 160) {
  const S = size * 2;
  const scene = doc.getRoot().listScenes()[0];
  const bb = getBounds(scene);
  const centre = [0, 1, 2].map((i) => (bb.min[i] + bb.max[i]) / 2);
  const radius = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2 || 1;
  const toCam = norm([0.75, 0.6, 1]);
  const right = norm(cross([0, 1, 0], toCam));
  const up = cross(toCam, right);
  const light = norm([0.35, 0.8, 0.5]);
  const color = new Uint8ClampedArray(S * S * 4);
  const depth = new Float32Array(S * S).fill(-Infinity);
  const scale = (S * 0.46) / radius;
  const proj = (p) => {
    const q = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    return [S / 2 + dot(q, right) * scale, S / 2 - dot(q, up) * scale, dot(q, toCam)];
  };
  for (const node of (() => { const out = []; scene.traverse((n) => { if (n.getMesh()) out.push(n); }); return out; })()) {
    for (const prim of node.getMesh().listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const nrm = prim.getAttribute('NORMAL');
      const uv = prim.getAttribute('TEXCOORD_0');
      const mat = prim.getMaterial();
      const base = mat?.getBaseColorFactor() ?? [0.8, 0.8, 0.8, 1];
      const tex = await decodeTexture(mat?.getBaseColorTexture());
      const idxAcc = prim.getIndices();
      const n = idxAcc ? idxAcc.getCount() : pos.getCount();
      const vi = (i) => (idxAcc ? idxAcc.getScalar(i) : i);
      const P = [], N = [], T = [];
      for (let t = 0; t < n; t += 3) {
        P.length = 0; N.length = 0; T.length = 0;
        for (let k = 0; k < 3; k++) {
          const i = vi(t + k);
          P.push(pos.getElement(i, []));
          N.push(nrm ? nrm.getElement(i, []) : null);
          T.push(uv ? uv.getElement(i, []) : null);
        }
        const s = P.map(proj);
        const fn = norm(cross([P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]]));
        const minX = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0])));
        const maxX = Math.min(S - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
        const minY = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1])));
        const maxY = Math.min(S - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
        const den = (s[1][1] - s[2][1]) * (s[0][0] - s[2][0]) + (s[2][0] - s[1][0]) * (s[0][1] - s[2][1]);
        if (Math.abs(den) < 1e-9) continue;
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5, py = y + 0.5;
            const l0 = ((s[1][1] - s[2][1]) * (px - s[2][0]) + (s[2][0] - s[1][0]) * (py - s[2][1])) / den;
            const l1 = ((s[2][1] - s[0][1]) * (px - s[2][0]) + (s[0][0] - s[2][0]) * (py - s[2][1])) / den;
            const l2 = 1 - l0 - l1;
            if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
            const z = l0 * s[0][2] + l1 * s[1][2] + l2 * s[2][2];
            const o = y * S + x;
            if (z <= depth[o]) continue;
            let nv = fn;
            if (N[0]) nv = norm([0, 1, 2].map((c) => l0 * N[0][c] + l1 * N[1][c] + l2 * N[2][c]));
            if (dot(nv, toCam) < 0) nv = nv.map((c) => -c); // two-sided
            let rgb = [base[0], base[1], base[2]];
            if (tex && T[0]) {
              const u = l0 * T[0][0] + l1 * T[1][0] + l2 * T[2][0];
              const v = l0 * T[0][1] + l1 * T[1][1] + l2 * T[2][1];
              const tx = Math.min(tex.w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * tex.w)));
              const ty = Math.min(tex.h - 1, Math.max(0, Math.floor((v - Math.floor(v)) * tex.h)));
              const q = (ty * tex.w + tx) * 4;
              rgb = [0, 1, 2].map((c) => (tex.data[q + c] / 255) ** 2.2 * rgb[c]);
            }
            const shade = 0.42 + 0.58 * Math.max(0, dot(nv, light));
            depth[o] = z;
            for (let c = 0; c < 3; c++) color[o * 4 + c] = Math.min(255, 255 * (Math.min(1, rgb[c] * shade) ** (1 / 2.2)));
            color[o * 4 + 3] = 255;
          }
        }
      }
    }
  }
  return sharp(Buffer.from(color.buffer), { raw: { width: S, height: S, channels: 4 } })
    .resize(size, size, { kernel: 'lanczos3' })
    .webp({ quality: 82, effort: 6 })
    .toBuffer();
}
