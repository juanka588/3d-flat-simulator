import { distanceToSegment, doorSwingPolygon, footprintOf, itemDims, openingFrame, pointInPolygon, polygonArea, rotationFacing, type Item, type Opening, type Room, type RoomView, type Scene, type Vec2, type WalkPose } from '@flat/scene';
import { walkPoseInRoom } from '@flat/scene';

/**
 * Views and layout intent of a room (close-the-gap with several cameras).
 *
 * One camera per room biases the result: the reference generator follows our depth and edges, so it puts the sofa wherever the
 * camera looks, and a sofa the camera is not looking at is never scored. So each room (and each FLOOR ZONE of a room: the open
 * kitchen of a living room) gets a few named views, derived from the geometry (openings, zones, locked fittings), with
 * deterministic cameras, and a LAYOUT INTENT: where the main pieces go, decided from the room before any image exists. The cameras
 * and the image prompt only show that layout; they never decide it.
 *
 * Everything here is pure: the same scene gives the same views. A `Room.views` hint (scene or fixture) replaces a derived view
 * with the same id or adds one.
 */

const DEG = Math.PI / 180;
const EYE = 1.55;
const KITCHEN_ZONE = /cuisine|kitchen|cook/i;
const KITCHEN_ASSET = /cooktop|hob|fridge|refrigerator|sink|kitchen|oven|dishwasher|hood|washbasin/i;
const TALL_M = 1.1;

export type ZoneKind = 'main' | 'kitchen';

export interface ZoneInfo {
  id: string;
  name: string;
  kind: ZoneKind;
  polygon: Vec2[];
  /** Where the zone is (the main zone: the middle of the room outside the other zones). */
  centre: Vec2;
  areaM2: number;
  /** Locked or kitchen-looking items inside (kitchen zone). */
  fittings: string[];
}

export interface ViewSpec {
  /** Unique in the room: `media`, `windows`, `wide`, `kitchen`, `kitchen-side`, `focus`, `reverse`, ... */
  id: string;
  zone: string;
  label: string;
  /** What the camera looks at, in words and ids. */
  faces: string;
  /** Share of the room's score; the weights of the selected views are renormalised. */
  weight: number;
  /** The first view of a zone is its hero: more candidates are generated for it. */
  hero: boolean;
  pose: WalkPose;
  /** Zones whose centre is in the picture. */
  sees: string[];
  /** One sentence for the image prompt about what is in the picture (never coordinates). */
  promptHint: string;
  /** Does the camera see the room's main fittings, clear of walls and of the open door leaf? Set for bathrooms and WCs. */
  checks?: ViewChecks;
}

export interface LayoutIntent {
  zone: string;
  /** For the model: decisions with ids and numbers. */
  text: string;
  /** For the image prompt: plain words, no ids. */
  promptText: string;
  /** Pieces to place with the solver relations that fit them (`at`, `against_wall`, `next_to`, `facing`). */
  place: { role: string; category: string; relation: Record<string, unknown>; note?: string }[];
  /** Paths that stay free: from opening to opening. */
  circulation: { from: string; to: string; widthM: number }[];
  /** Categories whose position the layout fixes: the image may show them elsewhere. */
  fixes: string[];
}

// -- small geometry --------------------------------------------------------------------------------------------------------

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
const rot = (a: Vec2, deg: number): Vec2 => {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const pt = (p: Vec2): Vec2 => [r2(p[0]), r2(p[1])];
const norm360 = (d: number) => ((d % 360) + 360) % 360;
/** Plan heading (degrees clockwise from plan-up) of the direction `d`. */
const headingOf = (d: Vec2) => norm360((Math.atan2(d[0], -d[1]) * 180) / Math.PI);
const dirOfHeading = (h: number): Vec2 => [Math.sin(h * DEG), -Math.cos(h * DEG)];

function distToPolygonEdges(p: Vec2, poly: readonly Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distanceToSegment(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return d;
}

/** Centroid of the room's floor outside `exclude` polygons, by sampling (the polygon centroid is wrong for an L with a kitchen). */
function sampledCentre(poly: Vec2[], exclude: Vec2[][]): Vec2 {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let x = Math.min(...xs) + 0.05; x < Math.max(...xs); x += 0.1) {
    for (let y = Math.min(...ys) + 0.05; y < Math.max(...ys); y += 0.1) {
      const p: Vec2 = [x, y];
      if (!pointInPolygon(p, poly, 0) || exclude.some((e) => pointInPolygon(p, e, 0))) continue;
      sx += x;
      sy += y;
      n++;
    }
  }
  return n ? [sx / n, sy / n] : [poly[0]![0], poly[0]![1]];
}

const roomOf = (scene: Scene, roomId: string): Room => {
  const r = scene.rooms.find((x) => x.id === roomId);
  if (!r) throw new Error(`unknown room "${roomId}"`);
  return r;
};

// -- zones -----------------------------------------------------------------------------------------------------------------

const MAIN_ID: Record<string, string> = { living: 'living', dining: 'dining' };

function fittingsIn(scene: Scene, room: Room, polygon: Vec2[]): Item[] {
  return scene.items.filter((i) => (i.roomId === undefined || i.roomId === room.id) && (Boolean(i.locked) || KITCHEN_ASSET.test(i.assetId)) && KITCHEN_ASSET.test(`${i.id} ${i.assetId}`) && (pointInPolygon(i.position, polygon, 0.45) || distToPolygonEdges(i.position, polygon) < 0.45));
}

/** The zones of a room: its floor zones named like a kitchen, and the main zone (the rest). A kitchen room is one kitchen zone. */
export function roomZones(scene: Scene, roomId: string): ZoneInfo[] {
  const room = roomOf(scene, roomId);
  const zones: ZoneInfo[] = [];
  const kitchens = (room.floorZones ?? []).filter((z) => KITCHEN_ZONE.test(`${z.id} ${z.name}`));
  if (room.type === 'kitchen' && !kitchens.length) {
    const fit = fittingsIn(scene, room, room.polygon);
    return [{ id: 'kitchen', name: room.name, kind: 'kitchen', polygon: room.polygon, centre: sampledCentre(room.polygon, []), areaM2: r2(polygonArea(room.polygon)), fittings: fit.map((i) => i.id) }];
  }
  for (const k of kitchens) {
    const fit = fittingsIn(scene, room, k.polygon);
    zones.push({ id: 'kitchen', name: k.name ?? k.id, kind: 'kitchen', polygon: k.polygon, centre: sampledCentre(k.polygon, []), areaM2: r2(polygonArea(k.polygon)), fittings: fit.map((i) => i.id) });
  }
  const main = zones.length ? polygonArea(room.polygon) - zones.reduce((a, z) => a + z.areaM2, 0) : polygonArea(room.polygon);
  zones.unshift({ id: MAIN_ID[room.type] ?? 'main', name: room.name, kind: 'main', polygon: room.polygon, centre: sampledCentre(room.polygon, zones.map((z) => z.polygon)), areaM2: r2(main), fittings: [] });
  return zones;
}

/** Resolves a user's zone word (`living`, `kitchen`, `main`) to a zone id of the room. */
export function findZone(zones: ZoneInfo[], word: string | undefined): ZoneInfo | undefined {
  if (!word) return undefined;
  const w = word.toLowerCase();
  return zones.find((z) => z.id === w) ?? (w === 'main' || w === 'room' ? zones.find((z) => z.kind === 'main') : undefined) ?? (/^(cuisine|kitchen)$/.test(w) ? zones.find((z) => z.kind === 'kitchen') : undefined);
}

// -- the room read as edges, openings and focal pieces ---------------------------------------------------------------------

interface Edge {
  index: number;
  a: Vec2;
  b: Vec2;
  length: number;
  /** Unit normal pointing into the room. */
  inward: Vec2;
  wallId?: string;
  openings: OpeningInfo[];
}

interface OpeningInfo {
  id: string;
  type: Opening['type'];
  centre: Vec2;
  width: number;
  /** Lets light in or leads outside: window, glazed door, balcony door. */
  light: boolean;
  /** Leads to another room of the flat (not a balcony). */
  entry: boolean;
  /** Type of the room on the other side, when there is one. */
  otherType?: string;
  inward: Vec2;
}

function roomEdges(scene: Scene, room: Room): Edge[] {
  const poly = room.polygon;
  const edges: Edge[] = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    const d = unit(sub(b, a));
    const mid = mul(add(a, b), 0.5);
    let n: Vec2 = [-d[1], d[0]];
    if (!pointInPolygon(add(mid, mul(n, 0.08)), poly, 0)) n = [-n[0], -n[1]];
    const wall = scene.walls.map((w) => ({ w, d: distanceToSegment(mid, w.start, w.end) })).filter((x) => x.d <= x.w.thickness / 2 + 0.06).sort((p, q) => p.d - q.d)[0]?.w;
    return { index: i, a, b, length: len(sub(b, a)), inward: n, ...(wall ? { wallId: wall.id } : {}), openings: [] };
  });
  for (const o of scene.openings) {
    const f = openingFrame(scene, o);
    if (!f) continue;
    const edge = edges.filter((e) => e.wallId === o.wallId).find((e) => distanceToSegment(f.centre, e.a, e.b) <= f.wall.thickness / 2 + 0.06);
    if (!edge) continue;
    const other = f.leftRoom?.id === room.id ? f.rightRoom : f.leftRoom;
    const glazed = o.glazed ?? o.type === 'window';
    const toBalcony = other?.type === 'balcony';
    const outside = !other && o.type !== 'passage';
    edge.openings.push({ id: o.id, type: o.type, centre: f.centre, width: o.width, light: glazed || toBalcony || (outside && o.type === 'window'), entry: o.type !== 'window' && Boolean(other) && !toBalcony, ...(other ? { otherType: other.type } : {}), inward: edge.inward });
  }
  return edges;
}

const FOCAL_BY_ROOM: Record<string, RegExp> = {
  living: /(^|[-_:])tv|television|fireplace|cheminee|media/i,
  dining: /table/i,
  bedroom: /(^|[-_:])bed\b|lit\b/i,
  bathroom: /bath|shower|douche|vanity|basin|washbasin/i,
  office: /desk|bureau/i,
};

function focalItem(scene: Scene, room: Room): Item | undefined {
  const re = FOCAL_BY_ROOM[room.type];
  if (!re) return undefined;
  const mine = scene.items.filter((i) => (i.roomId === undefined || i.roomId === room.id) && pointInPolygon(i.position, room.polygon, 0.3));
  return mine.find((i) => re.test(`${i.id} ${i.assetId}`) && (Boolean(i.locked) || room.type === 'living' || room.type === 'bathroom'));
}

/** Items that block sight or standing: tall or knee-high furniture away from the aim. */
function bodies(scene: Scene, room: Room, ignore: ReadonlySet<string>): Vec2[][] {
  return scene.items
    .filter((i) => (i.roomId === undefined || i.roomId === room.id) && !ignore.has(i.id) && (i.elevation ?? 0) < 1.0 && (i.elevation ?? 0) + itemDims(i).h > 0.3)
    .map((i) => footprintOf(i.position, i.rotation, { w: itemDims(i).w + 0.4, d: itemDims(i).d + 0.4 }));
}

const inConvex = (p: Vec2, poly: Vec2[]): boolean => {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
};

// -- the eye ---------------------------------------------------------------------------------------------------------------

interface StandOpts {
  /** Unit vector from the aim point towards where the camera should be. */
  from: Vec2;
  /** Wanted distance from the aim to the eye (m); nearer spots are accepted. */
  standoff: number;
  /** Widest angle away from `from` that is accepted (degrees). */
  spread?: number;
  /** Nearest the eye may be to the aim (m); default 1.4, 0.9 in small rooms. */
  minD?: number;
  /** Items the eye may see through or stand near (the thing being looked at). */
  ignore?: ReadonlySet<string>;
}

/**
 * The eye position for looking at `aim`: on a ring around it, near `from`, as far as `standoff` allows, inside the room with the
 * body radius to spare, not inside furniture, with a clear line to the aim. Deterministic (fixed grid, ties by angle).
 */
export function standPose(scene: Scene, roomId: string, aim: Vec2, o: StandOpts & { fovDeg: number }): WalkPose | undefined {
  const room = roomOf(scene, roomId);
  const blocked = bodies(scene, room, o.ignore ?? new Set());
  const tall = scene.items.filter((i) => (i.roomId === undefined || i.roomId === room.id) && !(o.ignore ?? new Set()).has(i.id) && (i.elevation ?? 0) < EYE && (i.elevation ?? 0) + itemDims(i).h >= TALL_M).map((i) => footprintOf(i.position, i.rotation, itemDims(i)));
  const spread = o.spread ?? 60;
  let best: { p: Vec2; score: number } | undefined;
  const minD = o.minD ?? (polygonArea(room.polygon) < 8 ? 0.9 : 1.4);
  for (let d = o.standoff; d >= minD - 1e-9; d -= 0.2) {
    for (let a = -spread; a <= spread; a += 5) {
      const p = add(aim, mul(rot(o.from, a), d));
      if (!pointInPolygon(p, room.polygon, 0) || distToPolygonEdges(p, room.polygon) < 0.4) continue;
      if (blocked.some((b) => inConvex(p, b))) continue;
      let clear = true;
      const n = Math.ceil(d / 0.1);
      for (let k = 1; k < n && clear; k++) {
        const s = add(p, mul(sub(aim, p), k / n));
        const nearAim = len(sub(s, aim)) < 0.45;
        if (!nearAim && !pointInPolygon(s, room.polygon, 0.05)) clear = false;
        else if (!nearAim && tall.some((t) => inConvex(s, t))) clear = false;
      }
      if (!clear) continue;
      const score = d - 0.03 * Math.abs(a);
      if (!best || score > best.score + 1e-9) best = { p, score };
    }
  }
  if (!best) return undefined;
  return { mode: 'walk', position: pt(best.p), eyeHeight: EYE, headingDeg: r1(headingOf(sub(aim, best.p))), pitchDeg: 0, fovDeg: o.fovDeg };
}

function seesZone(pose: WalkPose, zones: ZoneInfo[]): string[] {
  return zones
    .filter((z) => {
      const v = sub(z.centre, pose.position);
      if (len(v) < 0.5) return false;
      const diff = Math.abs(((headingOf(v) - pose.headingDeg + 540) % 360) - 180);
      return diff <= pose.fovDeg / 2 + 5 && len(v) < 12;
    })
    .map((z) => z.id);
}

// -- does the camera see what it is for? ---------------------------------------------------------------------------------------

/** Aspect of the reference images (1024 x 768): decides the vertical field of view. */
const ASPECT = 4 / 3;

interface Solid {
  a: Vec2;
  b: Vec2;
  half: number;
}

/** Wall pieces that block the eye and the body: every wall minus its door and passage spans (windows stay solid at eye height). */
function solidWalls(scene: Scene): Solid[] {
  const out: Solid[] = [];
  for (const w of scene.walls) {
    const len = len2(w.start, w.end);
    if (len < 1e-6) continue;
    const d = unit(sub(w.end, w.start));
    const cuts: [number, number][] = [];
    for (const o of scene.openings) {
      if (o.wallId !== w.id || (o.type !== 'door' && o.type !== 'passage')) continue;
      cuts.push([o.offset - o.width / 2, o.offset + o.width / 2]);
    }
    cuts.sort((p, q) => p[0] - q[0]);
    let at = 0;
    for (const [c0, c1] of cuts) {
      if (c0 > at + 1e-6) out.push({ a: add(w.start, mul(d, at)), b: add(w.start, mul(d, c0)), half: w.thickness / 2 });
      at = Math.max(at, c1);
    }
    if (at < len - 1e-6) out.push({ a: add(w.start, mul(d, at)), b: w.end, half: w.thickness / 2 });
  }
  return out;
}
const len2 = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Open door leaves as segments (hinge to free end): the viewer draws them open at 90 degrees. */
function doorLeaves(scene: Scene): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (const o of scene.openings) {
    if (o.type !== 'door' || o.glazed) continue;
    const f = openingFrame(scene, o);
    if (!f) continue;
    const poly = doorSwingPolygon(f, o);
    out.push([poly[0]!, poly[poly.length - 1]!]);
  }
  return out;
}

function segmentsCross(p: Vec2, q: Vec2, a: Vec2, b: Vec2): boolean {
  const o = (x: Vec2, y: Vec2, z: Vec2) => (y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0]);
  return o(p, q, a) * o(p, q, b) < 0 && o(a, b, p) * o(a, b, q) < 0;
}

/** True when the floor-plan line from `a` to `b` stays in rooms and doorways (no wall, no open door leaf) up to `stop` metres before `b`. */
function sightClear(scene: Scene, leaves: [Vec2, Vec2][], a: Vec2, b: Vec2, stop = 0.2): boolean {
  const total = len2(a, b);
  if (leaves.some(([h, e]) => segmentsCross(a, b, h, e))) return false;
  const steps = Math.max(1, Math.floor((total - stop) / 0.04));
  const doorways = scene.openings.filter((o) => o.type === 'door' || o.type === 'passage').map((o) => ({ o, f: openingFrame(scene, o) })).filter((x) => x.f);
  for (let k = 0; k <= steps; k++) {
    const p = add(a, mul(sub(b, a), (k / steps) * Math.max(0, (total - stop) / total)));
    if (scene.rooms.some((r) => pointInPolygon(p, r.polygon, 0.02))) continue;
    const inDoorway = doorways.some(({ o, f }) => {
      const v = sub(p, f!.centre);
      return Math.abs(v[0] * f!.dir[0] + v[1] * f!.dir[1]) <= o.width / 2 - 0.02 && Math.abs(v[0] * f!.left[0] + v[1] * f!.left[1]) <= f!.wall.thickness / 2 + 0.05;
    });
    if (!inDoorway) return false;
  }
  return true;
}

export interface ViewChecks {
  ok: boolean;
  /** Ids of the fittings in the picture (frustum and line of sight). */
  seen: string[];
  /** Share (0 to 1) of the target's sample points that are in the picture. */
  share: number;
  /** Why the first choice was replaced, when it was. */
  fallback?: string;
}

/** Sample points of an item: the corners and centre of its footprint at half height and at the top. */
function samplePoints(i: Item): { p: Vec2; z: number }[] {
  const d = itemDims(i);
  const base = i.elevation ?? 0;
  const corners = footprintOf(i.position, i.rotation, { w: d.w, d: d.d });
  const flat: Vec2[] = [...corners, [i.position[0], i.position[1]]];
  return flat.flatMap((p) => [{ p, z: base + d.h * 0.5 }, { p, z: base + d.h }]);
}

/** Share of the item's sample points that a camera at `pose` sees: inside both field-of-view limits and with a clear line of sight. */
export function itemVisibility(scene: Scene, pose: WalkPose, item: Item, leaves: [Vec2, Vec2][] = doorLeaves(scene)): number {
  const half = (pose.fovDeg * DEG) / 2;
  const vHalf = Math.atan(Math.tan(half) / ASPECT);
  const pts = samplePoints(item);
  let seen = 0;
  for (const { p, z } of pts) {
    const v = sub(p, pose.position);
    const dist = len(v);
    if (dist < 0.3) continue;
    const diff = Math.abs(((headingOf(v) - pose.headingDeg + 540) % 360) - 180) * DEG;
    if (diff > half - 2 * DEG) continue;
    if (Math.abs(Math.atan2(z - pose.eyeHeight, dist)) > vHalf - 2 * DEG) continue;
    if (!sightClear(scene, leaves, pose.position, p)) continue;
    seen++;
  }
  return seen / pts.length;
}

/** Fittings a bathroom view is for, main one first: locked sanitary ware of the room (toilet, bath, shower, basin ...). */
export function bathFittings(scene: Scene, room: Room): Item[] {
  const rank = (i: Item) => {
    const s = `${i.id} ${i.assetId}`;
    return /toilet|wc/i.test(s) ? 0 : /bath/i.test(s) ? 1 : /shower|douche/i.test(s) ? 2 : /basin|vanity|vasque/i.test(s) ? 3 : 9;
  };
  return scene.items
    .filter((i) => (i.roomId === undefined || i.roomId === room.id) && Boolean(i.locked) && pointInPolygon(i.position, room.polygon, 0.3) && rank(i) < 9)
    .sort((a, b) => rank(a) - rank(b));
}

/** Distance from the eye to the nearest wall surface (door spans excluded). */
const wallClearance = (solids: Solid[], p: Vec2) => solids.reduce((m, s) => Math.min(m, distanceToSegment(p, s.a, s.b) - s.half), Infinity);

/**
 * A camera in or just outside the door of a small room, aimed at its fittings, wide (90 to 100 degrees), clear of the walls and of the
 * open door leaf, with every candidate checked for what it sees. Returns the best one that sees the main fitting, else undefined.
 */
export function doorwayPose(scene: Scene, roomId: string, fittings: Item[], opts: { fovDeg?: number } = {}): { pose: WalkPose; checks: ViewChecks } | undefined {
  const room = roomOf(scene, roomId);
  const main = fittings[0];
  if (!main) return undefined;
  const solids = solidWalls(scene);
  const leaves = doorLeaves(scene);
  const fov = opts.fovDeg ?? 95;
  let best: { pose: WalkPose; score: number; seen: string[]; share: number } | undefined;
  for (const edge of roomEdges(scene, room)) {
    for (const o of edge.openings) {
      if (o.type === 'window') continue;
      const lateralDir: Vec2 = [-o.inward[1], o.inward[0]];
      for (let t = -1.3; t <= 0.45 + 1e-9; t += 0.05) {
        for (let s = -0.3; s <= 0.3 + 1e-9; s += 0.1) {
          const p = add(add(o.centre, mul(o.inward, t)), mul(lateralDir, s));
          if (Math.abs(t) <= 0.2) {
            if (Math.abs(s) > o.width / 2 - 0.12) continue;
          } else if (t > 0) {
            if (!pointInPolygon(p, room.polygon, 0) || distToPolygonEdges(p, room.polygon) < 0.2) continue;
          } else if (!scene.rooms.some((r) => r.id !== room.id && pointInPolygon(p, r.polygon, 0.2))) continue;
          if (wallClearance(solids, p) < 0.25) continue;
          if (leaves.some(([h, e]) => distanceToSegment(p, h, e) < 0.3)) continue;
          // aim at the middle of what is to be seen (main fitting weighted double), then check it all
          const wsum = fittings.length + 1;
          const aim: Vec2 = [(main.position[0] * 2 + fittings.slice(1).reduce((a, i) => a + i.position[0], 0)) / wsum, (main.position[1] * 2 + fittings.slice(1).reduce((a, i) => a + i.position[1], 0)) / wsum];
          const headingDeg = r1(headingOf(sub(aim, p)));
          const pose: WalkPose = { mode: 'walk', position: pt(p), eyeHeight: EYE, headingDeg, pitchDeg: 0, fovDeg: fov };
          const shares = fittings.map((i) => itemVisibility(scene, pose, i, leaves));
          if (shares[0]! < 0.75) continue;
          // near the door (the fitting looks bigger), not behind the open leaf, and the other fittings in the picture too
          const halfFov = (fov * DEG) / 2;
          const leafInView = leaves.some(([h, e]) => [h, e].some((q) => len(sub(q, p)) < 3 && Math.abs(((headingOf(sub(q, p)) - headingDeg + 540) % 360) - 180) * DEG < halfFov + 3 * DEG));
          const score = shares[0]! * 3 + shares.slice(1).reduce((a, v) => a + v, 0) - 0.3 * Math.max(0, -t) - 0.2 * Math.abs(s) - (leafInView ? 0.8 : 0);
          if (!best || score > best.score + 1e-9) best = { pose, score, seen: fittings.filter((_, k) => shares[k]! >= 0.5).map((i) => i.id), share: shares[0]! };
        }
      }
    }
  }
  if (!best) return undefined;
  return { pose: best.pose, checks: { ok: true, seen: best.seen, share: r2(best.share) } };
}

function checkView(scene: Scene, pose: WalkPose, fittings: Item[]): ViewChecks {
  const leaves = doorLeaves(scene);
  const shares = fittings.map((i) => itemVisibility(scene, pose, i, leaves));
  return { ok: (shares[0] ?? 0) >= 0.5, seen: fittings.filter((_, k) => shares[k]! >= 0.5).map((i) => i.id), share: r2(shares[0] ?? 0) };
}

// -- views -----------------------------------------------------------------------------------------------------------------

export interface ViewOpts {
  /** Only this zone (`living`, `kitchen`, ...); default: all zones. */
  zone?: string | undefined;
  /** At most this many views per zone. */
  perZone?: number | undefined;
}

/** How many views a zone deserves by default: big living spaces 3, a kitchen zone 2, small rooms 2 (1 under 4 m2). */
export function defaultViewCount(zone: ZoneInfo, room: Room): number {
  if (zone.kind === 'kitchen') return 2;
  if (zone.areaM2 < 4) return 1;
  if (room.type === 'office') return 3;
  return room.type === 'living' || room.type === 'dining' ? (zone.areaM2 >= 14 ? 3 : 2) : 2;
}

interface Target {
  kind: 'focus' | 'light';
  aim: Vec2;
  /** Unit vector from the aim into the room (where the eye goes). */
  from: Vec2;
  label: string;
  faces: string;
  ignore: string[];
}

function longestBlankEdge(edges: Edge[]): Edge | undefined {
  return [...edges].filter((e) => e.openings.length === 0).sort((a, b) => b.length - a.length)[0];
}

function mainTargets(scene: Scene, room: Room, edges: Edge[]): Target[] {
  const out: Target[] = [];
  const focal = focalItem(scene, room);
  if (focal) {
    const edge = [...edges].sort((p, q) => distanceToSegment(focal.position, p.a, p.b) - distanceToSegment(focal.position, q.a, q.b))[0]!;
    const name = room.type === 'living' ? 'media wall' : room.type === 'bathroom' ? 'bath wall' : 'focal wall';
    out.push({ kind: 'focus', aim: [focal.position[0], focal.position[1]], from: edge.inward, label: `towards the ${name}`, faces: `${focal.id}${edge.wallId ? ` on ${edge.wallId}` : ''}`, ignore: [focal.id] });
  } else if (room.type === 'living' || room.type === 'dining') {
    const e = longestBlankEdge(edges);
    if (e) out.push({ kind: 'focus', aim: mul(add(e.a, e.b), 0.5), from: e.inward, label: 'towards the feature wall', faces: `the plain wall${e.wallId ? ` ${e.wallId}` : ''}`, ignore: [] });
  }
  // the edge with the most light: its openings are the second target
  const lit = [...edges].map((e) => ({ e, w: e.openings.filter((o) => o.light).reduce((a, o) => a + o.width, 0) })).filter((x) => x.w > 0).sort((p, q) => q.w - p.w)[0];
  if (lit) {
    const ops = lit.e.openings.filter((o) => o.light);
    const aim = ops.reduce<Vec2>((a, o) => add(a, mul(o.centre, 1 / ops.length)), [0, 0]);
    const balcony = ops.some((o) => o.type === 'door');
    out.push({ kind: 'light', aim, from: lit.e.inward, label: balcony ? 'towards the balcony doors' : 'towards the windows', faces: ops.map((o) => o.id).join(', '), ignore: [] });
  }
  return out;
}

const HERO_W: Record<number, number[]> = { 1: [1], 2: [0.6, 0.4], 3: [0.4, 0.3, 0.3] };

function viewFor(scene: Scene, room: Room, zones: ZoneInfo[], id: string, zone: string, t: { aim: Vec2; from: Vec2; standoff: number; spread?: number; fovDeg?: number; ignore?: string[] }, extra: { label: string; faces: string; promptHint: string }): ViewSpec | undefined {
  const pose = standPose(scene, room.id, t.aim, { from: t.from, standoff: t.standoff, fovDeg: t.fovDeg ?? 70, ...(t.spread ? { spread: t.spread } : {}), ignore: new Set(t.ignore ?? []) });
  if (!pose) return undefined;
  return { id, zone, ...extra, weight: 0, hero: false, pose, sees: seesZone(pose, zones) };
}

function mainViews(scene: Scene, room: Room, zones: ZoneInfo[], zone: ZoneInfo, count: number): ViewSpec[] {
  const edges = roomEdges(scene, room);
  const targets = mainTargets(scene, room, edges);
  const standoff = (t: Target) => Math.min(4.4, Math.max(2.4, len(sub(t.aim, zone.centre)) + 2.2));
  const views: ViewSpec[] = [];
  const focus = targets.find((t) => t.kind === 'focus');
  const light = targets.find((t) => t.kind === 'light');
  const media = room.type === 'living';
  if (focus) {
    const v = viewFor(scene, room, zones, media ? 'media' : 'focus', zone.id, { aim: focus.aim, from: focus.from, standoff: standoff(focus), ignore: focus.ignore }, { label: focus.label, faces: focus.faces, promptHint: media ? 'The camera faces the TV wall; the sofa stands in the foreground seen from behind, facing the TV, with the coffee table and rug between them.' : `The camera faces ${focus.faces}.` });
    if (v) views.push(v);
  }
  if (light) {
    const v = viewFor(scene, room, zones, 'windows', zone.id, { aim: light.aim, from: light.from, standoff: standoff(light) }, { label: light.label, faces: light.faces, promptHint: media ? 'The camera faces the balcony doors and windows; the seating group is seen from the side and the passage to the doors is kept clear.' : 'The camera faces the windows.' });
    if (v) views.push(v);
  }
  if (focus && light) {
    // the diagonal: stand in the corner away from both and look between them
    const mid = mul(add(focus.aim, light.aim), 0.5);
    const away = unit(add(focus.from, light.from));
    const from = len(away) < 0.35 ? rot(focus.from, 40) : away;
    const v = viewFor(scene, room, zones, 'wide', zone.id, { aim: mid, from, standoff: 6, spread: 45, fovDeg: 85 }, { label: 'wide diagonal', faces: `${focus.faces} and ${light.faces}`, promptHint: media ? 'A wide corner view: the TV wall and the balcony doors both in the picture, the sofa facing the TV.' : 'A wide corner view of the room.' });
    if (v) views.push(v);
  } else if (!views.length || views.length === 1) {
    // no second target: the reverse view, from the focus side back across the room
    const first = views[0];
    const fallbackFrom = unit(sub(zone.centre, mul(add(edges[0]!.a, edges[0]!.b), 0.5)));
    const v = first
      ? viewFor(scene, room, zones, 'reverse', zone.id, { aim: first.pose.position, from: dirOfHeading(first.pose.headingDeg), standoff: 4.5, spread: 70 }, { label: 'back across the room', faces: 'the side of the room the first view stands on', promptHint: 'The camera looks back across the room from the far side.' })
      : viewFor(scene, room, zones, 'main', zone.id, { aim: zone.centre, from: fallbackFrom, standoff: 4.5, spread: 70 }, { label: 'main view', faces: 'the room', promptHint: 'The camera looks across the room.' });
    if (v) views.push(v);
    else if (!first) {
      const p = walkPoseInRoom(scene, room.id, {});
      views.push({ id: 'main', zone: zone.id, label: 'main view', faces: 'the room', promptHint: 'The camera looks across the room.', weight: 0, hero: false, pose: p, sees: seesZone(p, zones) });
    }
  }
  return views.slice(0, count);
}

const SMALL_ROOM_M2 = 4.5;

/**
 * Bathrooms and WCs: the cameras are for the fittings. A small room (under 4.5 m2, a WC) gets ONE wide camera at its door looking in
 * at the main fitting; a bigger one keeps the derived views, each checked for seeing the fittings and replaced by the doorway camera
 * when it does not. `checks` on each view says what it sees.
 */
function bathroomViews(scene: Scene, room: Room, zones: ZoneInfo[], zone: ZoneInfo, derived: ViewSpec[]): ViewSpec[] | undefined {
  const fittings = bathFittings(scene, room);
  if (!fittings.length) return undefined;
  const names = fittings.map((i) => i.id).join(', ');
  const doorway = (id: string, why?: string): ViewSpec | undefined => {
    const d = doorwayPose(scene, room.id, fittings);
    if (!d) return undefined;
    return { id, zone: zone.id, label: 'from the doorway', faces: `${fittings[0]!.id} (${names})`, weight: 0, hero: false, pose: d.pose, sees: seesZone(d.pose, zones), promptHint: `The camera stands in the doorway and looks into the small room at ${fittings[0]!.id}${fittings.length > 1 ? ' and the other fittings' : ''}; the walls of the line drawing close the picture.`, checks: { ...d.checks, ...(why ? { fallback: why } : {}) } };
  };
  if (zone.areaM2 < SMALL_ROOM_M2) {
    const v = doorway('main');
    if (v) return [v];
    return undefined;
  }
  const out: ViewSpec[] = [];
  for (const v of derived) {
    const c = checkView(scene, v.pose, fittings);
    if (c.ok) out.push({ ...v, checks: c });
    else if (!out.some((x) => x.id === 'doorway')) {
      const d = doorway('doorway', `${v.id} saw ${c.seen.length ? c.seen.join(', ') : 'none of the fittings'} (${Math.round(c.share * 100)}% of ${fittings[0]!.id})`);
      out.push(d ?? { ...v, checks: c });
    } else if (!out.some((x) => x.id === 'inside')) {
      // a second picture from inside the room, wide, aimed at the main fitting from the far side
      const main = fittings[0]!;
      const aim: Vec2 = [main.position[0], main.position[1]];
      const pose = standPose(scene, room.id, aim, { from: unit(sub(zone.centre, aim)), standoff: 3, spread: 90, minD: 0.9, fovDeg: 90, ignore: new Set(fittings.map((i) => i.id)) });
      const ic = pose ? checkView(scene, pose, fittings) : undefined;
      if (pose && ic?.ok) out.push({ id: 'inside', zone: zone.id, label: 'from inside, wide', faces: `${main.id} (${names})`, weight: 0, hero: false, pose, sees: seesZone(pose, zones), promptHint: `A wide view from inside the room towards ${main.id} and the other fittings.`, checks: { ...ic, fallback: `${v.id} saw ${Math.round(c.share * 100)}% of ${main.id}` } });
    }
  }
  return out;
}

function kitchenViews(scene: Scene, room: Room, zones: ZoneInfo[], zone: ZoneInfo, count: number): ViewSpec[] {
  const fit = scene.items.filter((i) => zone.fittings.includes(i.id));
  const aim: Vec2 = fit.length ? [fit.reduce((a, i) => a + i.position[0], 0) / fit.length, fit.reduce((a, i) => a + i.position[1], 0) / fit.length] : zone.centre;
  const edges = roomEdges(scene, room);
  const wall = [...edges].sort((p, q) => distanceToSegment(aim, p.a, p.b) - distanceToSegment(aim, q.a, q.b))[0]!;
  const ignore = fit.map((i) => i.id);
  const hint = 'The camera faces the kitchen fittings: worktop, hob, sink, fridge and wall units, in the architecture of the line drawing.';
  const out: ViewSpec[] = [];
  const front = viewFor(scene, room, zones, 'kitchen', zone.id, { aim, from: wall.inward, standoff: 3.4, fovDeg: 75, ignore }, { label: 'kitchen, front', faces: `kitchen fittings (${fit.map((i) => i.id).join(', ') || zone.id})`, promptHint: hint });
  if (front) out.push(front);
  // oblique: whichever side (+-50 degrees) lets the eye stand farther
  const sides = [50, -50].map((a) => viewFor(scene, room, zones, 'kitchen-side', zone.id, { aim, from: rot(wall.inward, a), standoff: 3.8, spread: 20, fovDeg: 75, ignore }, { label: 'kitchen, from the side', faces: `kitchen fittings (${fit.map((i) => i.id).join(', ') || zone.id})`, promptHint: `${hint} Seen at an angle from the living area.` })).filter((v): v is ViewSpec => Boolean(v));
  const dist = (v: ViewSpec) => len(sub(v.pose.position, aim));
  const side = sides.sort((p, q) => dist(q) - dist(p))[0];
  if (side) out.push(side);
  return out.slice(0, count);
}

/** Pose of a hint from the scene (`Room.views`). */
function hintView(scene: Scene, room: Room, zones: ZoneInfo[], h: RoomView, zoneId: string): ViewSpec | undefined {
  const fov = h.fovDeg ?? 70;
  let pose: WalkPose | undefined;
  if (h.position && h.headingDeg !== undefined) pose = { mode: 'walk', position: h.position, eyeHeight: EYE, headingDeg: norm360(h.headingDeg), pitchDeg: 0, fovDeg: fov };
  else if (h.point) {
    const z = zones.find((x) => x.id === zoneId);
    const from = unit(sub(z?.centre ?? polygonCentroidOf(room), h.point));
    pose = standPose(scene, room.id, h.point, { from, standoff: h.standoff ?? 3.5, fovDeg: fov });
  } else if (h.facing !== undefined) pose = walkPoseInRoom(scene, room.id, { facing: h.facing as never, fovDeg: fov });
  if (!pose) return undefined;
  return { id: h.id, zone: zoneId, label: h.label ?? h.id, faces: h.point ? `point ${h.point.join(',')}` : String(h.facing ?? 'fixed camera'), weight: h.weight ?? 0, hero: false, pose, sees: seesZone(pose, zones), promptHint: `The camera looks ${h.label ?? 'across the room'}.` };
}
const polygonCentroidOf = (room: Room): Vec2 => sampledCentre(room.polygon, []);

/** All the views of a room (or of one zone), hero first in each zone, weights set and renormalised per zone. */
export function roomViews(scene: Scene, roomId: string, opts: ViewOpts = {}): ViewSpec[] {
  const room = roomOf(scene, roomId);
  const zones = roomZones(scene, roomId);
  const wanted = opts.zone ? findZone(zones, opts.zone) : undefined;
  if (opts.zone && !wanted) throw new Error(`room "${roomId}" has no zone "${opts.zone}" (zones: ${zones.map((z) => z.id).join(', ')})`);
  const out: ViewSpec[] = [];
  for (const zone of zones) {
    if (wanted && wanted.id !== zone.id) continue;
    const n = Math.max(1, opts.perZone ?? defaultViewCount(zone, room));
    let derived = zone.kind === 'kitchen' ? kitchenViews(scene, room, zones, zone, 9) : mainViews(scene, room, zones, zone, 9);
    if (zone.kind === 'main' && room.type === 'bathroom') derived = bathroomViews(scene, room, zones, zone, derived) ?? derived;
    if (zone.kind === 'main' && room.type === 'office') derived = officeViews(scene, room, zones, zone) ?? derived;
    if (zone.kind === 'kitchen') {
      const fit = scene.items.filter((i) => zone.fittings.includes(i.id) && !/wall|hood/i.test(i.assetId));
      if (fit.length) derived = derived.map((v) => ({ ...v, checks: checkView(scene, v.pose, fit) }));
    }
    const views = derived.slice(0, n);
    for (const h of room.views ?? []) {
      const hz = h.zone ? (findZone(zones, h.zone)?.id ?? h.zone) : zones.find((z) => z.kind === 'main')?.id;
      if (hz !== zone.id) continue;
      const v = hintView(scene, room, zones, h, zone.id);
      if (!v) continue;
      const at = views.findIndex((x) => x.id === h.id);
      if (at >= 0) views[at] = { ...v, weight: h.weight ?? 0 };
      else views.push(v);
    }
    const base = HERO_W[Math.min(3, views.length)] ?? [1];
    views.forEach((v, i) => {
      if (v.weight === 0) v.weight = base[Math.min(i, base.length - 1)]!;
      v.hero = i === 0;
    });
    const total = views.reduce((a, v) => a + v.weight, 0) || 1;
    for (const v of views) v.weight = r2(v.weight / total);
    out.push(...views);
  }
  return out;
}

// -- layout intent ---------------------------------------------------------------------------------------------------------

const SOFA = { w: 2.1, d: 0.95 };
const TABLE = { w: 1.0, d: 0.55 };
const CIRC_W = 0.9;

function sampleRect(centre: Vec2, rotationDeg: number, w: number, d: number): Vec2[] {
  const out: Vec2[] = [];
  for (let x = -w / 2; x <= w / 2 + 1e-9; x += w / 4) for (let z = -d / 2; z <= d / 2 + 1e-9; z += d / 2) {
    const c = Math.cos(rotationDeg * DEG);
    const s = Math.sin(rotationDeg * DEG);
    out.push([centre[0] + x * c + z * s, centre[1] - x * s + z * c]);
  }
  return out;
}

function livingIntent(scene: Scene, room: Room, zones: ZoneInfo[], zone: ZoneInfo): LayoutIntent {
  const edges = roomEdges(scene, room);
  const targets = mainTargets(scene, room, edges);
  const focus = targets.find((t) => t.kind === 'focus');
  const kitchen = zones.find((z) => z.kind === 'kitchen');
  const lights = edges.flatMap((e) => e.openings.filter((o) => o.light));
  const entries = edges.flatMap((e) => e.openings.filter((o) => o.entry)).sort((a, b) => Number(b.otherType === 'hallway') - Number(a.otherType === 'hallway'));
  const circulation: LayoutIntent['circulation'] = [];
  for (const e of entries.slice(0, 1)) for (const l of lights.slice(0, 2)) circulation.push({ from: e.id, to: l.id, widthM: CIRC_W });
  // landings: a 1.1 m deep strip in front of every light door and the entrance, as wide as the opening plus 0.3 m
  const landings = [...lights, ...entries.slice(0, 1)].filter((o) => o.type !== 'window').map((o) => ({ a: o.centre, b: add(o.centre, mul(o.inward, 1.1)), half: o.width / 2 + 0.15 }));
  const fixed = scene.items.filter((i) => (i.roomId === undefined || i.roomId === room.id) && (i.locked || /builtin:/.test(i.assetId)) && (i.elevation ?? 0) < 0.6).map((i) => footprintOf(i.position, i.rotation, itemDims(i)));
  const free = (centre: Vec2, rotationDeg: number, w: number, d: number): boolean =>
    sampleRect(centre, rotationDeg, w, d).every((p) => pointInPolygon(p, room.polygon, 0) && distToPolygonEdges(p, room.polygon) >= 0.08 && !(kitchen && pointInPolygon(p, kitchen.polygon, 0.3)) && !fixed.some((f) => inConvex(p, f)) && landings.every((l) => distanceToSegment(p, l.a, l.b) >= l.half));

  const place: LayoutIntent['place'] = [];
  const notes: string[] = [];
  let sofaAt: { c: Vec2; rot: number } | undefined;
  const focusId = focus?.ignore[0];
  if (focus) {
    const n = focus.from;
    const t: Vec2 = [-n[1], n[0]];
    let found: { c: Vec2; rot: number; d: number; lat: number } | undefined;
    search: for (const lat of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
      for (let d = 3.0; d >= 1.9; d -= 0.1) {
        const c = add(add(focus.aim, mul(n, d)), mul(t, lat));
        const rotation = rotationFacing([-n[0], -n[1]]);
        if (free(c, rotation, SOFA.w, SOFA.d)) {
          found = { c, rot: rotation, d, lat };
          break search;
        }
      }
    }
    if (found) {
      sofaAt = { c: found.c, rot: found.rot };
      const toTv: Vec2 = [-n[0], -n[1]];
      const table = add(found.c, mul(toTv, SOFA.d / 2 + 0.4 + TABLE.d / 2));
      const rug = add(found.c, mul(toTv, 0.55));
      place.push({ role: 'sofa', category: 'sofa', relation: { kind: 'at', position: pt(found.c), rotation: r1(found.rot) }, note: `faces ${focusId}; back to the room${kitchen ? ' and the kitchen' : ''}` });
      place.push({ role: 'coffee table', category: 'table', relation: { kind: 'at', position: pt(table), rotation: r1(found.rot) }, note: 'about 0.4 m in front of the sofa' });
      place.push({ role: 'rug', category: 'rug', relation: { kind: 'at', position: pt(rug), rotation: r1(found.rot) }, note: 'under the front legs of the sofa and the table' });
      const wallId = edges.find((e) => e.wallId && distanceToSegment(focus.aim, e.a, e.b) < 0.5)?.wallId;
      if (wallId) place.push({ role: 'media unit', category: 'drawers', relation: { kind: 'against_wall', wallId }, note: `under ${focusId}, only if it clears the passage` });
      notes.push(`Seating group of ${SOFA.w} m sofa about ${r1(found.d)} m from ${focusId}${found.lat ? `, ${r1(Math.abs(found.lat))} m off its axis` : ', on its axis'}, facing it (solver: place with "at" then "facing" ${focusId}).`);
    } else notes.push(`No free spot found for a ${SOFA.w} m sofa facing ${focusId}: place the seating group by hand, facing ${focusId}, clear of the circulation paths.`);
  } else {
    notes.push('No TV or fireplace: make the longest plain wall the focus and put the sofa facing it, or against the wall opposite the windows.');
  }
  if (circulation.length) notes.push(`Keep the walk ${circulation.map((c) => `from ${c.from} to ${c.to}`).join(' and ')} at least ${CIRC_W} m wide (walk around the seating, never through it) and nothing in the 1.1 m in front of the doors to the balcony or the entrance.`);
  if (kitchen) notes.push(`The kitchen zone (${kitchen.id}) keeps its locked fittings; the living zone ends where its floor changes. A sofa back may mark the boundary.`);
  void zone;
  const promptText = focus
    ? `Layout: the sofa faces the TV wall and stands in the middle of the room with its back to ${kitchen ? 'the kitchen' : 'the room'}; a coffee table and a rug between the sofa and the TV; a clear passage to the balcony doors.`
    : 'Layout: the sofa faces the plain wall, a clear passage to the doors.';
  const text = `Layout decided from the room, not from any image (zone ${zone.id}):\n- ${notes.join('\n- ')}${sofaAt ? '' : ''}\nCameras and prompts only show this layout; follow it for the pieces listed under "place", whatever an image shows.`;
  return { zone: zone.id, text, promptText, place, circulation, fixes: place.length ? ['sofa', 'rug', 'table'] : [] };
}

// -- the office / gaming room ---------------------------------------------------------------------------------------------

/** A gaming desk (UTESPELARE 160 x 80) and what a seated player needs behind it. */
const DESK = { w: 1.6, d: 0.8 };
const CHAIR_BACK = 1.0;
const CAT_DEPTH = 0.3;
const TREE = { w: 0.6, d: 0.5 };
const DESK_ITEM = /desk|bureau|gamer|gaming/i;

const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
/** Inside the rectangle along the segment a-b, `half` either side (no round end cap). */
function inStrip(p: Vec2, a: Vec2, b: Vec2, half: number): boolean {
  const ab = sub(b, a);
  const t = dot(sub(p, a), ab) / (dot(ab, ab) || 1);
  return t >= 0 && t <= 1 && distanceToSegment(p, a, b) < half;
}

interface Rect {
  centre: Vec2;
  rotation: number;
  w: number;
  d: number;
}

export interface OfficeSetup {
  edge: Edge;
  desk: Rect & { glare: number };
  chair: Rect;
  /** The window the desk sits beside (the screens do not face it). */
  light?: OpeningInfo;
  cat?: { edge: Edge; centre: Vec2; rotation: number; length: number };
  tree?: Rect;
}

const rectCorners = (r: Rect): Vec2[] => footprintOf(r.centre, r.rotation, { w: r.w, d: r.d });
const rectOverlap = (a: Rect, b: Rect): boolean =>
  sampleRect(a.centre, a.rotation, a.w, a.d).some((p) => inConvex(p, rectCorners(b))) || sampleRect(b.centre, b.rotation, b.w, b.d).some((p) => inConvex(p, rectCorners(a)));

/** Where an office goes, decided from the room: the desk beside a window (never facing it), the chair, the cat wall and a cat tree. */
export function officeSetup(scene: Scene, room: Room): OfficeSetup | undefined {
  const edges = roomEdges(scene, room);
  const lights = edges.flatMap((e) => e.openings.filter((o) => o.light));
  const swings: Vec2[][] = [];
  for (const o of scene.openings) {
    if (o.type !== 'door') continue;
    const f = openingFrame(scene, o);
    if (!f || (f.leftRoom?.id !== room.id && f.rightRoom?.id !== room.id)) continue;
    swings.push(doorSwingPolygon(f, o));
  }
  const entries = edges.flatMap((e) => e.openings.filter((o) => o.type === 'door'));
  const landings = entries.map((o) => ({ a: o.centre, b: add(o.centre, mul(o.inward, 1.1)), half: o.width / 2 + 0.15 }));
  const fixed = scene.items
    .filter((i) => (i.roomId === undefined || i.roomId === room.id) && (i.locked || /builtin:/.test(i.assetId)) && (i.elevation ?? 0) < 1.2 && pointInPolygon(i.position, room.polygon, 0.3))
    .map((i) => {
      const d = itemDims(i);
      return footprintOf(i.position, i.rotation, { w: d.w + 0.1, d: d.d + 0.3 });
    });
  const free = (r: Rect, others: Rect[] = []): boolean =>
    sampleRect(r.centre, r.rotation, r.w, r.d).every(
      (p) => pointInPolygon(p, room.polygon, 0.001) && !swings.some((s) => pointInPolygon(p, s, 0)) && !fixed.some((f) => inConvex(p, f)) && landings.every((l) => !inStrip(p, l.a, l.b, l.half)),
    ) && !others.some((o) => rectOverlap(r, o));

  // the desk: scored on screen glare (the window should be at the side of the screens, not behind or in front of them)
  type Cand = { edge: Edge; desk: Rect & { glare: number }; chair: Rect; light?: OpeningInfo; cost: number };
  let best: Cand | undefined;
  for (const edge of edges) {
    if (edge.length < 1.2) continue;
    const u = unit(sub(edge.b, edge.a));
    for (const w of [DESK.w, 1.4, 1.2]) {
      for (let s = w / 2; s <= edge.length - w / 2 + 1e-9; s = s + 0.05 > edge.length - w / 2 + 1e-9 && s < edge.length - w / 2 - 1e-9 ? edge.length - w / 2 : s + 0.05) {
        const wallPt = add(edge.a, mul(u, s));
        // not across an opening of its own wall
        if (edge.openings.some((o) => Math.abs(dot(sub(o.centre, wallPt), u)) < o.width / 2 + w / 2 + (o.light ? 0.08 : 0.1))) continue;
        const rotation = rotationFacing(edge.inward);
        const desk: Rect = { centre: add(wallPt, mul(edge.inward, DESK.d / 2)), rotation, w, d: DESK.d };
        const chair: Rect = { centre: add(wallPt, mul(edge.inward, DESK.d + CHAIR_BACK / 2 + 0.05)), rotation: norm360(rotation + 180), w: 0.7, d: CHAIR_BACK };
        if (!free(desk) || !free(chair, [desk])) continue;
        const near = [...lights].sort((p, q) => len(sub(p.centre, desk.centre)) - len(sub(q.centre, desk.centre)))[0];
        const glare = near ? Math.abs(dot(edge.inward, unit(sub(near.centre, desk.centre)))) : 0;
        const toEnd = Math.min(s - w / 2, edge.length - s - w / 2);
        const cost = glare * 2 - w * 0.6 + toEnd * 0.3;
        if (!best || cost < best.cost - 1e-9) best = { edge, desk: { ...desk, glare }, chair, ...(near ? { light: near } : {}), cost };
      }
    }
  }
  if (!best) return undefined;
  const setup: OfficeSetup = { edge: best.edge, desk: best.desk, chair: best.chair, ...(best.light ? { light: best.light } : {}) };
  const deskZone: Rect = best.desk;
  const chairZone = best.chair;

  // the cat wall: the longest free stretch (0.9 to 1.4 m) of another wall without a window, away from the desk and the chair
  let cat: { edge: Edge; centre: Vec2; rotation: number; length: number; score: number } | undefined;
  for (const edge of edges) {
    if (edge === best.edge || edge.openings.some((o) => o.light) || edge.length < 0.9) continue;
    const u = unit(sub(edge.b, edge.a));
    for (let s = 0.2; s <= edge.length - 0.9; s += 0.05) {
      let reach = 0;
      for (let l = 0.9; l <= 1.4 + 1e-9 && s + l <= edge.length - 0.05; l += 0.1) {
        const c = add(add(edge.a, mul(u, s + l / 2)), mul(edge.inward, (CAT_DEPTH + 0.1) / 2));
        const rect: Rect = { centre: c, rotation: rotationFacing(edge.inward), w: l, d: CAT_DEPTH + 0.1 };
        if (edge.openings.some((o) => Math.abs(dot(sub(o.centre, c), u)) < o.width / 2 + l / 2)) break;
        if (!free(rect, [deskZone, chairZone])) break;
        reach = l;
      }
      if (reach >= 0.9) {
        const centre = add(add(edge.a, mul(u, s + reach / 2)), mul(edge.inward, CAT_DEPTH / 2));
        const doorFar = Math.min(...entries.map((o) => len(sub(o.centre, centre))), 9);
        const score = reach * 2 + doorFar * 0.4;
        if (!cat || score > cat.score + 1e-9) cat = { edge, centre, rotation: rotationFacing(edge.inward), length: r2(reach), score };
      }
    }
  }
  if (cat) setup.cat = { edge: cat.edge, centre: cat.centre, rotation: cat.rotation, length: cat.length };
  const catZone: Rect | undefined = cat ? { centre: add(cat.centre, mul(cat.edge.inward, 0.2)), rotation: cat.rotation, w: cat.length, d: CAT_DEPTH + 0.4 } : undefined;

  // the cat tree: against a wall, as near a window as possible (cats watch outside), off every window, the desk, the chair and the cat wall
  let tree: (Rect & { score: number }) | undefined;
  for (const edge of edges) {
    if (edge.length < TREE.w) continue;
    const u = unit(sub(edge.b, edge.a));
    for (let s = TREE.w / 2; s <= edge.length - TREE.w / 2 + 1e-9; s += 0.05) {
      const wallPt = add(edge.a, mul(u, s));
      if (edge.openings.some((o) => Math.abs(dot(sub(o.centre, wallPt), u)) < o.width / 2 + TREE.w / 2 + 0.05)) continue;
      const rect: Rect = { centre: add(wallPt, mul(edge.inward, TREE.d / 2)), rotation: rotationFacing(edge.inward), w: TREE.w, d: TREE.d };
      if (!free({ ...rect, centre: add(rect.centre, mul(edge.inward, 0.02)), w: TREE.w + 0.04, d: TREE.d + 0.04 }, [deskZone, chairZone, ...(catZone ? [catZone] : [])])) continue;
      const near = Math.min(...lights.map((l) => len(sub(l.centre, rect.centre))), 9);
      if (!tree || -near > tree.score + 1e-9) tree = { ...rect, score: -near };
    }
  }
  if (tree) setup.tree = { centre: tree.centre, rotation: tree.rotation, w: tree.w, d: tree.d };
  return setup;
}

/** The gaming desk and the cat furniture already in the room (by product category, generator or name). */
function officeItems(scene: Scene, room: Room): { desk?: Item; cats: Item[] } {
  const mine = scene.items.filter((i) => (i.roomId === undefined || i.roomId === room.id) && !i.locked && pointInPolygon(i.position, room.polygon, 0.3));
  const generator = (i: Item) => (i.mesh?.kind === 'parametric' ? i.mesh.generator : '');
  const cats = mine.filter((i) => /^cat(Wall|Tree)$/.test(generator(i)));
  const desk = mine.find((i) => !cats.includes(i) && (i.elevation ?? 0) < 0.3 && itemDims(i).w >= 1 && (i.product?.category === 'desk' || DESK_ITEM.test(`${i.id} ${i.assetId} ${generator(i)} ${i.product?.name ?? ''}`)));
  return { ...(desk ? { desk } : {}), cats };
}

function officeViews(scene: Scene, room: Room, zones: ZoneInfo[], zone: ZoneInfo): ViewSpec[] | undefined {
  const setup = officeSetup(scene, room);
  if (!setup) return undefined;
  const items = officeItems(scene, room);
  const deskAim: Vec2 = items.desk ? [items.desk.position[0], items.desk.position[1]] : setup.desk.centre;
  const deskEdge = [...roomEdges(scene, room)].sort((p, q) => distanceToSegment(deskAim, p.a, p.b) - distanceToSegment(deskAim, q.a, q.b))[0]!;
  const ignoreDesk = items.desk ? [items.desk.id] : [];
  const withChecks = (v: ViewSpec | undefined, targets: Item[]): ViewSpec | undefined => (v && targets.length ? { ...v, checks: checkView(scene, v.pose, targets) } : v);
  const views: ViewSpec[] = [];
  // 1. the desk wall: the camera stands across the room, the window at the side of the picture
  // (a small room leaves 1.4 m between the eye and the desk: a wide lens and a lower eye keep the desk top and the screens in the picture)
  const lowEye = (v: ViewSpec | undefined): ViewSpec | undefined => (v ? { ...v, pose: { ...v.pose, eyeHeight: 1.3 } } : v);
  const desk = withChecks(
    lowEye(viewFor(scene, room, zones, 'desk', zone.id, { aim: deskAim, from: deskEdge.inward, standoff: 2.4, spread: 55, fovDeg: 90, ignore: ignoreDesk }, { label: 'desk wall', faces: `${items.desk?.id ?? 'the gaming desk'}${deskEdge.wallId ? ` on ${deskEdge.wallId}` : ''}${setup.light ? `, ${setup.light.id} at its side` : ''}`, promptHint: 'The camera faces the gaming desk against the wall: two monitors, the gaming chair pulled in, shelves and a light strip above; the window is at the side of the picture.' })),
    items.desk ? [items.desk] : [],
  );
  if (desk) views.push(desk);
  // 2. the cat wall
  if (setup.cat) {
    const catAim: Vec2 = items.cats.length ? [items.cats.reduce((a, i) => a + i.position[0], 0) / items.cats.length, items.cats.reduce((a, i) => a + i.position[1], 0) / items.cats.length] : setup.cat.centre;
    const cats = withChecks(
      viewFor(scene, room, zones, 'cats', zone.id, { aim: catAim, from: setup.cat.edge.inward, standoff: 2.6, spread: 55, fovDeg: 78, ignore: items.cats.map((i) => i.id) }, { label: 'cat wall', faces: `${items.cats.map((i) => i.id).join(', ') || 'the cat climbing wall'}${setup.cat.edge.wallId ? ` on ${setup.cat.edge.wallId}` : ''}`, promptHint: 'The camera faces the wall where the cats climb: staggered wooden boards rising to a bridge, a cave and a scratching post, with the cat tree in the corner.' }),
      items.cats,
    );
    if (cats) views.push(cats);
  }
  // 3. a wide corner view from the door side: the desk wall and the cat wall together
  const other = setup.cat?.centre ?? zone.centre;
  const mid = mul(add(deskAim, other), 0.5);
  // the camera goes to the polygon corner farthest from the middle of the two walls, on the door side when two corners tie
  const doors = roomEdges(scene, room).flatMap((e) => e.openings.filter((o) => o.type === 'door'));
  const toDoor = (q: Vec2) => Math.min(...doors.map((d) => len(sub(q, d.centre))), 99);
  const far = room.polygon.filter((q) => len(sub(q, mid)) >= 2);
  const corner = [...(far.length ? far : room.polygon)].sort((p, q) => (far.length ? toDoor(p) - toDoor(q) : len(sub(q, mid)) - len(sub(p, mid))))[0]!;
  const away = unit(sub(corner, mid));
  const cornerEye = pt(add(corner, mul(unit(sub(zone.centre, corner)), 0.5)));
  const blockedEye = bodies(scene, room, new Set()).some((b) => inConvex(cornerEye, b));
  const fromCorner: ViewSpec | undefined = blockedEye ? undefined : { id: 'wide', zone: zone.id, label: 'wide corner', faces: 'the desk wall and the cat wall', weight: 0, hero: false, pose: { mode: 'walk', position: cornerEye, eyeHeight: EYE, headingDeg: r1(headingOf(sub(mid, cornerEye))), pitchDeg: 0, fovDeg: 95 }, sees: [], promptHint: 'A wide corner view of the whole alcove from the door side: the gaming desk on one side, the cat climbing wall on the other.' };
  if (fromCorner) fromCorner.sees = seesZone(fromCorner.pose, zones);
  const wide = fromCorner ?? viewFor(scene, room, zones, 'wide', zone.id, { aim: mid, from: len(away) < 0.3 ? deskEdge.inward : away, standoff: 4, spread: 50, fovDeg: 88, ignore: ignoreDesk }, { label: 'wide corner', faces: 'the desk wall and the cat wall', promptHint: 'A wide corner view of the whole alcove: the gaming desk on one side, the cat climbing wall on the other.' });
  if (wide) views.push(wide);
  return views.length ? views : undefined;
}

function officeIntent(scene: Scene, room: Room, zone: ZoneInfo): LayoutIntent | undefined {
  const s = officeSetup(scene, room);
  if (!s) return undefined;
  const wall = s.edge.wallId;
  const place: LayoutIntent['place'] = [];
  const notes: string[] = [];
  place.push({ role: 'gaming desk', category: 'desk', relation: { kind: 'at', position: pt(s.desk.centre), rotation: r1(s.desk.rotation) }, note: `${r2(s.desk.w)} m wide, back flat to ${wall ?? 'the wall'}${s.light ? `, beside ${s.light.id}` : ''}` });
  place.push({ role: 'gaming chair', category: 'chair', relation: { kind: 'at', position: pt(add(s.desk.centre, mul(s.edge.inward, DESK.d / 2 + 0.36))), rotation: r1(s.chair.rotation) }, note: `facing the desk, its front edge against the desk edge (the solver does not allow tucking under);  m of floor behind the desk edge to roll back` });
  place.push({ role: 'monitor stand', category: 'desk', relation: { kind: 'on', itemId: '<desk id>' }, note: 'one or two screens on a stand or arm, centred on the desk' });
  place.push({ role: 'wall shelves', category: 'shelf', relation: { kind: 'against_wall', ...(wall ? { wallId: wall } : {}) }, note: 'above the desk, 1.3-1.6 m up: headset, controllers, a light strip underneath' });
  if (s.cat) place.push({ role: 'cat climbing wall', category: 'decor', relation: { kind: 'at', position: pt(s.cat.centre), rotation: r1(s.cat.rotation), elevation: 0.2 }, note: `${r1(s.cat.length)} m of ${s.cat.edge.wallId ?? 'wall'}, steps rising to a bridge (generator catWall, a concept)` });
  if (s.tree) place.push({ role: 'cat tree', category: 'decor', relation: { kind: 'at', position: pt(s.tree.centre), rotation: r1(s.tree.rotation) }, note: 'against a wall as near the window as the door and the radiator allow (generator catTree, a concept)' });
  notes.push(`Gaming desk (${r2(s.desk.w)} x ${DESK.d} m) flat to ${wall ?? 'the wall'}${s.light ? `, with ${s.light.id} at the SIDE of the screens (glare factor ${r2(s.desk.glare)}; 0 = window exactly beside the screens, 1 = straight behind or in front of them)` : ''}: never turn the screens towards a window.`);
  notes.push(`Gaming chair on the room side of the desk, with  m of free floor in front of the desk edge for the roll back; the door swing, the 1.1 m landing in front of the doors and the radiator (15 cm in front of it) stay clear.`);
  if (s.cat) notes.push(`Cat climbing wall on ${s.cat.edge.wallId ?? 'a wall'} (${r1(s.cat.length)} m, boards ${CAT_DEPTH} m deep, at most 0.45 m between boards, a bridge on top, a cave and a sisal post), never on the window wall.`);
  if (s.tree) notes.push(`Cat tree (${TREE.w} x ${TREE.d} m) at ${pt(s.tree.centre).join(', ')}, against the wall, as near the window as the door and the radiator allow, so the cats can watch outside.`);
  notes.push('Cables: one power strip under the desk along the wall and a single cable run down the wall behind the desk (nothing loose in the walkway); lamps and LED strips plug into the same strip.');
  const promptText = `Layout: a gaming desk with two screens flat to the wall beside the window (the window at the side of the screens), a gaming chair, ${s.cat ? 'a cat climbing wall of wooden boards on the opposite side, ' : ''}${s.tree ? 'a cat tree in the corner, ' : ''}a light strip under the shelves above the desk.`;
  const text = `Layout decided from the room, not from any image (zone ${zone.id}):\n- ${notes.join('\n- ')}\nCameras and prompts only show this layout; follow it for the pieces listed under "place", whatever an image shows.`;
  return { zone: zone.id, text, promptText, place, circulation: [], fixes: ['desk', 'chair'] };
}

function genericIntent(scene: Scene, room: Room, zone: ZoneInfo): LayoutIntent {
  const edges = roomEdges(scene, room);
  const blank = longestBlankEdge(edges);
  const place: LayoutIntent['place'] = [];
  const notes: string[] = [];
  const circulation: LayoutIntent['circulation'] = [];
  const entry = edges.flatMap((e) => e.openings.filter((o) => o.entry)).sort((a, b) => Number(b.otherType === 'hallway') - Number(a.otherType === 'hallway'))[0];
  const light = edges.flatMap((e) => e.openings.filter((o) => o.light))[0];
  if (entry && light) circulation.push({ from: entry.id, to: light.id, widthM: CIRC_W });
  if (room.type === 'bedroom' && blank?.wallId) {
    place.push({ role: 'bed', category: 'bed', relation: { kind: 'against_wall', wallId: blank.wallId, align: 'center' }, note: 'headboard on the longest plain wall, away from doors and windows' });
    place.push({ role: 'bedside table', category: 'bedside', relation: { kind: 'next_to', itemId: '<bed id>', side: 'left' } });
    notes.push(`Bed headboard against ${blank.wallId} (${r1(blank.length)} m, no openings); bedside tables on both sides.`);
  } else if (zone.kind === 'main' && blank?.wallId && (room.type === 'living' || room.type === 'dining' || room.type === 'office')) {
    place.push({ role: 'main piece', category: 'sofa', relation: { kind: 'against_wall', wallId: blank.wallId } });
    notes.push(`Main piece against the longest plain wall ${blank.wallId}.`);
  }
  const locked = scene.items.filter((i) => i.locked && (i.roomId === undefined || i.roomId === room.id));
  if (locked.length) notes.push(`Locked fittings stay: ${locked.map((i) => i.id).join(', ')}.`);
  if (circulation.length) notes.push(`Keep a ${CIRC_W} m path free from ${circulation[0]!.from} to ${circulation[0]!.to}.`);
  if (zone.kind === 'kitchen') notes.push('Do not move the fittings; add only finishes, a table or stools that leave 1 m in front of the worktop, and lighting.');
  if (!notes.length) notes.push('Keep doors, door swings and passages clear; use the solver relations (against_wall, next_to, facing) for every piece.');
  const promptText = room.type === 'bedroom' ? 'Layout: the bed has its headboard on the wall without openings, bedside tables on both sides.' : zone.kind === 'kitchen' ? 'Layout: the fitted kitchen stays exactly as drawn.' : '';
  return { zone: zone.id, text: `Layout decided from the room, not from any image (zone ${zone.id}):\n- ${notes.join('\n- ')}\nCameras and prompts only show this layout; follow it for the pieces listed under "place".`, promptText, place, circulation, fixes: place.map((p) => p.category) };
}

/** The layout intent of a zone (default: the main zone). */
export function layoutIntent(scene: Scene, roomId: string, zoneId?: string): LayoutIntent {
  const room = roomOf(scene, roomId);
  const zones = roomZones(scene, roomId);
  const zone = findZone(zones, zoneId) ?? zones[0]!;
  if (zone.kind === 'main' && room.type === 'living') return livingIntent(scene, room, zones, zone);
  if (zone.kind === 'main' && room.type === 'office') {
    const office = officeIntent(scene, room, zone);
    if (office) return office;
  }
  return genericIntent(scene, room, zone);
}

/** The view to use for a call: by id, within an optional zone. */
export function findView(views: ViewSpec[], id: string | undefined): ViewSpec | undefined {
  return id ? views.find((v) => v.id === id) : undefined;
}


/** What `describe_room` adds: the zones, the views (camera, weight, what they see) and the layout intent of each zone. */
export function roomPlan(scene: Scene, roomId: string) {
  const zones = roomZones(scene, roomId);
  const views = roomViews(scene, roomId);
  return {
    zones: zones.map((z) => ({ id: z.id, kind: z.kind, areaM2: z.areaM2, ...(z.fittings.length ? { fittings: z.fittings } : {}) })),
    views: views.map((v) => ({ ...(v.checks ? { checks: v.checks } : {}), id: v.id, zone: v.zone, label: v.label, faces: v.faces, weight: v.weight, hero: v.hero, eye: v.pose.position, headingDeg: v.pose.headingDeg, fovDeg: v.pose.fovDeg, sees: v.sees })),
    layout: zones.map((z) => {
      const l = layoutIntent(scene, roomId, z.id);
      return { zone: z.id, text: l.text, place: l.place, ...(l.circulation.length ? { circulation: l.circulation } : {}) };
    }),
  };
}
