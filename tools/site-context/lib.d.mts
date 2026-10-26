export type Pt = [number, number];
export interface Rect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
export interface ContextBuildingLike {
  id: string;
  footprint: Pt[];
  holes?: Pt[][];
  base: number;
  height: number;
  host: boolean;
}
export const R_EARTH: number;
export const DEG: number;
export function toEnu(lat: number, lon: number, lat0: number, lon0: number): Pt;
export function fromEnu(e: number, n: number, lat0: number, lon0: number): Pt;
export function planBasis(bx: number): { ex: Pt; ey: Pt };
export function signedArea(p: readonly Pt[]): number;
export function cleanRing(ring: readonly Pt[], eps?: number): Pt[];
export function subtractRect(poly: Pt[], r: Rect): Pt[][];
export function pointInRing(pt: Pt, ring: readonly Pt[]): boolean;
export function dominantBearing(ring: readonly Pt[]): number;
export const wrap360: (a: number) => number;
export const wrap180: (a: number) => number;
export const round: (v: number, d: number) => number;
export const compass: (bearing: number) => string;
export interface RingEntry {
  key: string;
  featureId: string;
  part: number | null;
  props: Record<string, unknown>;
  lonlat: Pt[];
  holes: Pt[][];
}
export function extractRings(geojson: unknown): { rings: RingEntry[]; skipped: unknown[] };
export function anchorOrigin(box: Rect, anchor: 'nw' | 'ne' | 'sw' | 'se', inset: number, envelope: Rect): Pt;
export function hostBands(args: {
  id: string;
  footprint: Pt[];
  holes?: Pt[][];
  base: number;
  height: number;
  storeyBase: number;
  storeyTop: number;
  flatCut: Rect;
}): ContextBuildingLike[];
export function validateContext(ctx: unknown): string[];
export function getJson(
  url: string,
  label: string,
  options?: {
    fetchImpl?: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
  },
): Promise<unknown>;
