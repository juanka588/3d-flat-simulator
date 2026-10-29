import type { MeshAsset } from '@flat/assets';
import type { DescriptorItem, ReferenceDescriptor } from './descriptor';
import { itemPhrase } from './descriptor';
import type { PlanHint } from './depth';
import { fitVerdict, rankCandidates, type Candidate, type Reason, type Scored, type Verdict } from './rank';
import { suggestGenerator, type GeneratorSuggestion } from './suggest';
import { FRENCH_ADJECTIVES, colourTokens, materialTokens, tokens, toFrench } from './vocab';

/**
 * The recorded descriptor of a reference image, the matcher and the gap report (CG4). The matcher is written against small
 * ports (`MatchPorts`) so the ranking can be tested with a fake index and fake shop; the MCP tools wire the real ones.
 */

// -- store ---------------------------------------------------------------------------------------------------------------

export interface StoredReference {
  jobId: string;
  index: number;
  roomId?: string | undefined;
  styleId?: string | undefined;
  descriptor: ReferenceDescriptor;
  /** Plan hints by item id (from our depth), or why there are none. */
  plan: Record<string, PlanHint | null>;
  planStatus: string;
  matches?: ItemMatch[] | undefined;
}

/**
 * Descriptors are kept in the memory of the MCP process, keyed by job and image. They are small working state of one design
 * session, like the `generate_reference` job table; a file store would add a path-safety surface and stale data for no
 * gain (re-recording after a restart is one call). Bounded; oldest first out.
 */
const store = new Map<string, StoredReference>();
const MAX_STORED = 50;
export const referenceKey = (jobId: string, index: number) => `${jobId}:${index}`;
export function putReference(r: StoredReference): void {
  const k = referenceKey(r.jobId, r.index);
  store.delete(k);
  store.set(k, r);
  if (store.size > MAX_STORED) store.delete(store.keys().next().value as string);
}
export const getReference = (jobId: string, index: number): StoredReference | undefined => store.get(referenceKey(jobId, index));
export const clearReferences = (): void => store.clear();

// -- matcher -------------------------------------------------------------------------------------------------------------

export interface MatchPorts {
  /** Text search in the catalogue (local first); products with their facts. */
  searchProducts(q: string, category: string | undefined, limit: number): Promise<Candidate[] | { error: string }>;
  /** CLIP similarity of the crop (and the text) over the catalogue photos and the HD library. */
  clip(item: DescriptorItem, topK: number): Promise<Candidate[] | { error: string }>;
  /** The CC0 / HD library. */
  assets(): readonly MeshAsset[];
}

export interface ItemMatch {
  itemId: string;
  verdict: Verdict;
  reasons: Reason[];
  /** Top products first, then library shapes; `score` 0..1. */
  candidates: Scored[];
  /** The best real PRODUCT (the verdict is about it). */
  best?: Scored | undefined;
  generator: GeneratorSuggestion | null;
  generatorWhy?: string | undefined;
  /** Search phrases used, and the one to try next in the shop. */
  searched: string[];
  suggestedSearch: string;
  /** The tool could not search this item (rate limit). */
  pending?: string | undefined;
}

export interface MatchRun {
  items: ItemMatch[];
  clip: 'used' | { unavailable: string };
  text: 'used' | { unavailable: string };
}

const TOP_PRODUCTS = 3;
const TOP_ASSETS = 1;

/** Search phrases for one item: the model's own (French) terms first, then a translation of its subtype with colour and material. */
export function searchPhrases(it: DescriptorItem): string[] {
  const own = it.searchTerms ?? [];
  const core = tokens(it.subtype).filter((t) => !colourTokens(t).length && !materialTokens(t).length);
  core.sort((a, b) => Number(FRENCH_ADJECTIVES.has(a)) - Number(FRENCH_ADJECTIVES.has(b)));
  const fr = toFrench(core.slice(0, 3)).join(' ');
  const colour = toFrench(colourTokens(it.colour).slice(0, 1)).join(' ');
  const material = toFrench(materialTokens(it.material).slice(0, 1)).join(' ');
  const derived = [`${fr} ${colour}`.trim(), `${fr} ${material}`.trim(), it.subtype];
  return [...new Set([...own, ...derived].map((s) => s.trim()).filter(Boolean))].slice(0, 4);
}

function assetCandidates(it: DescriptorItem, assets: readonly MeshAsset[]): Candidate[] {
  const want = new Set([...tokens(it.subtype), ...tokens(it.shape)]);
  return assets
    .filter((a) => it.category === 'other' || a.category === it.category)
    .map((a) => ({ a, hit: tokens(`${a.name} ${a.styleTags.join(' ')}`).filter((t) => want.has(t)).length }))
    .filter((x) => it.category !== 'other' || x.hit > 0)
    .sort((x, y) => y.hit - x.hit || x.a.id.localeCompare(y.a.id))
    .slice(0, 4)
    .map(({ a }) => ({ kind: 'asset' as const, id: a.id, name: a.name, category: a.category, dims: a.nativeDims, styleTags: a.styleTags, has3d: true }));
}

/** Finds, ranks and judges the real products for each item (all of them, or `only`). */
export async function matchItems(descriptor: ReferenceDescriptor, ports: MatchPorts, only?: readonly string[]): Promise<MatchRun> {
  const run: MatchRun = { items: [], clip: 'used', text: 'used' };
  for (const it of descriptor.items) {
    if (only && !only.includes(it.id)) continue;
    const phrases = searchPhrases(it);
    const byId = new Map<string, Candidate>();
    const add = (c: Candidate) => {
      const prev = byId.get(c.id);
      byId.set(c.id, prev ? { ...prev, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) } : c);
    };
    let pending: string | undefined;
    const searched: string[] = [];
    // Text search: the first phrases until a few results are found.
    let found = 0;
    for (const q of phrases.slice(0, 3)) {
      if (found >= 6) break;
      const r = await ports.searchProducts(q, it.category === 'other' ? undefined : it.category, 8);
      if ('error' in r) {
        if (run.text === 'used') run.text = { unavailable: r.error };
        pending = r.error;
        break;
      }
      searched.push(q);
      r.forEach((c, i) => {
        if (!byId.has(c.id)) found++;
        add({ ...c, textRank: Math.min(c.textRank ?? 99, i) });
      });
    }
    // Picture similarity of the crop.
    if (run.clip === 'used') {
      const r = await ports.clip(it, 6);
      if ('error' in r) run.clip = { unavailable: r.error };
      else r.forEach(add);
    }
    const all = rankCandidates(it, [...byId.values()]);
    // a product of another kind (a mirror for a bathtub) is noise, not a near miss
    const products = all.filter((s) => s.candidate.kind === 'product' && s.parts.category > 0).slice(0, TOP_PRODUCTS);
    const fromIndex = all.filter((s) => s.candidate.kind === 'asset').slice(0, TOP_ASSETS);
    const libs = rankCandidates(it, assetCandidates(it, ports.assets())).slice(0, TOP_ASSETS);
    const assetList = [...fromIndex, ...libs.filter((l) => !fromIndex.some((f) => f.candidate.id === l.candidate.id))].slice(0, TOP_ASSETS);
    const best = products[0];
    const { verdict, reasons } = fitVerdict(it, best);
    const gen = suggestGenerator(it);
    const colour = toFrench(colourTokens(it.colour).slice(0, 1)).join(' ');
    run.items.push({
      itemId: it.id,
      verdict,
      reasons: pending && !best ? [...reasons, { aspect: 'missing', detail: `search did not run: ${pending}` }] : reasons,
      candidates: [...products, ...assetList],
      best,
      generator: 'suggestion' in gen ? gen.suggestion : null,
      ...('why' in gen ? { generatorWhy: gen.why } : {}),
      searched,
      suggestedSearch: [phrases[0] ?? it.subtype, reasons.some((r) => r.aspect === 'colour') && colour && !(phrases[0] ?? '').includes(colour) ? colour : ''].filter(Boolean).join(' '),
      ...(pending ? { pending } : {}),
    });
  }
  return run;
}

// -- gap report ----------------------------------------------------------------------------------------------------------

export interface GapLine {
  itemId: string;
  importance: number;
  target: string;
  planHint?: PlanHint | null | undefined;
  verdict: Verdict;
  bestMatch: { productId: string; name: string; price?: number | undefined; currency?: string | undefined; has3d: boolean; score: number } | null;
  gap: Reason[];
  concept: { generator: string; params: Record<string, number | string | boolean>; dims: { w: number; d: number; h: number }; notes: string[] } | null;
  conceptWhy?: string | undefined;
  suggestedSearch: string;
}

export interface GapReport {
  jobId: string;
  index: number;
  roomId?: string | undefined;
  style: string;
  summary: { items: number; good: number; approx: number; none: number; conceptAvailable: number };
  lines: GapLine[];
  decor: string[];
  note: string;
}

const cm = (n: number) => Math.round(n * 100);

export function buildGapReport(ref: StoredReference, matches: readonly ItemMatch[]): GapReport {
  const lines: GapLine[] = ref.descriptor.items
    .map((it) => {
      const m = matches.find((x) => x.itemId === it.id);
      if (!m) return undefined;
      const b = m.best?.candidate;
      const line: GapLine = {
        itemId: it.id,
        importance: it.importance,
        target: `${itemPhrase(it)}, ${it.shape}; about ${cm(it.approxDims.w)}x${cm(it.approxDims.d)}x${cm(it.approxDims.h)} cm`,
        planHint: ref.plan[it.id],
        verdict: m.verdict,
        bestMatch: b ? { productId: b.id, name: b.name, price: b.price, currency: b.currency, has3d: b.has3d, score: m.best!.score } : null,
        gap: m.reasons,
        concept: m.generator ? { generator: m.generator.generator, params: m.generator.params, dims: m.generator.dims, notes: m.generator.notes } : null,
        ...(m.generatorWhy ? { conceptWhy: m.generatorWhy } : {}),
        suggestedSearch: m.suggestedSearch,
      };
      return line;
    })
    .filter((l): l is GapLine => l !== undefined)
    .sort((a, b) => b.importance - a.importance || a.itemId.localeCompare(b.itemId));
  const count = (v: Verdict) => lines.filter((l) => l.verdict === v).length;
  return {
    jobId: ref.jobId,
    index: ref.index,
    ...(ref.roomId ? { roomId: ref.roomId } : {}),
    style: ref.descriptor.style,
    summary: { items: lines.length, good: count('good'), approx: count('approx'), none: count('none'), conceptAvailable: lines.filter((l) => l.verdict !== 'good' && l.concept).length },
    lines,
    decor: ref.descriptor.decor,
    note: 'Real products are the only purchasable items. A concept shape (place_item concept:true) is a generated stand-in: labelled in the UI, listed apart in the bill, never priced.',
  };
}

export function gapMarkdown(r: GapReport): string {
  const out: string[] = [`# Gap report: ${r.style}`, '', `Reference ${r.jobId} #${r.index}${r.roomId ? `, room ${r.roomId}` : ''}. ${r.summary.items} items: ${r.summary.good} good, ${r.summary.approx} approximate, ${r.summary.none} without a real match.`, ''];
  out.push('| Item | Target | Best real match | Verdict | Gap | Concept alternative | Try searching |', '|---|---|---|---|---|---|---|');
  const cell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
  for (const l of r.lines) {
    const best = l.bestMatch ? `${l.bestMatch.name}${l.bestMatch.price !== undefined ? ` (${l.bestMatch.price} ${l.bestMatch.currency ?? 'EUR'})` : ''}${l.bestMatch.has3d ? '' : ' [no 3D]'}` : 'none';
    const gap = l.gap.length ? l.gap.map((g) => `${g.aspect}: ${g.detail}`).join('; ') : '-';
    const concept = l.concept ? `${l.concept.generator} ${JSON.stringify(l.concept.params)} [concept]` : (l.conceptWhy ?? '-');
    out.push(`| ${cell(`${l.itemId} (${l.importance}/5)`)} | ${cell(l.target)} | ${cell(best)} | ${l.verdict} | ${cell(gap)} | ${cell(concept)} | ${cell(l.suggestedSearch)} |`);
  }
  const withPlan = r.lines.filter((l) => l.planHint);
  if (withPlan.length) out.push('', '## Position hints from our depth', ...withPlan.map((l) => `- ${l.itemId}: footprint centre about [${l.planHint!.centre.join(', ')}] m${l.planHint!.heightM > 0.1 ? `, ${l.planHint!.heightM} m above the floor` : ''}`));
  if (r.decor.length) out.push('', `Decor seen: ${r.decor.join('; ')}.`);
  out.push('', r.note);
  return out.join('\n');
}
