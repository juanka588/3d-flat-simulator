import { BUILTIN_ASSETS } from '../items/builtin-assets';
import { roomCeilingHeight } from '../geometry/floors';
import { polygonArea } from '../measure';
import type { Item, Light, LinkableLight, Room, RoomType, Scene, Vec2 } from '../schema';
import { pointInPolygon } from '../validate';
import { rotatePlan } from './grid';

/**
 * Lamp maths shared by the command layer (linked lamp items, grid fitting), `describe_room` (the lighting
 * plan) and the viewer (grid clusters, room bounce). Pure; no three.js. Units: metres, degrees, lumens, lux.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- totals ------------------------------------------------------------------------------------

/** Fixtures a light stands for: rows x cols for a grid, else 1. */
export function lightFixtureCount(light: Light): number {
  return light.type === 'grid' ? light.rows * light.cols : 1;
}

/** Total luminous flux of a light in lumens (a grid: rows x cols x lumensEach). */
export function lightLumens(light: Light): number {
  return light.type === 'grid' ? light.rows * light.cols * light.lumensEach : light.lumens;
}

/** The lumen figure a view override `lumens` (a TOTAL) turns into on the light's own field: per fixture for a grid. */
export function lumensPatchFor(light: Light, totalLumens: number): { lumens: number } | { lumensEach: number } {
  return light.type === 'grid' ? { lumensEach: totalLumens / lightFixtureCount(light) } : { lumens: totalLumens };
}

// ---- rooms -------------------------------------------------------------------------------------

/** The room a light belongs to: its `roomId`, else the room containing its position. */
export function roomIdOfLight(scene: Pick<Scene, 'rooms'>, light: Pick<Light, 'roomId' | 'position'>): string | undefined {
  if (light.roomId !== undefined) return light.roomId;
  return scene.rooms.find((r) => pointInPolygon(light.position, r.polygon))?.id;
}

function polygonPerimeter(polygon: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum;
}

/** Total area of the surfaces enclosing a room: floor + ceiling + walls (m2). */
export function roomSurfaceArea(scene: Pick<Scene, 'walls'>, room: Room): number {
  return 2 * polygonArea(room.polygon) + polygonPerimeter(room.polygon) * roomCeilingHeight(scene, room);
}

/**
 * Mean reflectance of the room surfaces seen by the lamp bounce (white ceiling about 0.8, painted walls 0.6,
 * floor 0.3 give about 0.5). One constant: the bounce is an approximation, not a radiosity solution.
 */
export const LAMP_BOUNCE_ALBEDO = 0.5;

/**
 * Average inter-reflected ("bounce") illuminance in a room lit by `fluxLm` lumens, in lux. The flux first
 * lands on the room surfaces, a share `rho` of it is reflected and spread over all surfaces `area`; summing
 * the reflections gives `E = rho x flux / (area x (1 - rho))` (the standard "average interreflected
 * illuminance" of the integrating-sphere model). Local to the room: only the flux of ITS lamps counts.
 */
export function lampBounceLux(fluxLm: number, surfaceAreaM2: number, rho: number = LAMP_BOUNCE_ALBEDO): number {
  if (!(fluxLm > 0) || !(surfaceAreaM2 > 0)) return 0;
  const r = Math.min(Math.max(rho, 0), 0.95);
  return (r * fluxLm) / (surfaceAreaM2 * (1 - r));
}

/** Minimal lamp shape for the room totals: where it is and how much it emits now (view overrides already applied). */
export interface FluxSource {
  roomId?: string | undefined;
  position: Vec2;
  /** Total flux in lumens, 0 or `on = false` for a lamp that is off. */
  lumens: number;
  on: boolean;
}

/** Lamp flux (lumens, lamps that are on) per room id; lamps outside every room count for no room. */
export function roomLampFlux(scene: Pick<Scene, 'rooms'>, sources: readonly FluxSource[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) {
    if (!s.on || !(s.lumens > 0)) continue;
    const id = roomIdOfLight(scene, s);
    if (id !== undefined) out[id] = (out[id] ?? 0) + s.lumens;
  }
  return out;
}

/** Bounce illuminance (lux) per room, from that room's own lamp flux only. Rooms without lit lamps are absent. */
export function roomBounceLux(scene: Pick<Scene, 'rooms' | 'walls'>, sources: readonly FluxSource[], rho: number = LAMP_BOUNCE_ALBEDO): Record<string, number> {
  const flux = roomLampFlux(scene, sources);
  const out: Record<string, number> = {};
  for (const room of scene.rooms) {
    const f = flux[room.id];
    if (f !== undefined) out[room.id] = lampBounceLux(f, roomSurfaceArea(scene, room), rho);
  }
  return out;
}

// ---- fitting a grid to a room ------------------------------------------------------------------

export interface GridFit {
  position: Vec2;
  width: number;
  depth: number;
  elevation: number;
}

const MAX_CANDIDATES = 14;

function axisCandidates(values: number[]): number[] {
  const u = [...new Set(values.map((v) => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b);
  if (u.length <= MAX_CANDIDATES) return u;
  const step = (u.length - 1) / (MAX_CANDIDATES - 1);
  return Array.from({ length: MAX_CANDIDATES }, (_, i) => u[Math.round(i * step)]!);
}

function rectInside(polygon: readonly Vec2[], x0: number, y0: number, x1: number, y1: number): boolean {
  const N = 4;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      if (!pointInPolygon([x0 + ((x1 - x0) * i) / N, y0 + ((y1 - y0) * j) / N], polygon, 1e-6)) return false;
    }
  }
  // a notch of the polygon poking into the rectangle
  return !polygon.some(([px, py]) => px > x0 + 1e-6 && px < x1 - 1e-6 && py > y0 + 1e-6 && py < y1 - 1e-6);
}

/** The largest axis-aligned rectangle inside a polygon (exact for rectilinear rooms), as `[x0, y0, x1, y1]`. */
export function largestInscribedRect(polygon: readonly Vec2[]): [number, number, number, number] | undefined {
  const xs = axisCandidates(polygon.map((p) => p[0]));
  const ys = axisCandidates(polygon.map((p) => p[1]));
  let best: [number, number, number, number] | undefined;
  let bestArea = 0;
  for (let a = 0; a < xs.length; a++) {
    for (let b = a + 1; b < xs.length; b++) {
      for (let c = 0; c < ys.length; c++) {
        for (let d = c + 1; d < ys.length; d++) {
          const area = (xs[b]! - xs[a]!) * (ys[d]! - ys[c]!);
          if (area <= bestArea) continue;
          if (rectInside(polygon, xs[a]!, ys[c]!, xs[b]!, ys[d]!)) {
            best = [xs[a]!, ys[c]!, xs[b]!, ys[d]!];
            bestArea = area;
          }
        }
      }
    }
  }
  return best;
}

/** Ceiling-recessed height of a downlight grid in a room: 3 cm below the ceiling. */
export const GRID_DROP_M = 0.03;

/** Position, size and height of a grid that covers the largest rectangle of a room (rotation 0). */
export function fitGridToRoom(scene: Pick<Scene, 'walls'>, room: Room): GridFit | undefined {
  const rect = largestInscribedRect(room.polygon);
  if (!rect) return undefined;
  const [x0, y0, x1, y1] = rect;
  return {
    position: [r2((x0 + x1) / 2), r2((y0 + y1) / 2)],
    width: r2(x1 - x0),
    depth: r2(y1 - y0),
    elevation: r2(Math.max(0, roomCeilingHeight(scene, room) - GRID_DROP_M)),
  };
}

// ---- lighting plan -----------------------------------------------------------------------------

/** Recommended average illuminance on the floor / work plane per room type, in lux. */
export const LIGHTING_TARGETS: Record<RoomType, { min: number; max: number; note: string }> = {
  living: { min: 100, max: 150, note: 'add task lamps to read' },
  kitchen: { min: 200, max: 300, note: 'light the worktop' },
  dining: { min: 100, max: 200, note: 'soft ambient light over the table' },
  bedroom: { min: 100, max: 150, note: 'ambient 100 lux; reading lamps for the bed' },
  bathroom: { min: 150, max: 250, note: 'about 200 lux, brighter (neutral white, 3000-4000 K) at the mirror' },
  hallway: { min: 100, max: 150, note: 'passage light, evenly spread' },
  office: { min: 300, max: 500, note: 'desk work wants 300-500 lux, neutral white' },
  storage: { min: 75, max: 150, note: 'low use; 100 lux is plenty' },
  balcony: { min: 20, max: 75, note: 'atmosphere only' },
  other: { min: 100, max: 200, note: 'general default' },
};

/** Utilisation factor of the lumen method: the share of lamp flux that ends up on the floor/work plane (direct + bounce). */
export const UTILISATION_FACTOR = 0.5;

/** Mean horizontal illuminance on the floor for `lumens` in a room of `areaM2`, lux (lumen method). */
export function estimatedLux(lumens: number, areaM2: number): number {
  return areaM2 > 0 ? (lumens * UTILISATION_FACTOR) / areaM2 : 0;
}

/** Lumens a room of `areaM2` needs for `lux` on the floor (lumen method). */
export function lumensForLux(lux: number, areaM2: number): number {
  return (lux * areaM2) / UTILISATION_FACTOR;
}

/** Typical downlight pitch used to suggest a grid, metres. */
const SUGGESTED_PITCH_M = 1.5;
/** Typical LED downlight flux for rounding the suggestion (a 6 W fixture is about 450 lm). */
const FIXTURE_STEP_LM = 10;

export interface LightingPlan {
  roomType: RoomType;
  areaM2: number;
  targetLux: { min: number; max: number };
  note: string;
  /** Flux of the lights that are on in this room, lumens. */
  litLumens: number;
  /** Flux of all lights of the room, on or off. */
  installedLumens: number;
  estimatedLux: number;
  status: 'below' | 'within' | 'above' | 'dark';
  /** A grid of downlights covering the largest rectangle of the room at the middle of the target, or null when none fits. */
  suggestedGrid: { rows: number; cols: number; lumensEach: number } | null;
}

/** The `lighting_plan` of `describe_room`: target illuminance for the room type, what the lights give now, and a grid to reach it. */
export function roomLightingPlan(scene: Pick<Scene, 'walls'>, room: Room, lights: readonly { lumens: number; on: boolean }[]): LightingPlan {
  const area = polygonArea(room.polygon);
  const target = LIGHTING_TARGETS[room.type];
  const lit = lights.reduce((sum, l) => sum + (l.on ? l.lumens : 0), 0);
  const installed = lights.reduce((sum, l) => sum + l.lumens, 0);
  const lux = estimatedLux(lit, area);
  const fit = fitGridToRoom(scene, room);
  let suggestedGrid: LightingPlan['suggestedGrid'] = null;
  if (fit) {
    const cols = Math.max(1, Math.min(10, Math.round(fit.width / SUGGESTED_PITCH_M)));
    const rows = Math.max(1, Math.min(10, Math.round(fit.depth / SUGGESTED_PITCH_M)));
    const mid = (target.min + target.max) / 2;
    const each = Math.max(FIXTURE_STEP_LM, Math.round(lumensForLux(mid, area) / (rows * cols) / FIXTURE_STEP_LM) * FIXTURE_STEP_LM);
    suggestedGrid = { rows, cols, lumensEach: each };
  }
  return {
    roomType: room.type,
    areaM2: r2(area),
    targetLux: { min: target.min, max: target.max },
    note: target.note,
    litLumens: Math.round(lit),
    installedLumens: Math.round(installed),
    estimatedLux: Math.round(lux),
    status: lit <= 0 ? 'dark' : lux < target.min * 0.9 ? 'below' : lux > target.max * 1.1 ? 'above' : 'within',
    suggestedGrid,
  };
}

// ---- lamp items --------------------------------------------------------------------------------

export type LampKind = 'floor' | 'table' | 'pendant' | 'ceiling' | 'wall';

/** Flux assumed for a lamp whose product page does not state it, per kind (a warm 2700 K bulb). */
export const DEFAULT_LAMP_LUMENS: Record<LampKind, number> = { floor: 800, table: 400, pendant: 1000, ceiling: 1000, wall: 400 };
/** Colour temperature assumed for lamp items. */
export const DEFAULT_LAMP_KELVIN = 2700;

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** True when the item is a lamp: a product of category `lamp` or a builtin asset of category `lamp`. */
export function isLampItem(item: Pick<Item, 'assetId' | 'product'>): boolean {
  return item.product?.category === 'lamp' || BUILTIN_ASSETS[item.assetId]?.category === 'lamp';
}

/**
 * What kind of lamp an item is, from its mount and its product name (French and English), else from its height.
 * `undefined` when the item is not a lamp.
 */
export function lampKindOf(item: Pick<Item, 'assetId' | 'product' | 'mount' | 'dims'>): LampKind | undefined {
  if (!isLampItem(item)) return undefined;
  const name = fold(item.product?.name ?? '');
  const mount = item.mount ?? BUILTIN_ASSETS[item.assetId]?.mount ?? 'floor';
  const h = (item.dims ?? item.product?.dims)?.h ?? 0.5;
  if (/plafonnier|ceiling lamp|ceiling light|downlight|encastr/.test(name)) return 'ceiling';
  if (mount === 'ceiling' || /suspension|pendant|hanging|lustre|chandelier/.test(name)) return 'pendant';
  if (mount === 'wall' || /applique|wall lamp|wall light|sconce/.test(name)) return 'wall';
  if (/lampadaire|floor lamp|floor light|standing|tripod|arc lamp/.test(name)) return 'floor';
  if (/lampe de table|table lamp|bureau|desk|chevet|bedside|poser|veilleuse|reading/.test(name)) return 'table';
  return h > 1 ? 'floor' : 'table';
}

/** Height of the bulb above the item's bottom, in metres, for a lamp of kind `kind` and height `h`. */
export function bulbHeight(kind: LampKind, h: number): number {
  switch (kind) {
    case 'floor': return Math.max(0.3, h * 0.92);
    case 'table': return Math.max(0.1, h * 0.8);
    case 'pendant': return Math.min(0.25, Math.max(0.05, h * 0.4));
    case 'ceiling': return Math.max(0.04, Math.min(0.12, h * 0.4));
    case 'wall': return Math.max(0.1, h * 0.5);
  }
}

/** Plan position and height of the bulb of an item's linked light: the offset is in the item frame and turns with the item. */
export function linkedLightPose(item: Pick<Item, 'position' | 'rotation' | 'elevation'>, offset: readonly [number, number, number]): { position: Vec2; elevation: number } {
  const [dx, dy] = rotatePlan(offset[0], offset[1], item.rotation);
  return { position: [item.position[0] + dx, item.position[1] + dy], elevation: item.elevation + offset[2] };
}

export interface LampEmitter {
  kind: LampKind;
  lumens: number;
  lumensSource: 'product' | 'estimated';
  kelvin: number;
  offset: [number, number, number];
}

/** The light a lamp item gets by default: the product's lumens when the page states them, else the category default at 2700 K. */
export function lampEmitterFor(item: Pick<Item, 'assetId' | 'product' | 'mount' | 'dims'>): LampEmitter | undefined {
  const kind = lampKindOf(item);
  if (!kind) return undefined;
  const dims = item.dims ?? item.product?.dims;
  const productLumens = item.product?.lumens;
  return {
    kind,
    lumens: productLumens ?? DEFAULT_LAMP_LUMENS[kind],
    lumensSource: productLumens !== undefined ? 'product' : 'estimated',
    kelvin: DEFAULT_LAMP_KELVIN,
    offset: [0, 0, r2(bulbHeight(kind, dims?.h ?? 0.5))],
  };
}

/** The linked light of a lamp item, as the item commands create it (`id` is chosen by the caller). */
export function linkedLightFor(item: Item, id: string, roomId: string | undefined, displayName: string | undefined): LinkableLight | undefined {
  const emitter = lampEmitterFor(item);
  if (!emitter) return undefined;
  const pose = linkedLightPose(item, emitter.offset);
  return {
    id,
    type: 'point',
    ...(displayName ? { name: displayName.slice(0, 120) } : {}),
    ...(roomId !== undefined ? { roomId } : {}),
    position: pose.position,
    elevation: pose.elevation,
    lumens: emitter.lumens,
    kelvin: emitter.kelvin,
    on: true,
    itemId: item.id,
    offset: emitter.offset,
    lumensSource: emitter.lumensSource,
  };
}
