#!/usr/bin/env node
/**
 * Builds a `SiteContext` (neighbouring buildings in a flat's plan coordinates) from public
 * French open data: geocoding (data.geopf.fr) and IGN BD TOPO buildings (WFS). No dependencies,
 * Node >= 22 (built-in fetch). See README.md next to this file.
 *
 * Coordinate conventions
 *  - Map frame: local ENU in metres around an origin (lat0, lon0), using an equirectangular
 *    approximation: E = (lon - lon0) * cos(lat0) * R * pi/180, N = (lat - lat0) * R * pi/180
 *    with R = 6371008.8 m. At a few hundred metres the error is well below a centimetre.
 *  - Plan frame (Scene): metres, x right, y DOWN, origin at the flat's plan origin. If the plan
 *    x axis has compass bearing bx (clockwise from north), then
 *      x axis = (E, N) (sin bx, cos bx)        y axis = (E, N) (cos bx, -sin bx)
 *    and `site.northAngle` (clockwise angle from plan up to true north) = 90 - bx.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URLSearchParams } from 'node:url';

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;
const GEOCODE_URL = 'https://data.geopf.fr/geocodage/search';
const WFS_URL = 'https://data.geopf.fr/wfs/ows';

// ---------------------------------------------------------------- CLI

const HELP = `Usage: node tools/site-context/fetch.mjs --flat <flat.json> [options]

  --flat <file>          Flat (Scene) JSON; supplies site.address, floorElevation and wall geometry
  --address <text>       Geocoding query (default: flat site.address)
  --lat <deg> --lon <deg>  Search centre instead of geocoding
  --radius <m>           Radius around the host building (default 150)
  --host-id <id>         BD TOPO cleabs (or feature id) of the building holding the flat
  --host-point <lat,lon> A point inside the host building (alternative to --host-id)
  --anchor <nw|ne|sw|se> Corner of the host's oriented bounding box that the flat's outer corner
                         touches (default nw)
  --north-angle <deg>    Override site.northAngle (default: derived from the host footprint)
  --origin-lat <deg> --origin-lon <deg>
                         Override the WGS84 position of the flat's plan origin
  --wall-inset <m>       Origin-to-outer-face distance of the exterior walls (default: thickest wall)
  --cut-margin <m>       Clearance around the flat in the host cut-away (default 0.05)
  --slab <m>             Slab thickness above the flat's walls (default 0.3)
  --default-height <m>   Height when BD TOPO has neither hauteur nor nombre_d_etages (default 9)
  --storey <m>           Metres per storey when only nombre_d_etages is known (default 3)
  --from-geojson <file>  Read the WFS response from a file instead of the network
  --save-geojson <file>  Save the raw WFS response
  --out <file>           Output (default: next to the flat, <name>.context.json)
  --help`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}\n${HELP}`);
    const key = a.slice(2);
    if (key === 'help') {
      out.help = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${a}`);
    out[key] = value;
  }
  return out;
}

function num(opts, key, fallback) {
  if (opts[key] === undefined) return fallback;
  const v = Number(opts[key]);
  if (!Number.isFinite(v)) throw new Error(`--${key} must be a number`);
  return v;
}

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

function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function cleanRing(ring, eps = 0.01) {
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

// ---------------------------------------------------------------- network

async function getJson(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (e) {
      lastError = e;
      console.error(`  ${label}: attempt ${attempt} failed (${e.message})`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`${label} failed: ${lastError?.message}`);
}

async function geocode(query) {
  const url = `${GEOCODE_URL}?${new URLSearchParams({ q: query, limit: '1' })}`;
  const json = await getJson(url, 'geocode');
  const f = json.features?.[0];
  if (!f) throw new Error(`No geocoding result for "${query}"`);
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, label: f.properties.label, type: f.properties.type, score: f.properties.score };
}

async function fetchBuildings(lat, lon, radius, count = 2000) {
  const dLat = radius / (R_EARTH * DEG);
  const dLon = radius / (Math.cos(lat * DEG) * R_EARTH * DEG);
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(7)).join(',');
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: 'BDTOPO_V3:batiment',
    OUTPUTFORMAT: 'application/json',
    BBOX: `${bbox},urn:ogc:def:crs:EPSG::4326`,
    COUNT: String(count),
  });
  const json = await getJson(`${WFS_URL}?${params}`, 'wfs');
  if ((json.features?.length ?? 0) >= count) console.error(`warning: ${count} features returned, result may be truncated`);
  return json;
}

// ---------------------------------------------------------------- flat

function readFlat(file) {
  const flat = JSON.parse(readFileSync(file, 'utf8'));
  const walls = flat.walls ?? [];
  if (walls.length === 0) throw new Error('Flat has no walls');
  const maxT = Math.max(...walls.map((w) => w.thickness ?? 0.2));
  const all = walls.flatMap((w) => [w.start, w.end]);
  const bounds = {
    minX: Math.min(...all.map((p) => p[0])) - maxT / 2,
    maxX: Math.max(...all.map((p) => p[0])) + maxT / 2,
    minY: Math.min(...all.map((p) => p[1])) - maxT / 2,
    maxY: Math.max(...all.map((p) => p[1])) + maxT / 2,
  };
  // Interior envelope without balconies: where the flat meets the host façade.
  const rooms = (flat.rooms ?? []).filter((r) => r.type !== 'balcony');
  const pts = rooms.flatMap((r) => r.polygon);
  const envelope = pts.length
    ? {
        minX: Math.min(...pts.map((p) => p[0])),
        maxX: Math.max(...pts.map((p) => p[0])),
        minY: Math.min(...pts.map((p) => p[1])),
        maxY: Math.max(...pts.map((p) => p[1])),
      }
    : bounds;
  const wallHeight = Math.max(...walls.map((w) => w.height ?? flat.defaults?.wallHeight ?? 2.5));
  return { flat, bounds, envelope, maxT, wallHeight };
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

const wrap360 = (a) => ((a % 360) + 360) % 360;
const wrap180 = (a) => ((a + 180) % 360 + 360) % 360 - 180;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const compass = (bearing) =>
  ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][
    Math.round(wrap360(bearing) / 22.5) % 16
  ];

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.flat) {
    console.log(HELP);
    return;
  }
  const flatFile = resolve(opts.flat);
  const { flat, bounds, envelope, maxT, wallHeight } = readFlat(flatFile);
  const site = flat.site ?? {};
  const floorElevation = site.floorElevation ?? 0;
  const radius = num(opts, 'radius', 150);
  const inset = num(opts, 'wall-inset', maxT);
  const cutMargin = num(opts, 'cut-margin', 0.05);
  const slab = num(opts, 'slab', 0.3);
  const defaultHeight = num(opts, 'default-height', 9);
  const perStorey = num(opts, 'storey', 3);
  const anchor = opts.anchor ?? 'nw';
  if (!['nw', 'ne', 'sw', 'se'].includes(anchor)) throw new Error('--anchor must be nw, ne, sw or se');
  const out = resolve(opts.out ?? flatFile.replace(/\.flat\.json$/, '.context.json'));

  // 1. Search centre.
  let centre;
  if (opts.lat !== undefined && opts.lon !== undefined) {
    centre = { lat: num(opts, 'lat'), lon: num(opts, 'lon'), label: 'command line' };
  } else {
    const query = opts.address ?? site.address;
    if (!query) throw new Error('Give --address, --lat/--lon, or a flat with site.address');
    centre = await geocode(query);
    console.error(`Geocoded "${query}" -> ${centre.label} (${centre.type}) ${centre.lat}, ${centre.lon}`);
  }

  // 2. Buildings (re-centred on the host once it is known).
  let geojson;
  if (opts['from-geojson']) {
    geojson = JSON.parse(readFileSync(resolve(opts['from-geojson']), 'utf8'));
  } else {
    geojson = await fetchBuildings(centre.lat, centre.lon, radius);
  }

  const rings = []; // {id, props, ring: [[lon,lat]...]}
  for (const f of geojson.features ?? []) {
    const polys = f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : [];
    polys.forEach((poly, k) => {
      rings.push({
        key: f.properties?.cleabs ?? f.id,
        featureId: f.id,
        part: polys.length > 1 ? k : null,
        props: f.properties ?? {},
        lonlat: poly[0].map((c) => [c[0], c[1]]),
      });
    });
  }
  if (rings.length === 0) throw new Error('No buildings returned');

  // 3. Host.
  const frameA = { lat0: centre.lat, lon0: centre.lon };
  const enuA = (r) => r.lonlat.map(([lo, la]) => toEnu(la, lo, frameA.lat0, frameA.lon0));
  const pointInRing = (pt, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  let host;
  if (opts['host-id']) {
    host = rings.filter((r) => r.key === opts['host-id'] || r.featureId === opts['host-id']);
  } else if (opts['host-point']) {
    const [la, lo] = opts['host-point'].split(',').map(Number);
    const pt = toEnu(la, lo, frameA.lat0, frameA.lon0);
    host = rings.filter((r) => pointInRing(pt, enuA(r)));
  } else {
    const pt = [0, 0];
    const inside = rings.filter((r) => pointInRing(pt, enuA(r)));
    host = inside.length ? inside : [...rings].sort((a, b) => nearest(enuA(a)) - nearest(enuA(b))).slice(0, 1);
    console.error('warning: no --host-id/--host-point; using the building at/nearest to the search centre');
  }
  function nearest(ring) {
    return Math.min(...ring.map((p) => Math.hypot(p[0], p[1])));
  }
  if (host.length === 0) throw new Error('Host building not found in the fetched area (check --host-id / --host-point / --radius)');
  const hostRing = enuA(host[0]);

  // Re-centre the fetch on the host so the radius is measured from the flat's building.
  const hostCentroid = hostRing.reduce((s, p) => [s[0] + p[0] / hostRing.length, s[1] + p[1] / hostRing.length], [0, 0]);
  if (!opts['from-geojson'] && Math.hypot(...hostCentroid) > 10) {
    const [hLat, hLon] = fromEnu(hostCentroid[0], hostCentroid[1], frameA.lat0, frameA.lon0);
    console.error(`Re-centring the fetch on the host (${hLat.toFixed(6)}, ${hLon.toFixed(6)})`);
    geojson = await fetchBuildings(hLat, hLon, radius);
    rings.length = 0;
    for (const f of geojson.features ?? []) {
      const polys = f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
      polys.forEach((poly, k) =>
        rings.push({ key: f.properties?.cleabs ?? f.id, featureId: f.id, part: polys.length > 1 ? k : null, props: f.properties ?? {}, lonlat: poly[0].map((c) => [c[0], c[1]]) }),
      );
    }
    host = rings.filter((r) => r.key === host[0].key);
    centre = { ...centre, lat: hLat, lon: hLon };
  }
  if (opts['save-geojson']) writeFileSync(resolve(opts['save-geojson']), JSON.stringify(geojson));
  const hostKeys = new Set(host.map((h) => h.key));

  // 4. Transform: rotation from the host footprint (or --north-angle) + translation to the anchor.
  const pivot = { lat0: centre.lat, lon0: centre.lon };
  const hostEnu = host[0].lonlat.map(([lo, la]) => toEnu(la, lo, pivot.lat0, pivot.lon0));
  const axis = dominantBearing(hostEnu); // [0,90)
  const derivedBx = [axis, axis + 90, axis + 180, axis - 90].reduce((best, b) => (Math.abs(wrap180(b - 90)) < Math.abs(wrap180(best - 90)) ? b : best));
  const derivedNorthAngle = wrap360(90 - derivedBx);
  const northAngle = opts['north-angle'] !== undefined ? wrap360(num(opts, 'north-angle')) : round(derivedNorthAngle, 1);
  const bx = 90 - northAngle;
  const { ex, ey } = planBasis(bx);

  let originLat;
  let originLon;
  if (opts['origin-lat'] !== undefined || opts['origin-lon'] !== undefined) {
    if (opts['origin-lat'] === undefined || opts['origin-lon'] === undefined) throw new Error('Give both --origin-lat and --origin-lon');
    originLat = num(opts, 'origin-lat');
    originLon = num(opts, 'origin-lon');
  } else {
    // Oriented bounding box of the host in the plan axes (about the pivot).
    const hx = hostEnu.map((p) => p[0] * ex[0] + p[1] * ex[1]);
    const hy = hostEnu.map((p) => p[0] * ey[0] + p[1] * ey[1]);
    const box = { minX: Math.min(...hx), maxX: Math.max(...hx), minY: Math.min(...hy), maxY: Math.max(...hy) };
    // Plan position of the flat's origin so that its outer envelope corner sits on the box corner.
    const ox = anchor.endsWith('w') ? box.minX + inset : box.maxX - inset - (envelope.maxX - envelope.minX) - (envelope.minX - 0);
    const oy = anchor.startsWith('n') ? box.minY + inset : box.maxY - inset - (envelope.maxY - envelope.minY) - (envelope.minY - 0);
    const oe = ox * ex[0] + oy * ey[0];
    const on = ox * ex[1] + oy * ey[1];
    [originLat, originLon] = fromEnu(oe, on, pivot.lat0, pivot.lon0);
  }

  // 5. Footprints in plan coordinates (frame centred on the flat origin).
  const toPlan = (lon, lat) => {
    const [e, n] = toEnu(lat, lon, originLat, originLon);
    return [e * ex[0] + n * ex[1], e * ey[0] + n * ey[1]];
  };
  const base = -floorElevation;
  const heightOf = (p) => {
    const h = p.hauteur;
    if (typeof h === 'number' && h > 0) return { value: h, source: 'hauteur' };
    const n = p.nombre_d_etages;
    if (typeof n === 'number' && n > 0) return { value: n * perStorey, source: 'etages' };
    return { value: defaultHeight, source: 'default' };
  };

  const buildings = [];
  const stats = { default: 0, etages: 0, hauteur: 0 };
  const hostInfo = [];
  const flatCut = {
    minX: bounds.minX - cutMargin,
    maxX: bounds.maxX + cutMargin,
    minY: bounds.minY - cutMargin,
    maxY: bounds.maxY + cutMargin,
  };
  const storeyBase = -0.05; // just below the flat's floor so the cut-away has no coplanar floor
  const storeyTop = wallHeight + slab;

  for (const r of rings) {
    const footprint = cleanRing(r.lonlat.map(([lo, la]) => toPlan(lo, la)));
    if (footprint.length < 3 || Math.abs(signedArea(footprint)) < 1) continue;
    // Radius filter (from the host centroid, which is the search centre).
    const d = Math.min(...footprint.map((p) => Math.hypot(...p)));
    const isHost = hostKeys.has(r.key);
    const id = r.part === null ? r.key : `${r.key}#${r.part}`;
    const h = heightOf(r.props);
    if (!isHost && d > radius + 60) continue;
    stats[h.source]++;
    if (!isHost) {
      buildings.push({ id, footprint, base, height: h.value, host: false });
      continue;
    }
    // Host: split into bands so the flat's own volume is not inside a solid box.
    const roofTop = base + h.value;
    hostInfo.push({ id, height: h.value, source: h.source, footprint });
    buildings.push({ id: `${id}:below`, footprint, base, height: storeyBase - base, host: true });
    const pieces = subtractRect(footprint, flatCut);
    pieces.forEach((piece, k) => buildings.push({ id: `${id}:flat-storey-${k}`, footprint: piece, base: storeyBase, height: storeyTop - storeyBase, host: true }));
    if (roofTop > storeyTop + 0.1) buildings.push({ id: `${id}:above`, footprint, base: storeyTop, height: roofTop - storeyTop, host: true });
  }

  const sourceNote =
    `IGN BD TOPO V3 batiment via data.geopf.fr WFS (Licence Ouverte Etalab 2.0); fetched ${new Date().toISOString().slice(0, 10)}; ` +
    `radius ${radius} m around the host building; plan frame = local ENU rotated by northAngle ${northAngle} deg; ` +
    `host split into below/flat-storey (cut-away)/above bands`;
  const context = {
    version: 1,
    source: sourceNote,
    origin: { latitude: round(originLat, 8), longitude: round(originLon, 8) },
    northAngle,
    buildings: buildings.map((b) => ({
      id: b.id,
      footprint: b.footprint.map((p) => [round(p[0], 2), round(p[1], 2)]),
      base: round(b.base, 3),
      height: round(b.height, 3),
      host: b.host,
    })),
  };
  writeFileSync(out, `${JSON.stringify(context, null, 2)}\n`);

  // 6. Report.
  const neighbours = buildings.filter((b) => !b.host);
  console.log(`\nWrote ${out}`);
  for (const h of hostInfo) {
    const xs = h.footprint.map((p) => p[0]);
    const ys = h.footprint.map((p) => p[1]);
    console.log(
      `Host ${h.id}: height ${h.height} m (${h.source}), footprint ${round(Math.abs(signedArea(h.footprint)), 0)} m2, plan bbox ${round(Math.max(...xs) - Math.min(...xs), 1)} x ${round(Math.max(...ys) - Math.min(...ys), 1)} m`,
    );
  }
  console.log(`Buildings: ${neighbours.length} neighbours + ${buildings.length - neighbours.length} host band(s); heights from BD TOPO: ${stats.hauteur}, from storeys: ${stats.etages}, defaulted: ${stats.default}`);
  const tall = neighbours
    .filter((b) => b.height >= 15)
    .map((b) => {
      const c = b.footprint.reduce((s, p) => [s[0] + p[0] / b.footprint.length, s[1] + p[1] / b.footprint.length], [0, 0]);
      const flatC = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
      const dx = c[0] - flatC[0];
      const dy = c[1] - flatC[1];
      const e = dx * ex[0] + dy * ey[0];
      const n = dx * ex[1] + dy * ey[1];
      const bearing = wrap360(Math.atan2(e, n) / DEG);
      return { id: b.id, h: b.height, dist: Math.hypot(dx, dy), bearing };
    })
    .sort((a, b) => a.dist - b.dist);
  console.log('Tall neighbours (>= 15 m), nearest first, compass direction from the flat:');
  for (const t of tall.slice(0, 15)) console.log(`  ${t.id}  ${t.h} m  ${Math.round(t.dist)} m  ${compass(t.bearing)} (${Math.round(t.bearing)} deg)`);
  console.log(`\nDerived northAngle from the host footprint: ${round(derivedNorthAngle, 2)} deg (using ${northAngle})`);
  console.log('Suggested site block values for the flat:');
  console.log(JSON.stringify({ latitude: round(originLat, 6), longitude: round(originLon, 6), northAngle }, null, 2));
  if (!existsSync(out)) throw new Error('write failed');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
