import { isBuiltinAsset } from './items/builtin-assets';
import { gridFixtures } from './lighting/grid';
import { checkParametricMesh, GENERATOR_DIMS_TOLERANCE } from './items/mesh-source';
import { edgeCoverage, roomCeilingHeight, triangulatePolygon } from './geometry/floors';
import { polygonArea } from './measure';
import { validateLayout } from './placement/validateLayout';
import type { Dims } from './primitives';
import type { Scene, Vec2 } from './schema';
import { wallLength } from './schema';

export interface ValidationWarning {
  /** Stable machine-readable code, e.g. `opening-near-junction`. */
  code: string;
  message: string;
  /** Scene entities involved (wall, opening, room, light ids). */
  entityIds: string[];
  /** Location in the scene JSON, e.g. `openings[3]`. */
  path?: string;
}

export interface ValidationResult {
  warnings: ValidationWarning[];
}

/** Warn when a room has an edge stretch longer than this with no wall behind it, in metres. */
export const UNWALLED_TOLERANCE = 0.1;
/** Minimum overlap area between two rooms that is reported, in m². */
export const OVERLAP_AREA_THRESHOLD = 1e-4;
/** Floor zones smaller than this are reported, in m². */
export const FLOOR_ZONE_MIN_AREA = 0.01;
/** Coordinates farther than this from the origin are reported, in metres. */
export const MAX_COORDINATE = 1000;

function dimsClose(a: Dims, b: Dims): boolean {
  const ok = (x: number, y: number) => Math.abs(x - y) <= Math.max(GENERATOR_DIMS_TOLERANCE * y, 0.001);
  return ok(a.w, b.w) && ok(a.d, b.d) && ok(a.h, b.h);
}

/** True when `p` lies inside the polygon or within `tolerance` of its boundary. */
export function pointInPolygon(p: Vec2, polygon: readonly Vec2[], tolerance = 1e-6): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (distanceToSegment(p, a, b) <= tolerance) return true;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Sutherland–Hodgman: clips `subject` by a convex counter-clockwise (math axes) polygon. */
function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  let output = subject;
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = output;
    output = [];
    for (let k = 0; k < input.length; k++) {
      const cur = input[k]!;
      const prev = input[(k + input.length - 1) % input.length]!;
      const sc = side(cur);
      const sp = side(prev);
      if (sc >= 0) {
        if (sp < 0) output.push(intersect(prev, cur, sp, sc));
        output.push(cur);
      } else if (sp >= 0) {
        output.push(intersect(prev, cur, sp, sc));
      }
    }
  }
  return output;
}

function intersect(p: Vec2, q: Vec2, sp: number, sq: number): Vec2 {
  const t = sp / (sp - sq);
  return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
}

function triangles(polygon: readonly Vec2[]): Vec2[][] {
  const idx = triangulatePolygon(polygon);
  const out: Vec2[][] = [];
  for (let i = 0; i < idx.length; i += 3) {
    const tri: Vec2[] = [polygon[idx[i]!]!, polygon[idx[i + 1]!]!, polygon[idx[i + 2]!]!];
    // Normalise to counter-clockwise in math axes.
    const area2 =
      (tri[1]![0] - tri[0]![0]) * (tri[2]![1] - tri[0]![1]) - (tri[1]![1] - tri[0]![1]) * (tri[2]![0] - tri[0]![0]);
    out.push(area2 < 0 ? [tri[0]!, tri[2]!, tri[1]!] : tri);
  }
  return out;
}

/**
 * Overlap area of two simple polygons (concave allowed). Approach: triangulate both with
 * earcut, then sum the Sutherland–Hodgman clip of every triangle pair. Triangles are
 * convex and triangulations are interior-disjoint, so the sum is exact. Room counts are
 * tiny, so the O(n*m) cost is irrelevant.
 */
export function polygonOverlapArea(a: readonly Vec2[], b: readonly Vec2[]): number {
  return trianglesOverlapArea(triangles(a), triangles(b));
}

function trianglesOverlapArea(ta: Vec2[][], tb: Vec2[][]): number {
  let area = 0;
  for (const subject of ta) {
    for (const clip of tb) area += polygonArea(clipConvex(subject, clip));
  }
  return area;
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function boundsOf(polygon: readonly Vec2[]): Box {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const [x, y] of polygon) {
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  }
  return box;
}

/**
 * Positions (metres from `start`) along a wall where another wall ends on it, with the other
 * wall's half thickness, plus the wall's own two ends (half = 0).
 */
function junctionOffsets(scene: Scene, wallIndex: number): { s: number; half: number }[] {
  const wall = scene.walls[wallIndex]!;
  const length = wallLength(wall);
  const offsets = [
    { s: 0, half: 0 },
    { s: length, half: 0 },
  ];
  const dx = (wall.end[0] - wall.start[0]) / length;
  const dy = (wall.end[1] - wall.start[1]) / length;
  scene.walls.forEach((other, i) => {
    if (i === wallIndex) return;
    for (const p of [other.start, other.end]) {
      const s = (p[0] - wall.start[0]) * dx + (p[1] - wall.start[1]) * dy;
      if (s <= 0 || s >= length) continue; // already covered by the wall ends
      const d = Math.abs((p[0] - wall.start[0]) * dy - (p[1] - wall.start[1]) * dx);
      if (d <= wall.thickness / 2 + 0.01) offsets.push({ s, half: other.thickness / 2 });
    }
  });
  return offsets;
}

/**
 * Checks for issues that are legal but suspicious. Never throws; always returns warnings
 * in a deterministic order (openings, rooms, lights, items, layout, coordinates).
 */
export function validateScene(scene: Scene): ValidationResult {
  const warnings: ValidationWarning[] = [];

  // Openings close to a wall end or to a junction with another wall.
  const wallIndex = new Map(scene.walls.map((w, i) => [w.id, i]));
  const junctions = new Map<string, { s: number; half: number }[]>();
  scene.openings.forEach((opening, i) => {
    const wi = wallIndex.get(opening.wallId);
    if (wi === undefined) return;
    const wall = scene.walls[wi]!;
    let offsets = junctions.get(wall.id);
    if (!offsets) {
      offsets = junctionOffsets(scene, wi);
      junctions.set(wall.id, offsets);
    }
    const from = opening.offset - opening.width / 2;
    const to = opening.offset + opening.width / 2;
    const threshold = Math.max(wall.thickness / 2, 0.05);
    let nearest = Infinity;
    for (const j of offsets) nearest = Math.min(nearest, Math.max(from - (j.s + j.half), j.s - j.half - to, 0));
    if (nearest < threshold - 1e-9) {
      warnings.push({
        code: 'opening-near-junction',
        message: `opening "${opening.id}" is ${(nearest * 100).toFixed(1)} cm from a junction or end of wall "${wall.id}" (minimum ${(threshold * 100).toFixed(1)} cm)`,
        entityIds: [opening.id, wall.id],
        path: `openings[${i}]`,
      });
    }
  });

  // Room edges with no wall behind them, and overlapping rooms.
  scene.rooms.forEach((room, ri) => {
    const n = room.polygon.length;
    for (let k = 0; k < n; k++) {
      const a = room.polygon[k]!;
      const b = room.polygon[(k + 1) % n]!;
      const { uncovered } = edgeCoverage(scene.walls, a, b);
      if (uncovered > UNWALLED_TOLERANCE) {
        warnings.push({
          code: 'room-edge-unwalled',
          message: `room "${room.id}" edge ${k} (${a.join(', ')} to ${b.join(', ')}) has ${uncovered.toFixed(2)} m with no wall behind it (open plan)`,
          entityIds: [room.id],
          path: `rooms[${ri}].polygon[${k}]`,
        });
      }
    }
    // Floor zones that do nothing visible: too small to see, or the same material as the floor around them.
    room.floorZones?.forEach((zone, zi) => {
      const area = polygonArea(zone.polygon);
      if (area < FLOOR_ZONE_MIN_AREA) {
        warnings.push({
          code: 'floor-zone-tiny',
          message: `floor zone "${zone.id}" of room "${room.id}" is only ${(area * 1e4).toFixed(0)} cm²`,
          entityIds: [room.id],
          path: `rooms[${ri}].floorZones[${zi}]`,
        });
      } else if (zone.material === (room.floorMaterial ?? scene.defaults.floor)) {
        warnings.push({
          code: 'floor-zone-redundant',
          message: `floor zone "${zone.id}" of room "${room.id}" has the same material as the floor around it`,
          entityIds: [room.id],
          path: `rooms[${ri}].floorZones[${zi}]`,
        });
      }
    });
  });
  // Triangulate each room once and skip pairs whose bounding boxes do not intersect.
  const roomBounds = scene.rooms.map((r) => boundsOf(r.polygon));
  const roomTriangles: (Vec2[][] | undefined)[] = [];
  const trianglesOf = (i: number) => (roomTriangles[i] ??= triangles(scene.rooms[i]!.polygon));
  for (let i = 0; i < scene.rooms.length; i++) {
    for (let j = i + 1; j < scene.rooms.length; j++) {
      const p = roomBounds[i]!;
      const q = roomBounds[j]!;
      if (p.maxX < q.minX || q.maxX < p.minX || p.maxY < q.minY || q.maxY < p.minY) continue;
      const area = trianglesOverlapArea(trianglesOf(i), trianglesOf(j));
      if (area > OVERLAP_AREA_THRESHOLD) {
        warnings.push({
          code: 'rooms-overlap',
          message: `rooms "${scene.rooms[i]!.id}" and "${scene.rooms[j]!.id}" overlap by ${area.toFixed(2)} m²`,
          entityIds: [scene.rooms[i]!.id, scene.rooms[j]!.id],
          path: `rooms[${j}]`,
        });
      }
    }
  }

  // Lights outside every room, in the wrong room, or above the ceiling.
  scene.lights.forEach((light, i) => {
    const containing = scene.rooms.filter((r) => pointInPolygon(light.position, r.polygon));
    if (containing.length === 0) {
      warnings.push({
        code: 'light-outside-rooms',
        message: `light "${light.id}" at (${light.position.join(', ')}) is outside every room`,
        entityIds: [light.id],
        path: `lights[${i}]`,
      });
      return;
    }
    const declared = containing.find((r) => r.id === light.roomId);
    if (light.roomId !== undefined && !declared) {
      warnings.push({
        code: 'light-room-mismatch',
        message: `light "${light.id}" claims room "${light.roomId}" but sits in "${containing[0]!.id}"`,
        entityIds: [light.id, light.roomId],
        path: `lights[${i}].roomId`,
      });
    }
    const room = declared ?? containing[0]!;
    if (light.type === 'grid') {
      const outside = gridFixtures(light).filter((f) => !pointInPolygon(f, room.polygon)).length;
      if (outside > 0) {
        warnings.push({
          code: 'grid-outside-room',
          message: `${outside} of ${light.rows * light.cols} fixtures of grid "${light.id}" fall outside room "${room.id}" (their light would leak into the next room); resize it or use fitToRoom`,
          entityIds: [light.id, room.id],
          path: `lights[${i}]`,
        });
      }
    }
    // Balconies have no ceiling unless one is given explicitly.
    if (room.type === 'balcony' && room.ceilingHeight === undefined) return;
    const ceiling = roomCeilingHeight(scene, room);
    if (light.elevation > ceiling + 1e-9) {
      warnings.push({
        code: 'light-above-ceiling',
        message: `light "${light.id}" is at ${light.elevation} m, above the ${ceiling} m ceiling of room "${room.id}"`,
        entityIds: [light.id, room.id],
        path: `lights[${i}].elevation`,
      });
    }
  });

  // Items: unknown assets are drawn as placeholder boxes; non-legacy items should be backed by a product;
  // generator and product dims should agree with the item's dims.
  scene.items.forEach((item, i) => {
    const builtin = isBuiltinAsset(item.assetId);
    if (!builtin && !item.mesh) {
      warnings.push({
        code: 'unknown_asset',
        message: `item "${item.id}" uses unknown asset "${item.assetId}" (drawn as a placeholder box)`,
        entityIds: [item.id],
        path: `items[${i}].assetId`,
      });
    }
    // Legacy builtin:* items and locked existing furniture (e.g. built-in placards) have no product by design.
    if (!builtin && !item.locked && !item.concept && !item.product && !item.productRef) {
      warnings.push({
        code: 'missing_product',
        message: `item "${item.id}" is not backed by a product (no price, link or exact dimensions); place real products from search_products`,
        entityIds: [item.id],
        path: `items[${i}]`,
      });
    }
    if (item.mesh?.kind === 'parametric') {
      const check = checkParametricMesh(item.mesh, item.dims ?? item.product?.dims);
      if (check.status === 'unknown_generator') {
        warnings.push({
          code: 'unknown_generator',
          message: `item "${item.id}" uses generator "${check.generator}" which is not registered; its dimensions were not checked`,
          entityIds: [item.id],
          path: `items[${i}].mesh.generator`,
        });
      } else if (check.status === 'dims_mismatch' || check.status === 'invalid_params') {
        warnings.push({
          code: 'dims_mismatch',
          message: `item "${item.id}" does not match generator "${check.generator}"${check.status === 'invalid_params' ? `: ${check.issues.join('; ')}` : ' dimensions (more than 2% apart)'}`,
          entityIds: [item.id],
          path: `items[${i}].mesh`,
        });
      }
    }
    if (item.dims && item.product && !dimsClose(item.dims, item.product.dims)) {
      warnings.push({
        code: 'dims_mismatch',
        message: `item "${item.id}" dims differ by more than 2% from its product "${item.product.provider}:${item.product.sku}"`,
        entityIds: [item.id],
        path: `items[${i}].dims`,
      });
    }
  });

  // Layout rules (placement/validateLayout): items outside their room, overlapping, in a door swing, under a
  // window, hung over glazing or blocking the walkways. Locked (existing) items are not judged.
  if (scene.items.some((it) => it.locked !== true)) {
    const itemIndex = new Map(scene.items.map((it, i) => [it.id, i]));
    for (const v of validateLayout(scene).violations) {
      const first = v.entityIds.map((id) => itemIndex.get(id)).find((i) => i !== undefined);
      warnings.push({
        code: `layout_${v.code}`,
        message: v.message,
        entityIds: v.entityIds,
        ...(first !== undefined ? { path: `items[${first}]` } : {}),
      });
    }
  }

  // Absurd coordinates (usually a unit mistake, e.g. millimetres).
  const far = (points: readonly Vec2[]) => points.some((p) => Math.abs(p[0]) > MAX_COORDINATE || Math.abs(p[1]) > MAX_COORDINATE);
  const report = (kind: string, id: string, path: string) =>
    warnings.push({
      code: 'coordinates-out-of-range',
      message: `${kind} "${id}" has coordinates beyond ±${MAX_COORDINATE} m (wrong units?)`,
      entityIds: [id],
      path,
    });
  scene.walls.forEach((w, i) => far([w.start, w.end]) && report('wall', w.id, `walls[${i}]`));
  scene.rooms.forEach((r, i) => far(r.polygon) && report('room', r.id, `rooms[${i}].polygon`));
  scene.items.forEach((it, i) => far([it.position]) && report('item', it.id, `items[${i}].position`));
  scene.lights.forEach((l, i) => far([l.position]) && report('light', l.id, `lights[${i}].position`));

  return { warnings };
}
