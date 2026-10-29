/**
 * Builds a `SiteContext` (neighbouring buildings in a flat's plan coordinates) from public
 * French open data: geocoding (data.geopf.fr) and IGN BD TOPO buildings (WFS). Node >= 22 (built-in fetch).
 * See README.md at the package root; the coordinate conventions are documented in `../geo/enu.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { extractRings, hostBands } from '../context/bdtopo';
import type { ContextBuildingLike } from '../context/bdtopo';
import { validateContext } from '../context/validate';
import { anchorOrigin, fitFlatToFootprint, hostRings, refitContext } from '../fit/fit';
import type { FitResult, FlatLike } from '../fit/fit';
import { DEG, compass, fromEnu, planBasis, round, toEnu, wrap180, wrap360 } from '../geo/enu';
import { cleanRing, dominantBearing, pointInRing, signedArea } from '../geo/polygon';
import type { Pt, Rect } from '../geo/polygon';
import { geocode } from './geocode';
import { getJson as getJsonWith } from './http';
import { fetchBuildings as fetchBuildingsWith } from './wfs';

const HELP = `Usage: pnpm site:context --flat <flat.json> [options]
       (or: tsx packages/site/src/node/cli.ts ...)

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
  --fit                  After building (or with --refit), rigidly fit the flat to the host footprint:
                         minimise the non-balcony envelope outside the footprint while keeping the
                         north (w-north) and west (w-west) façades near the footprint's matching edges.
                         Moves the context footprints by the inverse transform, rewrites the context's
                         origin/northAngle and updates site.latitude/longitude/northAngle of the flat file
  --refit <context.json> Apply --fit to an existing context without any network access (writes it in place,
                         or to --out)
  --max-rotation <deg>   Fit rotation limit (default 3)
  --edge-weight <w>      Soft penalty (m2 per m2) on the north/west façade-to-edge distance (default 0.5)
  --help`;

type Opts = Record<string, string | undefined>;

function parseArgs(argv: string[]): Opts {
  const out: Opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}\n${HELP}`);
    const key = a.slice(2);
    if (key === 'help' || key === 'fit') {
      out[key] = 'true';
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${a}`);
    out[key] = value;
  }
  return out;
}

function num(opts: Opts, key: string, fallback?: number): number {
  if (opts[key] === undefined) return fallback as number;
  const v = Number(opts[key]);
  if (!Number.isFinite(v)) throw new Error(`--${key} must be a number`);
  return v;
}

const getJson = (url: string, label: string) => getJsonWith(url, label, { log: (m) => console.error(m) });
const fetchBuildings = (lat: number, lon: number, radius: number, count?: number) => fetchBuildingsWith(getJson, lat, lon, radius, count);

// ---------------------------------------------------------------- flat

interface FlatFile extends FlatLike {
  site?: { address?: string; floorElevation?: number };
  defaults?: { wallHeight?: number };
  walls?: { id: string; start: Pt; end: Pt; thickness?: number; height?: number }[];
}

interface Geometry {
  flatCut: Rect;
  storeyTop: number;
}

function readFlat(file: string) {
  const flat = JSON.parse(readFileSync(file, 'utf8')) as FlatFile;
  const walls = flat.walls ?? [];
  if (walls.length === 0) throw new Error('Flat has no walls');
  const maxT = Math.max(...walls.map((w) => w.thickness ?? 0.2));
  const all = walls.flatMap((w) => [w.start, w.end]);
  const bounds: Rect = {
    minX: Math.min(...all.map((p) => p[0])) - maxT / 2,
    maxX: Math.max(...all.map((p) => p[0])) + maxT / 2,
    minY: Math.min(...all.map((p) => p[1])) - maxT / 2,
    maxY: Math.max(...all.map((p) => p[1])) + maxT / 2,
  };
  // Interior envelope without balconies: where the flat meets the host façade.
  const rooms = (flat.rooms ?? []).filter((r) => r.type !== 'balcony');
  const pts = rooms.flatMap((r) => r.polygon);
  const envelope: Rect = pts.length
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

// ---------------------------------------------------------------- fit

type ContextFile = { version: 1; source: string; origin: { latitude: number; longitude: number }; northAngle: number; buildings: ContextBuildingLike[] };

/** Rewrites the `site` latitude/longitude/northAngle values of a flat file in place, keeping its formatting. */
function updateFlatSite(file: string, { latitude, longitude, northAngle }: { latitude: number; longitude: number; northAngle: number }) {
  let text = readFileSync(file, 'utf8');
  const start = text.indexOf('"site"');
  if (start < 0) throw new Error('flat has no site block to update');
  const end = text.indexOf('}', start);
  let block = text.slice(start, end);
  for (const [key, value] of Object.entries({ latitude, longitude, northAngle })) {
    const re = new RegExp(`("${key}"\\s*:\\s*)-?[0-9.eE+-]+`);
    if (!re.test(block)) throw new Error(`site.${key} not found in ${file}`);
    block = block.replace(re, `$1${value}`);
  }
  text = text.slice(0, start) + block + text.slice(end);
  writeFileSync(file, text);
}

const fmt = (e: { mid: number; ends: number; angle: number } | null) => (e ? `mid ${e.mid.toFixed(2)} m, worst end ${e.ends.toFixed(2)} m, angle ${e.angle.toFixed(1)} deg` : 'n/a');

/** Fits the flat to the host footprint of `context`; returns the re-expressed context and the fit. */
function fitContext(context: ContextFile, flat: FlatFile, geometry: Geometry, opts: Opts): { context: ContextFile; fit: FitResult } {
  const fit = fitFlatToFootprint(flat, hostRings(context), {
    maxRotationDeg: num(opts, 'max-rotation', 3),
    edgeWeight: num(opts, 'edge-weight', 0.5),
  });
  const out = refitContext(context, fit, { flatCut: geometry.flatCut, storeyTop: geometry.storeyTop });
  const problems = validateContext(out);
  if (problems.length > 0) throw new Error(`Fitted context is invalid, nothing written:\n  ${problems.slice(0, 10).join('\n  ')}`);
  console.log('\nFit to the host footprint (non-balcony envelope, soft north/west edge penalty):');
  console.log(`  move of the flat in the old plan frame: dx ${fit.dx.toFixed(3)} m, dy ${fit.dy.toFixed(3)} m, rotation ${fit.thetaDeg.toFixed(3)} deg clockwise`);
  console.log(`  northAngle ${context.northAngle} -> ${out.northAngle}; origin ${context.origin.latitude}, ${context.origin.longitude} -> ${out.origin.latitude}, ${out.origin.longitude}`);
  for (const k of ['before', 'after'] as const) {
    const r = fit[k];
    console.log(`  ${k}: overhang ${r.area.toFixed(3)} m2, max overhang distance ${r.maxDistance.toFixed(2)} m`);
    console.log(`          north edge ${fmt(r.north)}`);
    console.log(`          west edge  ${fmt(r.west)}`);
  }
  return { context: out, fit };
}

// ---------------------------------------------------------------- main

/** Runs the CLI with `argv` (without the node and script entries). Throws on error; the caller decides the exit code. */
export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (opts.help || !opts.flat) {
    console.log(HELP);
    return;
  }
  const flatFile = resolve(opts.flat);
  const { flat, bounds, envelope, maxT, wallHeight } = readFlat(flatFile);
  const geometry: Geometry = {
    flatCut: {
      minX: bounds.minX - num(opts, 'cut-margin', 0.05),
      maxX: bounds.maxX + num(opts, 'cut-margin', 0.05),
      minY: bounds.minY - num(opts, 'cut-margin', 0.05),
      maxY: bounds.maxY + num(opts, 'cut-margin', 0.05),
    },
    storeyTop: wallHeight + num(opts, 'slab', 0.3),
  };
  if (opts.refit) {
    const file = resolve(opts.refit);
    const { context, fit } = fitContext(JSON.parse(readFileSync(file, 'utf8')), flat, geometry, opts);
    writeFileSync(resolve(opts.out ?? file), `${JSON.stringify(context, null, 2)}\n`);
    updateFlatSite(flatFile, { latitude: context.origin.latitude, longitude: context.origin.longitude, northAngle: context.northAngle });
    console.log(`\nWrote ${resolve(opts.out ?? file)} and updated site of ${flatFile} (overhang ${fit.before.area.toFixed(2)} -> ${fit.after.area.toFixed(2)} m2)`);
    return;
  }
  const site = flat.site ?? {};
  const floorElevation = site.floorElevation ?? 0;
  const radius = num(opts, 'radius', 150);
  const inset = num(opts, 'wall-inset', maxT);
  const cutMargin = num(opts, 'cut-margin', 0.05);
  const slab = num(opts, 'slab', 0.3);
  const defaultHeight = num(opts, 'default-height', 9);
  const perStorey = num(opts, 'storey', 3);
  const anchor = opts.anchor ?? 'nw';
  if (anchor !== 'nw' && anchor !== 'ne' && anchor !== 'sw' && anchor !== 'se') throw new Error('--anchor must be nw, ne, sw or se');
  const out = resolve(opts.out ?? flatFile.replace(/\.flat\.json$/, '.context.json'));

  // 1. Search centre.
  let centre: { lat: number; lon: number; label: string; type?: string };
  if (opts.lat !== undefined && opts.lon !== undefined) {
    centre = { lat: num(opts, 'lat'), lon: num(opts, 'lon'), label: 'command line' };
  } else {
    const query = opts.address ?? site.address;
    if (!query) throw new Error('Give --address, --lat/--lon, or a flat with site.address');
    centre = await geocode(query, getJson);
    console.error(`Geocoded "${query}" -> ${centre.label} (${centre.type}) ${centre.lat}, ${centre.lon}`);
  }

  // 2. Buildings (re-centred on the host once it is known).
  let geojson: unknown;
  if (opts['from-geojson']) {
    geojson = JSON.parse(readFileSync(resolve(opts['from-geojson']), 'utf8'));
  } else {
    geojson = await fetchBuildings(centre.lat, centre.lon, radius);
  }

  let { rings, skipped } = extractRings(geojson);
  if (skipped.length) console.error(`warning: ${skipped.length} feature(s) without usable geometry skipped`);
  if (rings.length === 0) throw new Error('No buildings returned');

  // 3. Host.
  const frameA = { lat0: centre.lat, lon0: centre.lon };
  const enuA = (r: { lonlat: Pt[] }) => r.lonlat.map(([lo, la]) => toEnu(la, lo, frameA.lat0, frameA.lon0));
  let host: typeof rings;
  if (opts['host-id']) {
    host = rings.filter((r) => r.key === opts['host-id'] || r.featureId === opts['host-id']);
  } else if (opts['host-point']) {
    const [la, lo] = opts['host-point'].split(',').map(Number) as [number, number];
    const pt = toEnu(la, lo, frameA.lat0, frameA.lon0);
    host = rings.filter((r) => pointInRing(pt, enuA(r)));
  } else {
    const pt: Pt = [0, 0];
    const inside = rings.filter((r) => pointInRing(pt, enuA(r)));
    host = inside.length ? inside : [...rings].sort((a, b) => nearest(enuA(a)) - nearest(enuA(b))).slice(0, 1);
    console.error('warning: no --host-id/--host-point; using the building at/nearest to the search centre');
  }
  function nearest(ring: Pt[]) {
    return Math.min(...ring.map((p) => Math.hypot(p[0], p[1])));
  }
  if (host.length === 0) throw new Error('Host building not found in the fetched area (check --host-id / --host-point / --radius)');
  const hostRing = enuA(host[0]!);

  // Re-centre the fetch on the host so the radius is measured from the flat's building.
  const hostCentroid = hostRing.reduce((s, p): Pt => [s[0] + p[0] / hostRing.length, s[1] + p[1] / hostRing.length], [0, 0] as Pt);
  if (!opts['from-geojson'] && Math.hypot(...hostCentroid) > 10) {
    const [hLat, hLon] = fromEnu(hostCentroid[0], hostCentroid[1], frameA.lat0, frameA.lon0);
    console.error(`Re-centring the fetch on the host (${hLat.toFixed(6)}, ${hLon.toFixed(6)})`);
    geojson = await fetchBuildings(hLat, hLon, radius);
    ({ rings, skipped } = extractRings(geojson));
    if (skipped.length) console.error(`warning: ${skipped.length} feature(s) without usable geometry skipped`);
    const hostKey = host[0]!.key;
    host = rings.filter((r) => r.key === hostKey);
    if (host.length === 0) throw new Error(`Host building ${hostKey} is missing from the re-centred fetch (try a larger --radius or pass --from-geojson)`);
    centre = { ...centre, lat: hLat, lon: hLon };
  }
  if (opts['save-geojson']) writeFileSync(resolve(opts['save-geojson']), JSON.stringify(geojson));
  const hostKeys = new Set(host.map((h) => h.key));

  // 4. Transform: rotation from the host footprint (or --north-angle) + translation to the anchor.
  const pivot = { lat0: centre.lat, lon0: centre.lon };
  const hostEnu = host[0]!.lonlat.map(([lo, la]) => toEnu(la, lo, pivot.lat0, pivot.lon0));
  const axis = dominantBearing(hostEnu); // [0,90)
  const derivedBx = [axis, axis + 90, axis + 180, axis - 90].reduce((best, b) => (Math.abs(wrap180(b - 90)) < Math.abs(wrap180(best - 90)) ? b : best));
  const derivedNorthAngle = wrap360(90 - derivedBx);
  const northAngle = opts['north-angle'] !== undefined ? wrap360(num(opts, 'north-angle')) : round(derivedNorthAngle, 1);
  const bx = 90 - northAngle;
  const { ex, ey } = planBasis(bx);

  let originLat: number;
  let originLon: number;
  if (opts['origin-lat'] !== undefined || opts['origin-lon'] !== undefined) {
    if (opts['origin-lat'] === undefined || opts['origin-lon'] === undefined) throw new Error('Give both --origin-lat and --origin-lon');
    originLat = num(opts, 'origin-lat');
    originLon = num(opts, 'origin-lon');
  } else {
    // Oriented bounding box of the host in the plan axes (about the pivot).
    const hx = hostEnu.map((p) => p[0] * ex[0] + p[1] * ex[1]);
    const hy = hostEnu.map((p) => p[0] * ey[0] + p[1] * ey[1]);
    const box: Rect = { minX: Math.min(...hx), maxX: Math.max(...hx), minY: Math.min(...hy), maxY: Math.max(...hy) };
    // Plan position of the flat's origin so that its outer envelope corner sits on the box corner.
    const [ox, oy] = anchorOrigin(box, anchor, inset, envelope);
    const oe = ox * ex[0] + oy * ey[0];
    const on = ox * ex[1] + oy * ey[1];
    [originLat, originLon] = fromEnu(oe, on, pivot.lat0, pivot.lon0);
  }

  // 5. Footprints in plan coordinates (frame centred on the flat origin).
  const toPlan = (lon: number, lat: number): Pt => {
    const [e, n] = toEnu(lat, lon, originLat, originLon);
    return [e * ex[0] + n * ex[1], e * ey[0] + n * ey[1]];
  };
  const base = -floorElevation;
  const heightOf = (p: Record<string, unknown>): { value: number; source: 'hauteur' | 'etages' | 'default' } => {
    const h = p.hauteur;
    if (typeof h === 'number' && h > 0) return { value: h, source: 'hauteur' };
    const n = p.nombre_d_etages;
    if (typeof n === 'number' && n > 0) return { value: n * perStorey, source: 'etages' };
    return { value: defaultHeight, source: 'default' };
  };

  const buildings: ContextBuildingLike[] = [];
  const stats = { default: 0, etages: 0, hauteur: 0 };
  const hostInfo: { id: string; height: number; source: string; footprint: Pt[] }[] = [];
  const flatCut: Rect = {
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
    const holes = (r.holes ?? []).map((hr) => cleanRing(hr.map(([lo, la]) => toPlan(lo, la)))).filter((hr) => hr.length >= 3 && Math.abs(signedArea(hr)) >= 0.5);
    if (!isHost) {
      buildings.push({ id, footprint, ...(holes.length ? { holes } : {}), base, height: h.value, host: false });
      continue;
    }
    // Host: split into bands so the flat's own volume is not inside a solid box.
    hostInfo.push({ id, height: h.value, source: h.source, footprint });
    buildings.push(...hostBands({ id, footprint, holes, base, height: h.value, storeyBase, storeyTop, flatCut }));
  }

  const sourceNote =
    `IGN BD TOPO V3 batiment via data.geopf.fr WFS (Licence Ouverte Etalab 2.0); fetched ${new Date().toISOString().slice(0, 10)}; ` +
    `radius ${radius} m around the host building; plan frame = local ENU rotated by northAngle ${northAngle} deg; ` +
    `host split into below (if any)/flat-storey (cut-away)/above bands`;
  const r2 = (p: Pt): Pt => [round(p[0], 2), round(p[1], 2)];
  const context: ContextFile = {
    version: 1,
    source: sourceNote,
    origin: { latitude: round(originLat, 8), longitude: round(originLon, 8) },
    northAngle,
    buildings: buildings.map((b) => ({
      id: b.id,
      footprint: b.footprint.map(r2),
      base: round(b.base, 3),
      height: round(b.height, 3),
      ...(b.holes ? { holes: b.holes.map((hr) => hr.map(r2)) } : {}),
      host: b.host,
    })),
  };
  const problems = validateContext(context);
  if (problems.length > 0) {
    throw new Error(`Generated context is invalid, nothing written:\n  ${problems.slice(0, 10).join('\n  ')}`);
  }
  let finalContext = context;
  if (opts.fit) {
    finalContext = fitContext(context, flat, geometry, opts).context;
    updateFlatSite(flatFile, { latitude: finalContext.origin.latitude, longitude: finalContext.origin.longitude, northAngle: finalContext.northAngle });
    console.log(`Updated site of ${flatFile}`);
  }
  writeFileSync(out, `${JSON.stringify(finalContext, null, 2)}\n`);

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
      const c = b.footprint.reduce((s, p): Pt => [s[0] + p[0] / b.footprint.length, s[1] + p[1] / b.footprint.length], [0, 0] as Pt);
      const flatC = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
      const dx = c[0] - flatC[0]!;
      const dy = c[1] - flatC[1]!;
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

// Run when executed directly (tsx packages/site/src/node/cli.ts), not when imported by tests or `@flat/site/node`.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
