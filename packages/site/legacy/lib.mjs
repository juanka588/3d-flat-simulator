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

// ---------------------------------------------------------------- auto-fit to the host footprint

const segDist = (p, a, b) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** Distance from `p` to the boundary of a ring. */
export function distToRing(p, ring) {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist(p, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

/**
 * Regular grid of sample points (cell centres, `cell` metres apart) covering the flat's exterior
 * envelope without the balcony: every non-balcony room polygon plus every wall slab that is not
 * part of a balcony (a wall whose centre line lies inside a balcony room's bounding box, give or take 5 cm, is a rail/screen).
 * Returns `{points, cell}`; each point stands for `cell`^2 m2.
 */
export function envelopeSamples(flat, cell = 0.05) {
  const rooms = flat.rooms ?? [];
  const balconies = rooms.filter((r) => r.type === 'balcony').map((r) => r.polygon);
  const solid = rooms.filter((r) => r.type !== 'balcony').map((r) => r.polygon);
  const box = (pts) => ({ minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])) });
  const balconyBoxes = balconies.map(box);
  const slabs = [];
  for (const w of flat.walls ?? []) {
    const t = w.thickness ?? 0.2;
    const b = box([w.start, w.end]);
    const inBalcony = balconyBoxes.some((o) => b.minX >= o.minX - 0.05 && b.maxX <= o.maxX + 0.05 && b.minY >= o.minY - 0.05 && b.maxY <= o.maxY + 0.05);
    if (inBalcony) continue;
    const dx = w.end[0] - w.start[0];
    const dy = w.end[1] - w.start[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * (t / 2);
    const ny = (dx / l) * (t / 2);
    slabs.push([[w.start[0] + nx, w.start[1] + ny], [w.end[0] + nx, w.end[1] + ny], [w.end[0] - nx, w.end[1] - ny], [w.start[0] - nx, w.start[1] - ny]]);
  }
  const polys = [...solid, ...slabs];
  // Walls may run on past the flat (a north wall along a balcony's edge): keep the samples within the
  // non-balcony rooms' bounding box grown by the thickest wall, i.e. up to the outer wall faces. Columns
  // (walls shorter than twice their thickness) stand inside the rooms and do not count.
  const isColumn = (w) => Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]) < 2 * (w.thickness ?? 0.2);
  const maxT = Math.max(0, ...(flat.walls ?? []).filter((w) => !isColumn(w)).map((w) => w.thickness ?? 0.2));
  const rb = box(solid.flat());
  const bb = { minX: rb.minX - maxT, maxX: rb.maxX + maxT, minY: rb.minY - maxT, maxY: rb.maxY + maxT };
  const points = [];
  for (let x = bb.minX + cell / 2; x < bb.maxX; x += cell) {
    for (let y = bb.minY + cell / 2; y < bb.maxY; y += cell) {
      if (polys.some((poly) => pointInRing([x, y], poly))) points.push([x, y]);
    }
  }
  return { points, cell };
}

/**
 * Outer face of a wall as a segment: the long side of a horizontal wall that faces plan up
 * (`north`) or of a vertical wall that faces plan left (`west`).
 */
export function outerFace(wall, side) {
  const t = (wall.thickness ?? 0.2) / 2;
  const [x0, y0] = wall.start;
  const [x1, y1] = wall.end;
  return side === 'north' ? [[Math.min(x0, x1), y0 - t], [Math.max(x0, x1), y0 - t]] : [[x0 - t, Math.min(y0, y1)], [x0 - t, Math.max(y0, y1)]];
}

/**
 * The footprint edge that the flat's `north`/`west` façade should sit on: an edge of the
 * rings whose outward normal is within 20 degrees of plan up / plan left, nearest to `near` when
 * given (else the longest). Returns `[a, b]` or null.
 */
export function referenceEdge(rings, side, near = null) {
  let best = null;
  for (const ring of rings) {
    const sign = signedArea(ring) >= 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-6) continue;
      // Outward normal for y-down coordinates: area sign flips with the handedness.
      const n = [((b[1] - a[1]) / l) * sign, (-(b[0] - a[0]) / l) * sign];
      const want = side === 'north' ? [0, -1] : [-1, 0];
      if (n[0] * want[0] + n[1] * want[1] < Math.cos(20 * DEG)) continue;
      // With a reference point, the nearest candidate wins (the edge the façade actually faces);
      // otherwise the longest.
      const score = near ? -segDist(near, a, b) : l;
      if (!best || score > best.score) best = { a, b, score };
    }
  }
  return best ? [best.a, best.b] : null;
}

/** Rigid map of a flat-frame point into the footprint frame: p -> R(theta) p + t (theta clockwise on the y-down plan). */
export const rigid = (theta, tx, ty) => {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return (p) => [p[0] * c - p[1] * s + tx, p[0] * s + p[1] * c + ty];
};

const lineOffset = (p, edge) => {
  // Signed distance of p from the edge's line, positive on the outward (non-building) side is not
  // known here, so the caller squares or abs-es it.
  const [a, b] = edge;
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / l;
};

/** Overhang of the sample points (mapped by `map`) outside every footprint ring. */
export function overhang(samples, rings, map, withDistance = false) {
  let n = 0;
  let maxD = 0;
  const bbs = rings.map((r) => ({ minX: Math.min(...r.map((p) => p[0])), maxX: Math.max(...r.map((p) => p[0])), minY: Math.min(...r.map((p) => p[1])), maxY: Math.max(...r.map((p) => p[1])) }));
  for (const sp of samples.points) {
    const p = map(sp);
    let inside = false;
    for (let i = 0; i < rings.length && !inside; i++) {
      const b = bbs[i];
      if (p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY && pointInRing(p, rings[i])) inside = true;
    }
    if (!inside) {
      n++;
      if (withDistance) maxD = Math.max(maxD, Math.min(...rings.map((r) => distToRing(p, r))));
    }
  }
  return { area: n * samples.cell * samples.cell, maxDistance: maxD };
}

/** Edge distances of a mapped façade from its reference edge: offset of the midpoint and of the worse end, plus angle. */
export function edgeReport(face, edge, map) {
  if (!face || !edge) return null;
  const a = map(face[0]);
  const b = map(face[1]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(edge[1][1] - edge[0][1], edge[1][0] - edge[0][0])) / DEG;
  const wrapped = ((((ang + 90) % 180) + 180) % 180) - 90;
  return { mid: Math.abs(lineOffset(mid, edge)), ends: Math.max(Math.abs(lineOffset(a, edge)), Math.abs(lineOffset(b, edge))), angle: wrapped };
}

function nelderMead(f, x0, step, iters = 160) {
  const n = x0.length;
  let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (j === i ? v + step[i] : v)))].map((x) => ({ x, v: f(x) }));
  for (let it = 0; it < iters; it++) {
    pts.sort((p, q) => p.v - q.v);
    const best = pts[0];
    const worst = pts[n];
    const c = x0.map((_, j) => pts.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n);
    const along = (k) => c.map((v, j) => v + k * (worst.x[j] - v));
    const xr = along(-1);
    const fr = f(xr);
    if (fr < best.v) {
      const xe = along(-2);
      const fe = f(xe);
      pts[n] = fe < fr ? { x: xe, v: fe } : { x: xr, v: fr };
    } else if (fr < pts[n - 1].v) {
      pts[n] = { x: xr, v: fr };
    } else {
      const xc = fr < worst.v ? along(-0.5) : along(0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, worst.v)) pts[n] = { x: xc, v: fc };
      else pts = pts.map((p, i) => (i === 0 ? p : { x: best.x.map((v, j) => v + 0.5 * (p.x[j] - v)), v: f(best.x.map((v, j) => v + 0.5 * (p.x[j] - v))) }));
    }
    if (Math.max(...pts.map((p) => p.v)) - Math.min(...pts.map((p) => p.v)) < 1e-7 && it > 30) break;
  }
  pts.sort((p, q) => p.v - q.v);
  return pts[0];
}

/**
 * Finds the rigid transform of the flat (translation + rotation within +-`maxRotationDeg`) that
 * minimises the flat's non-balcony exterior envelope lying outside the host footprint(s), plus a
 * soft penalty `edgeWeight` * (d_north^2 + d_west^2) on the distance of the north / west façades
 * from the footprint's corresponding outer edges (mean squared distance of the façade ends).
 * Coarse grid over (dx, dy, theta) on a coarse sample, then Nelder-Mead on a fine one from the
 * best candidates. The flat is rotated about the centre of its envelope while searching.
 *
 * `flat`: Scene-like `{rooms, walls}`; `rings`: host footprint rings in the footprint frame, which
 * is the frame the flat currently lives in. Returns `{dx, dy, thetaDeg, tx, ty, before, after}` where
 * the flat point p maps to R(theta) p + (tx, ty) in the footprint frame (theta clockwise, y down), and
 * `before`/`after` report `{area, maxDistance, north, west}`.
 */
export function fitFlatToFootprint(flat, rings, { maxRotationDeg = 3, maxShift = 5, edgeWeight = 0.5, northWall = 'w-north', westWall = 'w-west' } = {}) {
  const fine = envelopeSamples(flat, 0.05);
  const report025 = 0.025;
  const mid = envelopeSamples(flat, 0.1);
  const coarse = envelopeSamples(flat, 0.25);
  const pts = fine.points;
  const centre = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const find = (id) => (flat.walls ?? []).find((w) => w.id === id);
  const nw = find(northWall);
  const ww = find(westWall);
  const faceN = nw ? outerFace(nw, 'north') : null;
  const faceW = ww ? outerFace(ww, 'west') : null;
  const mid2 = (f) => (f ? [(f[0][0] + f[1][0]) / 2, (f[0][1] + f[1][1]) / 2] : null);
  const edgeN = referenceEdge(rings, 'north', mid2(faceN));
  const edgeW = referenceEdge(rings, 'west', mid2(faceW));
  // x = [ux, uy, theta(rad)]: rotation about `centre`, then shift by u.
  const mapOf = (x) => {
    const r = rigid(x[2], 0, 0);
    const rc = r(centre);
    return rigid(x[2], centre[0] - rc[0] + x[0], centre[1] - rc[1] + x[1]);
  };
  const penalty = (map) => {
    let p = 0;
    for (const [face, edge] of [[faceN, edgeN], [faceW, edgeW]]) {
      if (!face || !edge) continue;
      const d = [lineOffset(map(face[0]), edge), lineOffset(map(face[1]), edge)];
      p += (d[0] * d[0] + d[1] * d[1]) / 2;
    }
    return edgeWeight * p;
  };
  const cost = (samples) => (x) => {
    const th = Math.max(-maxRotationDeg, Math.min(maxRotationDeg, x[2] / DEG)) * DEG;
    const clamp = Math.abs(x[2] / DEG) > maxRotationDeg ? 1e3 * (Math.abs(x[2] / DEG) - maxRotationDeg) : 0;
    const map = mapOf([x[0], x[1], th]);
    return overhang(samples, rings, map).area + penalty(map) + clamp + 1e3 * Math.max(0, Math.hypot(x[0], x[1]) - maxShift);
  };
  const cands = [];
  const cc = cost(coarse);
  for (let th = -maxRotationDeg; th <= maxRotationDeg + 1e-9; th += maxRotationDeg / 3) {
    for (let ux = -maxShift; ux <= maxShift; ux += 0.25) for (let uy = -maxShift; uy <= maxShift; uy += 0.25) cands.push({ x: [ux, uy, th * DEG], v: cc([ux, uy, th * DEG]) });
  }
  cands.sort((a, b) => a.v - b.v);
  // Keep the best few that are not neighbours of each other.
  const starts = [];
  for (const c of cands) {
    if (starts.every((s) => Math.hypot(s.x[0] - c.x[0], s.x[1] - c.x[1]) > 0.75 || Math.abs(s.x[2] - c.x[2]) > 1.5 * DEG)) starts.push(c);
    if (starts.length === 3) break;
  }
  let best = null;
  for (const s of starts) {
    const res = nelderMead(cost(mid), s.x, [0.2, 0.2, 0.5 * DEG], 80);
    if (!best || res.v < best.v) best = res;
  }
  best = nelderMead(cost(fine), best.x, [0.05, 0.05, 0.15 * DEG], 60);
  const th0 = Math.max(-maxRotationDeg, Math.min(maxRotationDeg, best.x[2] / DEG)) * DEG;
  const origin0 = mapOf([best.x[0], best.x[1], th0])([0, 0]);
  // Round to 0.01 degree and 1 mm so the stored northAngle / origin are tidy; report with the rounded values.
  const thetaDeg = Math.round((th0 / DEG) * 100) / 100;
  const origin = [Math.round(origin0[0] * 1000) / 1000, Math.round(origin0[1] * 1000) / 1000];
  const map = rigid(thetaDeg * DEG, origin[0], origin[1]);
  const report = (m) => {
    const o = overhang(envelopeSamples(flat, report025), rings, m, true);
    return { area: o.area, maxDistance: o.maxDistance, north: edgeReport(faceN, edgeN, m), west: edgeReport(faceW, edgeW, m) };
  };
  return { dx: origin[0], dy: origin[1], thetaDeg, edgeWeight, before: report((p) => p), after: report(map) };
}

/**
 * Re-expresses a `SiteContext` in the frame of the flat after the rigid move `p -> R(theta) p + (dx, dy)`
 * found by `fitFlatToFootprint` (the flat keeps its own coordinates; the buildings move by the inverse
 * transform): footprints and holes become R(-theta)(q - t), `northAngle` decreases by theta and the
 * origin latitude/longitude moves to the new plan origin. The host's cut-away bands are rebuilt from
 * the full host footprint because the cut rectangle (the flat's bounds) does not move with the buildings.
 */
export function refitContext(context, fit, { flatCut, storeyBase = -0.05, storeyTop }) {
  const th = fit.thetaDeg * DEG;
  const c = Math.cos(th);
  const s = Math.sin(th);
  // R(-theta)(q - t); R(-theta) = [[c, s], [-s, c]] for the clockwise-positive y-down rotation.
  const inv = (q) => {
    const x = q[0] - fit.dx;
    const y = q[1] - fit.dy;
    return [round(x * c + y * s, 2), round(-x * s + y * c, 2)];
  };
  const moveB = (b) => ({ ...b, footprint: b.footprint.map(inv), ...(b.holes ? { holes: b.holes.map((h) => h.map(inv)) } : {}) });
  const hostIds = [...new Set(context.buildings.filter((b) => b.host).map((b) => b.id.replace(/:(below|flat-storey-\d+|above)$/, '')))];
  const buildings = context.buildings.filter((b) => !b.host).map(moveB);
  for (const id of hostIds) {
    const bands = context.buildings.filter((b) => b.host && (b.id === id || b.id.startsWith(`${id}:`)));
    const full = bands.find((b) => b.id.endsWith(':above')) ?? bands.find((b) => b.id.endsWith(':below'));
    if (!full) throw new Error(`Host ${id} has no full-footprint band; cannot rebuild the cut-away`);
    const base = Math.min(...bands.map((b) => b.base));
    const roofTop = Math.max(...bands.map((b) => b.base + b.height));
    const moved = moveB(full);
    buildings.push(
      ...hostBands({ id, footprint: moved.footprint, holes: moved.holes ?? [], base, height: roofTop - base, storeyBase, storeyTop, flatCut }).map((b) => ({
        ...b,
        base: round(b.base, 3),
        height: round(b.height, 3),
      })),
    );
  }
  const bx = 90 - context.northAngle;
  const { ex, ey } = planBasis(bx);
  const [latitude, longitude] = fromEnu(fit.dx * ex[0] + fit.dy * ey[0], fit.dx * ex[1] + fit.dy * ey[1], context.origin.latitude, context.origin.longitude);
  return { ...context, origin: { latitude: round(latitude, 8), longitude: round(longitude, 8) }, northAngle: round(context.northAngle - fit.thetaDeg, 4), buildings };
}

/** Full host footprint rings (one per host building) of a context, in its plan frame. */
export function hostRings(context) {
  const seen = new Map();
  for (const b of context.buildings) {
    if (!b.host || !/:(above|below)$/.test(b.id)) continue;
    seen.set(b.id.replace(/:(above|below)$/, ''), b.footprint);
  }
  return [...seen.values()];
}
