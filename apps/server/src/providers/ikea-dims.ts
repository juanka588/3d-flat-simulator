import type { ProductCategory } from '@flat/scene';
import { fold } from './category';
import { parseLength, parseMeasureText } from './units';

/**
 * Assembled dimensions of the IKEA product types whose page has no "width / depth / height" triple:
 * rugs and throws list "Longueur / Largeur", curtains "Longueur (the drop) / Largeur/rideau", cushions "Longueur / Largeur",
 * plants and vases "Diamètre / Hauteur", picture frames "Hauteur structure / Largeur / Prof. structure".
 * Missing sizes that a flat thing has anyway (a rug is about 1 cm thick) are conventional constants, listed below.
 */

const ROW_RE = /measurement-name">([^<]+)<\/span><span class="[^"]*measurement-value">([^<]+)<\/span>/g;

/** Every length row of the page's dimension section, by accent-folded lower-case label, in metres (the first row of a label wins). */
export function parseMeasurementMap(html: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of html.matchAll(ROW_RE)) {
    const label = fold(m[1]!.trim());
    const v = parseLength(m[2]!, 'cm');
    if (v !== undefined && !out.has(label)) out.set(label, v);
  }
  return out;
}

/** Thickness of a rug (m). */
export const RUG_THICKNESS_M = 0.01;
/** Thickness of a throw lying flat (m). */
export const THROW_THICKNESS_M = 0.02;
/** Depth of a curtain panel or a blind hanging from its rail (m). */
export const CURTAIN_DEPTH_M = 0.05;
/** Depth of a picture frame when the page does not state it (m). */
export const FRAME_DEPTH_M = 0.03;
/** Outer margin a frame adds around the picture the listing names ("50x70 cm"), per side (m). */
const FRAME_MARGIN_M = 0.01;

type Rows = ReadonlyMap<string, number>;

/** The first row whose label matches the patterns, tried in order (a pattern earlier in the list wins). */
function pick(rows: Rows, ...patterns: RegExp[]): number | undefined {
  for (const re of patterns) for (const [label, v] of rows) if (re.test(label)) return v;
  return undefined;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface DerivedDims {
  dims: { w: number; d: number; h: number };
  /** `structured`: read from the page's rows; `text`: from the listing's size text ("160x230 cm"). */
  source: 'structured' | 'text';
}

/**
 * Width x depth x height of a product of `category` from the page rows and, failing that, the listing's size text.
 * `undefined` when the category has no such rule or the sizes are not there.
 */
export function deriveDims(category: ProductCategory, rows: Rows, measureText: string): DerivedDims | undefined {
  const text = parseMeasureText(measureText);
  const ok = (w: number | undefined, d: number | undefined, h: number | undefined, source: 'structured' | 'text'): DerivedDims | undefined =>
    w !== undefined && d !== undefined && h !== undefined && w > 0 && d > 0 && h > 0 ? { dims: { w: round3(w), d: round3(d), h: round3(h) }, source } : undefined;
  switch (category) {
    case 'rug':
    case 'throw': {
      const thick = category === 'rug' ? RUG_THICKNESS_M : THROW_THICKNESS_M;
      const round = pick(rows, /^diametre/);
      if (round !== undefined) return ok(round, round, thick, 'structured');
      const w = pick(rows, /^largeur$/);
      const l = pick(rows, /^longueur$/);
      if (w !== undefined && l !== undefined) return ok(w, l, thick, 'structured');
      if (text.length === 1) return ok(text[0], text[0], thick, 'text');
      return text.length >= 2 ? ok(text[0], text[1], thick, 'text') : undefined;
    }
    case 'cushion': {
      const round = pick(rows, /^diametre/);
      const w = round ?? pick(rows, /^largeur$/);
      const l = round ?? pick(rows, /^longueur$/);
      const src: 'structured' | 'text' = w !== undefined && l !== undefined ? 'structured' : 'text';
      const a = w ?? text[0];
      const b = l ?? text[1] ?? text[0];
      // a pillow is about a quarter as thick as it is wide
      const thick = a !== undefined && b !== undefined ? Math.min(0.15, Math.max(0.08, 0.25 * Math.min(a, b))) : undefined;
      return ok(a, b, thick, src);
    }
    case 'curtain': {
      const w = pick(rows, /^largeur\/rideau/, /^largeur\/panneau/, /^largeur$/);
      const drop = pick(rows, /^longueur$/, /^hauteur$/);
      if (w !== undefined && drop !== undefined) return ok(w, CURTAIN_DEPTH_M, drop, 'structured');
      return text.length >= 2 ? ok(text[0], CURTAIN_DEPTH_M, text[1], 'text') : undefined;
    }
    case 'plant':
    case 'vase': {
      const dia = pick(rows, /^diametre du pot/, /^diametre exterieur/, /^diametre$/, /^diametre/);
      const h = pick(rows, /^hauteur de la plante/, /^hauteur$/, /^hauteur/);
      if (dia !== undefined && h !== undefined) return ok(dia, dia, h, 'structured');
      const w = pick(rows, /^largeur$/);
      const d = pick(rows, /^profondeur$/);
      if (h !== undefined && w !== undefined && d !== undefined) return ok(w, d, h, 'structured');
      return undefined; // a listing's single number is the pot width, not the height
    }
    case 'frame': {
      const w = pick(rows, /^largeur$/, /^largeur structure/);
      const h = pick(rows, /^hauteur structure/, /^hauteur$/);
      const d = pick(rows, /^prof\.? structure/, /^profondeur/) ?? FRAME_DEPTH_M;
      if (w !== undefined && h !== undefined) return ok(w, d, h, 'structured');
      // the listing names the picture ("50x70 cm"); the frame is a little bigger all round
      return text.length >= 2 ? ok(text[0]! + 2 * FRAME_MARGIN_M, d, text[1]! + 2 * FRAME_MARGIN_M, 'text') : undefined;
    }
    default:
      return undefined;
  }
}
