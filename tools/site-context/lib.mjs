/**
 * Pure helpers of the site-context generator (no network, no file system), shared by fetch.mjs
 * and its tests. See fetch.mjs for the coordinate conventions.
 */
import { setTimeout } from 'node:timers';

export const R_EARTH = 6371008.8;
export const DEG = Math.PI / 180;

// ---------------------------------------------------------------- projection

/** WGS84 -> local ENU metres around (lat0, lon0). */
export function toEnu(lat, lon, lat0, lon0) {
  return [(lon - lon0) * Math.cos(lat0 * DEG) * R_EARTH * DEG, (lat - lat0) * R_EARTH * DEG];
}
/** Local ENU metres -> WGS84. */
export function fromEnu(e, n, lat0, lon0) {
  return [lat0 + n / (R_EARTH * DEG), lon0 + e / (Math.cos(lat0 * DEG) * R_EARTH * DEG)];
}

/** Plan frame basis (in E,N) for a plan x axis with compass bearing `bx` degrees. */
export function planBasis(bx) {
  const r = bx * DEG;
  return { ex: [Math.sin(r), Math.cos(r)], ey: [Math.cos(r), -Math.sin(r)] };
}

// ---------------------------------------------------------------- polygon helpers

export function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function cleanRing(ring, eps = 0.01) {
  let pts = ring.map((p) => [p[0], p[1]]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (pts.length > 1 && dist(pts[0], pts.at(-1)) < eps) pts.pop();
  pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) >= eps);
  // Drop collinear vertices.
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cross) < 1e-4 * Math.max(1, dist(a, c))) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/** Keeps the part of `poly` where `inside(p)` (signed distance >= 0). Sutherland-Hodgman. */
function clipHalfPlane(poly, f) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function polygonIntersectsRect(poly, r) {
  let p = poly;
  for (const f of [
    (q) => q[0] - r.minX,
    (q) => r.maxX - q[0],
    (q) => q[1] - r.minY,
    (q) => r.maxY - q[1],
  ]) {
    p = clipHalfPlane(p, f);
    if (p.length < 3) return 0;
  }
  return Math.abs(signedArea(p));
}

/** `poly` minus an axis-aligned rectangle, as up to four disjoint pieces. */
export function subtractRect(poly, r) {
  if (polygonIntersectsRect(poly, r) < 1e-6) return [poly];
  const mid = [(q) => q[0] - r.minX, (q) => r.maxX - q[0]];
  const defs = [
    [(q) => r.minX - q[0]],
    [(q) => q[0] - r.maxX],
    [...mid, (q) => r.minY - q[1]],
    [...mid, (q) => q[1] - r.maxY],
  ];
  const pieces = [];
  for (const fs of defs) {
    let p = poly;
    for (const f of fs) p = clipHalfPlane(p, f);
    p = cleanRing(p, 0.02);
    if (p.length >= 3 && Math.abs(signedArea(p)) > 0.05) pieces.push(p);
  }
  return pieces;
}


export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- orientation

/** Dominant orientation (compass bearing of an edge, mod 90) of a ring in ENU, edge-length weighted. */
export function dominantBearing(ring) {
  const edges = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return { len: Math.hypot(b[0] - a[0], b[1] - a[1]), bearing: Math.atan2(b[0] - a[0], b[1] - a[1]) / DEG };
  });
  // Length-weighted circular mean of bearing mod 90 (4x angle trick), then re-estimated without
  // edges more than 8 degrees away (chamfers, bay windows) so they do not skew the axis.
  const mean = (list) => {
    let c = 0;
    let s = 0;
    for (const e of list) {
      c += e.len * Math.cos(4 * e.bearing * DEG);
      s += e.len * Math.sin(4 * e.bearing * DEG);
    }
    return Math.atan2(s, c) / 4 / DEG;
  };
  let axis = mean(edges);
  const near = edges.filter((e) => Math.abs(wrap180(4 * (e.bearing - axis)) / 4) <= 8);
  if (near.length >= 2) axis = mean(near);
  return ((axis % 90) + 90) % 90;
}

export const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => ((a + 180) % 360 + 360) % 360 - 180;
export const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
export const compass = (bearing) =>
  ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][
    Math.round(wrap360(bearing) / 22.5) % 16
  ];


// ---------------------------------------------------------------- GeoJSON

/**
 * Flattens WFS features into one entry per polygon part: `{key, featureId, part, props, lonlat,
 * holes}` with `lonlat` the outer ring and `holes` the inner rings ([lon, lat] pairs). Features
 * with null or unsupported geometry are skipped (and counted in `skipped.length`).
 */
export function extractRings(geojson) {
  const rings = [];
  const skipped = [];
  for (const f of geojson?.features ?? []) {
    const g = f?.geometry;
    const polys = g?.type === 'MultiPolygon' ? g.coordinates : g?.type === 'Polygon' ? [g.coordinates] : [];
    const valid = polys.filter((poly) => Array.isArray(poly) && Array.isArray(poly[0]) && poly[0].length >= 4);
    if (valid.length === 0) {
      skipped.push(f?.id ?? f?.properties?.cleabs ?? '?');
      continue;
    }
    valid.forEach((poly, k) => {
      rings.push({
        key: f.properties?.cleabs ?? f.id,
        featureId: f.id,
        part: valid.length > 1 ? k : null,
        props: f.properties ?? {},
        lonlat: poly[0].map((c) => [c[0], c[1]]),
        holes: poly.slice(1).map((h) => h.map((c) => [c[0], c[1]])),
      });
    });
  }
  return { rings, skipped };
}

// ---------------------------------------------------------------- plan placement

/**
 * Plan position of the flat's origin (in the host's plan axes) so that the flat's outer envelope
 * corner touches the corner `anchor` of the host's oriented box. `envelope` is the flat's interior
 * envelope in flat coordinates and `inset` the distance from it to the outer wall face.
 */
export function anchorOrigin(box, anchor, inset, envelope) {
  const ox = anchor.endsWith('w') ? box.minX + inset - envelope.minX : box.maxX - inset - envelope.maxX;
  const oy = anchor.startsWith('n') ? box.minY + inset - envelope.minY : box.maxY - inset - envelope.maxY;
  return [ox, oy];
}

// ---------------------------------------------------------------- host bands

/**
 * Splits a host building into context bands: `:below` (only when there is something below the
 * flat's storey, i.e. `storeyBase > base`), `:flat-storey-k` (the footprint minus the cut-away
 * rectangle, from max(base, storeyBase) to `storeyTop`) and `:above` (when the roof is more than
 * 10 cm above `storeyTop`). Inner rings (`holes`) are kept on the full-footprint bands, and on a
 * storey piece when they lie wholly inside it and clear of the cut-away; otherwise they are
 * dropped there (conservatively solid).
 */
export function hostBands({ id, footprint, holes = [], base, height, storeyBase, storeyTop, flatCut }) {
  const out = [];
  const roofTop = base + height;
  const withHoles = (b, hs) => (hs.length ? { ...b, holes: hs } : b);
  if (storeyBase - base > 1e-6) {
    out.push(withHoles({ id: `${id}:below`, footprint, base, height: storeyBase - base, host: true }, holes));
  }
  const bandBase = Math.max(base, storeyBase);
  const cutHit = (h) => polygonIntersectsRect(h, flatCut) > 0 || h.some((p) => p[0] >= flatCut.minX && p[0] <= flatCut.maxX && p[1] >= flatCut.minY && p[1] <= flatCut.maxY);
  subtractRect(footprint, flatCut).forEach((piece, k) => {
    const hs = holes.filter((h) => !cutHit(h) && h.every((p) => pointInRing(p, piece)));
    out.push(withHoles({ id: `${id}:flat-storey-${k}`, footprint: piece, base: bandBase, height: storeyTop - bandBase, host: true }, hs));
  });
  if (roofTop > storeyTop + 0.1) {
    out.push(withHoles({ id: `${id}:above`, footprint, base: storeyTop, height: roofTop - storeyTop, host: true }, holes));
  }
  return out;
}

// ---------------------------------------------------------------- validation

/**
 * Minimal structural check mirroring the `SiteContext` zod schema (packages/scene/src/context/
 * schema.ts); a test cross-checks the two. Returns a list of problems (empty when valid).
 */
export function validateContext(ctx) {
  const errors = [];
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const vec = (p) => Array.isArray(p) && p.length === 2 && p.every(finite);
  const ring = (r) => Array.isArray(r) && r.length >= 3 && r.every(vec);
  if (ctx?.version !== 1) errors.push('version must be 1');
  if (typeof ctx?.source !== 'string') errors.push('source must be a string');
  if (!finite(ctx?.origin?.latitude) || !finite(ctx?.origin?.longitude)) errors.push('origin needs numeric latitude and longitude');
  if (!finite(ctx?.northAngle)) errors.push('northAngle must be a number');
  if (!Array.isArray(ctx?.buildings)) return [...errors, 'buildings must be an array'];
  if (ctx.buildings.length > 2000) errors.push('too many buildings (max 2000)');
  ctx.buildings.forEach((b, i) => {
    const at = `buildings[${i}] (${b?.id})`;
    if (typeof b?.id !== 'string') errors.push(`${at}: id must be a string`);
    if (!ring(b?.footprint)) errors.push(`${at}: footprint needs >= 3 finite points`);
    if (b?.holes !== undefined && !(Array.isArray(b.holes) && b.holes.every(ring))) errors.push(`${at}: holes must be rings of >= 3 finite points`);
    if (!finite(b?.base)) errors.push(`${at}: base must be a number`);
    if (!finite(b?.height) || !(b.height > 0)) errors.push(`${at}: height must be positive`);
    if (typeof b?.host !== 'boolean') errors.push(`${at}: host must be a boolean`);
    const extra = Object.keys(b ?? {}).filter((k) => !['id', 'footprint', 'holes', 'base', 'height', 'host'].includes(k));
    if (extra.length) errors.push(`${at}: unknown keys ${extra.join(', ')}`);
  });
  return errors;
}

// ---------------------------------------------------------------- network

/**
 * GET JSON with retries on network errors, timeouts and 5xx/408/429 responses. Other 4xx
 * responses are permanent (bad request, not found...) and fail immediately.
 */
export async function getJson(url, label, { fetchImpl = globalThis.fetch, attempts = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let retryable = true;
    try {
      const res = await fetchImpl(url, { signal: globalThis.AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok) {
        retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(text);
    } catch (e) {
      lastError = e;
      log(`  ${label}: attempt ${attempt} failed (${e.message})`);
      if (!retryable) break;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw new Error(`${label} failed: ${lastError?.message}`);
}
