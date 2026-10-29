import type { DescriptorItem } from './descriptor';
import { colourTokens, materialTokens, tokenSet, tokens } from './vocab';

/**
 * Ranking of catalogue products and library shapes against one descriptor item (CG4): a combined score of category match,
 * size within tolerance, colour / material / shape word overlap and the CLIP similarity of the crop, plus a fit verdict with
 * reasons. Pure: the tools feed it text-search hits and CLIP hits.
 */

export interface Candidate {
  kind: 'product' | 'asset';
  /** `ikea-fr:<sku>` or the library asset id. */
  id: string;
  name: string;
  category?: string | undefined;
  price?: number | undefined;
  currency?: string | undefined;
  dims?: { w: number; d: number; h: number } | undefined;
  /** Colour names of the product (French or English); unknown for CLIP-only hits. */
  colours?: string[] | undefined;
  styleTags?: string[] | undefined;
  has3d: boolean;
  /** CLIP cosine similarity of the crop with the photo, when the index answered. */
  clip?: number | undefined;
  /** 0-based rank in the text search, when the text search found it. */
  textRank?: number | undefined;
}

export type Aspect = 'shape' | 'colour' | 'size' | 'missing';
export interface Reason {
  aspect: Aspect;
  detail: string;
}
export type Verdict = 'good' | 'approx' | 'none';

export interface Scored {
  candidate: Candidate;
  score: number;
  parts: { category: number; size: number; tags: number; clip: number | null; text: number };
  /** Largest relative size error over width / depth (either way round) and height; `undefined` when the candidate has no dims. */
  sizeError?: number | undefined;
  colourMatch: boolean | 'unknown';
}

/** Relative size error up to which a product counts as the right size. */
export const SIZE_TOLERANCE = 0.25;
/** Beyond this error a product is the wrong size altogether. */
export const SIZE_REJECT = 0.6;
/** CLIP cosine range mapped to 0..1 (photos of the same kind of object sit around 0.25-0.35, unrelated ones near 0.1). */
export const CLIP_LOW = 0.12;
export const CLIP_HIGH = 0.34;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function sizeErrorOf(want: { w: number; d: number; h: number }, have: { w: number; d: number; h: number }): number {
  // relative to the wanted size, but never to less than 10 cm: a 3 cm mirror frame is not 25% off a 4 cm one
  const e = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 0.1);
  const flat = Math.max(e(have.w, want.w), e(have.d, want.d));
  const turned = Math.max(e(have.w, want.d), e(have.d, want.w));
  return Math.max(Math.min(flat, turned), e(have.h, want.h));
}

function categoryScore(item: DescriptorItem, c: Candidate): number {
  if (item.category === 'other') {
    const want = tokenSet(`${item.subtype} ${(item.searchTerms ?? []).join(' ')}`);
    const have = tokenSet(`${c.name} ${c.category ?? ''}`);
    if ([...want].some((w) => have.has(w))) return 1;
    // sanitary ware has no category of its own: another specific category (a desk, a chair) is plainly wrong
    return c.category && c.category !== 'other' ? 0 : 0.2;
  }
  if (!c.category) return 0.5;
  if (c.category === item.category) return 1;
  // sofa and armchair, drawers and sideboard, bedside and table, ... are near neighbours
  const near: [string, string][] = [['sofa', 'armchair'], ['drawers', 'sideboard'], ['bedside', 'table'], ['tv_unit', 'sideboard'], ['shelf', 'sideboard'], ['chair', 'armchair'], ['wall_cabinet', 'kitchen']];
  return near.some(([a, b]) => (a === item.category && b === c.category) || (b === item.category && a === c.category)) ? 0.5 : 0;
}

function tagScore(item: DescriptorItem, c: Candidate): { score: number; colourMatch: boolean | 'unknown' } {
  const wantColours = colourTokens(item.colour);
  const wantMaterials = materialTokens(item.material);
  const wantShape = tokens(`${item.subtype} ${item.shape}`).filter((t) => !colourTokens(t).length);
  const haveText = tokens(`${c.name} ${(c.colours ?? []).join(' ')} ${(c.styleTags ?? []).join(' ')}`);
  const have = new Set(haveText);
  const colourKnown = (c.colours?.length ?? 0) > 0 || colourTokens(c.name).length > 0;
  const haveColours = new Set([...colourTokens((c.colours ?? []).join(' ')), ...colourTokens(c.name)]);
  const colourMatch: boolean | 'unknown' = wantColours.length === 0 || !colourKnown ? 'unknown' : wantColours.some((w) => haveColours.has(w));
  const parts: number[] = [];
  if (wantColours.length) parts.push(colourMatch === true ? 1 : colourMatch === 'unknown' ? 0.4 : 0);
  if (wantMaterials.length) parts.push(wantMaterials.some((w) => have.has(w)) ? 1 : 0.3);
  if (wantShape.length) parts.push(wantShape.some((w) => have.has(w)) ? 1 : 0.2);
  return { score: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0.5, colourMatch };
}

/** Weights; with no CLIP answer the other parts are scaled up to fill its share. */
const W = { category: 0.22, size: 0.2, tags: 0.2, clip: 0.28, text: 0.1 };

export function scoreCandidate(item: DescriptorItem, c: Candidate, textCount: number): Scored {
  const category = categoryScore(item, c);
  const sizeError = c.dims ? sizeErrorOf(item.approxDims, c.dims) : undefined;
  const size = sizeError === undefined ? 0.5 : clamp01(1 - sizeError / SIZE_REJECT);
  const tag = tagScore(item, c);
  const clip = c.clip === undefined ? null : clamp01((c.clip - CLIP_LOW) / (CLIP_HIGH - CLIP_LOW));
  const text = c.textRank === undefined ? 0 : clamp01(1 - c.textRank / Math.max(1, textCount));
  const total = W.category + W.size + W.tags + W.text + (clip === null ? 0 : W.clip);
  const raw = W.category * category + W.size * size + W.tags * tag.score + W.text * text + (clip === null ? 0 : W.clip * clip);
  // a wrong category cannot be rescued by a good picture
  const score = (raw / total) * (category === 0 ? 0.5 : 1);
  return { candidate: c, score: Math.round(score * 1000) / 1000, parts: { category, size, tags: tag.score, clip, text }, sizeError, colourMatch: tag.colourMatch };
}

/** Scores and sorts (best first; ties by name for determinism). */
export function rankCandidates(item: DescriptorItem, candidates: readonly Candidate[]): Scored[] {
  const textCount = candidates.filter((c) => c.textRank !== undefined).length;
  return candidates.map((c) => scoreCandidate(item, c, textCount)).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
}

/** Fit of the best PRODUCT for the item: good / approx / none and the reasons it falls short (shape, colour, size, missing). */
export function fitVerdict(item: DescriptorItem, best: Scored | undefined): { verdict: Verdict; reasons: Reason[] } {
  if (!best) return { verdict: 'none', reasons: [{ aspect: 'missing', detail: `no product found for "${item.subtype}"` }] };
  const reasons: Reason[] = [];
  const c = best.candidate;
  if (best.parts.category === 0) reasons.push({ aspect: 'missing', detail: `the closest product is a ${c.category ?? 'different kind of item'}, not a ${item.category === 'other' ? item.subtype : item.category}` });
  if (best.sizeError !== undefined && best.sizeError > SIZE_TOLERANCE && c.dims) {
    const cm = (v: number) => Math.round(v * 100);
    reasons.push({ aspect: 'size', detail: `${cm(c.dims.w)}x${cm(c.dims.d)}x${cm(c.dims.h)} cm against about ${cm(item.approxDims.w)}x${cm(item.approxDims.d)}x${cm(item.approxDims.h)} cm (${Math.round(best.sizeError * 100)}% off)` });
  }
  if (best.colourMatch === false) reasons.push({ aspect: 'colour', detail: `wanted ${item.colour}; the product is ${(c.colours?.length ? c.colours : [c.name]).slice(0, 3).join(', ')}` });
  const clip = best.parts.clip;
  const shapeWords = tokens(`${item.subtype} ${item.shape}`).filter((t) => !colourTokens(t).length && !materialTokens(t).length);
  const have = tokenSet(`${c.name} ${(c.styleTags ?? []).join(' ')}`);
  const shapeSeen = shapeWords.length === 0 || shapeWords.some((w) => have.has(w));
  if ((clip !== null && clip < 0.35) || (clip === null && best.parts.category > 0 && !shapeSeen && best.parts.tags < 0.5)) {
    reasons.push({ aspect: 'shape', detail: clip !== null ? `the picture of the product does not look like the target (similarity ${Math.round(clip * 100)}%)` : `nothing in the product's name or tags matches "${item.shape}"` });
  }
  const tooSmallScore = best.score < 0.35;
  const wrongSize = best.sizeError !== undefined && best.sizeError > SIZE_REJECT;
  if (best.parts.category === 0 || tooSmallScore || wrongSize) return { verdict: 'none', reasons: reasons.length ? reasons : [{ aspect: 'missing', detail: 'no product is close enough' }] };
  if (reasons.length === 0 && best.score >= 0.6) return { verdict: 'good', reasons };
  return { verdict: 'approx', reasons: reasons.length ? reasons : [{ aspect: 'shape', detail: 'close, but not confirmed by name, colour or picture' }] };
}
