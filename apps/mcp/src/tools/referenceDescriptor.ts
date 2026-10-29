import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolvePose, sharedMcpRenderer } from '../render';
import { MAX_THUMBS, THUMB_MAX_SIDE, pictureContent, type Labelled } from '../imageContent';
import { assetThumb, cc0Assets } from '../assetCatalog';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolError, toolOk } from '../errors';
import { ImageMatchError, getImageMatcher } from '../imagegen';
import { ReferenceDescriptor } from '../reference/descriptor';
import { cameraOfPayload, decodePng16Gray, planHintOf, type PlanHint } from '../reference/depth';
import { buildGapReport, gapMarkdown, getReference, matchItems, putReference, type ItemMatch, type MatchPorts, type StoredReference } from '../reference/engine';
import type { Candidate } from '../reference/rank';
import { READ, fetchScene, obj, parseArgs } from './common';
import { markSeen, productPhoto } from './products';
import { SIZE_OF_REFERENCE, getJobMeta } from './reference';
import type { Renderer, ToolContext, ToolDef } from './registry';
import { RenderError } from '../render';

/**
 * The CG4 tools: `record_reference` (the model's reading of a reference image, validated and kept for the session, with the
 * plan position of each item taken from OUR depth), `match_reference` (real products and library shapes per item, with a fit
 * verdict and the generator that would stand in), and `gap_report` (what is missing, as markdown plus JSON).
 */

const JobRef = { jobId: z.string().min(1).max(64), index: z.number().int().min(0).max(3).default(0) };

const RecordArgs = z.strictObject({
  ...JobRef,
  roomId: z.string().min(1).max(64).optional(),
  descriptor: ReferenceDescriptor,
});
const MatchArgs = z.strictObject({ ...JobRef, itemIds: z.array(z.string().min(1).max(40)).min(1).max(30).optional(), thumbs: z.boolean().default(true) });
const GapArgs = z.strictObject({ ...JobRef, saveTo: z.string().min(1).max(300).optional() });

const refSchema = { jobId: { type: 'string', description: 'From generate_reference.' }, index: { type: 'integer', minimum: 0, maximum: 3 } };

// -- record_reference ----------------------------------------------------------------------------------------------------

const dataUrlBytes = (url: string): Uint8Array => Uint8Array.from(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));

async function planHints(ctx: ToolContext, roomId: string, descriptor: ReferenceDescriptor, pose: unknown): Promise<{ plan: Record<string, PlanHint | null>; status: string }> {
  const none = (why: string) => ({ plan: Object.fromEntries(descriptor.items.map((i) => [i.id, null])), status: `unavailable: ${why}` });
  const t = ctx.session.renders.take();
  if (!t.ok) return none(`render rate limit, retry in ${t.retryAfterMs} ms`);
  try {
    const sc = await fetchScene(ctx);
    if (!sc.ok) return none('the scene is not reachable');
    const size = SIZE_OF_REFERENCE;
    const camPose = (pose as never) ?? resolvePose(sc.data.scene, { view: 'walk', roomId }, size.width / size.height).pose;
    const r: Renderer = ctx.renderer ?? sharedMcpRenderer(ctx.flat, { webUrl: ctx.config.webUrl, renderChannel: ctx.config.renderChannel, log: ctx.config.log });
    const out = await r.render({ view: 'walk', roomId, pose: camPose, size: { ...size } }, { format: 'png', session: ctx.session, passes: { kinds: ['depth'] } });
    const depthUrl = out.passes?.images['depth'];
    if (!out.passes || !depthUrl) return none('this renderer draws no depth pass');
    const png = decodePng16Gray(dataUrlBytes(depthUrl));
    const unitM = typeof out.passes.depth?.['unitM'] === 'number' ? (out.passes.depth['unitM'] as number) : 0.001;
    const cam = cameraOfPayload(out.passes.camera, out.passes.size);
    const plan: Record<string, PlanHint | null> = {};
    for (const it of descriptor.items) plan[it.id] = planHintOf(cam, { ...png, unitM }, size, it) ?? null;
    return { plan, status: 'ok' };
  } catch (e) {
    return none(e instanceof RenderError || e instanceof Error ? e.message : String(e));
  }
}

/** The design runner sets FLAT_DESIGN_OUT (a trusted operator setting): the descriptor of the target is kept as `descriptor.json` (and per image). */
function saveDescriptor(ref: StoredReference): void {
  const out = process.env['FLAT_DESIGN_OUT'];
  if (!out) return;
  try {
    const dir = resolve(out);
    mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify({ jobId: ref.jobId, index: ref.index, roomId: ref.roomId, styleId: ref.styleId, view: ref.view, zone: ref.zone, weight: ref.weight, planStatus: ref.planStatus, plan: ref.plan, descriptor: ref.descriptor }, null, 2)}\n`;
    writeFileSync(join(dir, 'descriptor.json'), body);
    if (ref.view) {
      mkdirSync(join(dir, 'views'), { recursive: true });
      writeFileSync(join(dir, 'views', `${ref.view}.descriptor.json`), body);
    }
    writeFileSync(join(dir, `descriptor-${ref.jobId}-${ref.index}.json`), body);
  } catch {
    // saving is a convenience of the runner
  }
}

const recordReference: ToolDef = {
  name: 'record_reference',
  description:
    'Store your reading of a reference image (shape: prompt reference_reader). Validated; items get plan positions from our depth.',
  inputSchema: obj({ ...refSchema, roomId: { type: 'string', description: 'Only for images not made here.' }, descriptor: { type: 'object', description: 'style, palette, materials, lighting, items[], decor[].' } }, ['jobId', 'descriptor']),
  annotations: READ,
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const p = parseArgs(RecordArgs, args);
    if (!p.ok) return p.result;
    const a = p.data;
    const meta = getJobMeta(a.jobId);
    const roomId = meta?.roomId ?? a.roomId;
    const warnings: string[] = [];
    const size = SIZE_OF_REFERENCE;
    for (const it of a.descriptor.items) {
      if (it.box[2] > size.width + 1 || it.box[3] > size.height + 1) warnings.push(`item "${it.id}": box goes beyond the ${size.width}x${size.height} image`);
    }
    let plan: Record<string, PlanHint | null>;
    let status: string;
    if (!roomId) {
      plan = Object.fromEntries(a.descriptor.items.map((i) => [i.id, null]));
      status = 'unavailable: unknown room (pass roomId; the job was not made by this server)';
    } else ({ plan, status } = await planHints(ctx, roomId, a.descriptor, meta?.pose));
    const stored: StoredReference = { jobId: a.jobId, index: a.index, ...(roomId ? { roomId } : {}), ...(meta?.styleId ? { styleId: meta.styleId } : {}), ...(meta?.view ? { view: meta.view, zone: meta.zone, weight: meta.weight } : {}), descriptor: a.descriptor, plan, planStatus: status };
    putReference(stored);
    saveDescriptor(stored);
    return toolOk({
      ok: true,
      jobId: a.jobId,
      index: a.index,
      ...(roomId ? { roomId } : {}),
      ...(meta?.view ? { view: meta.view } : {}),
      items: a.descriptor.items.length,
      planStatus: status,
      positions: Object.fromEntries(Object.entries(plan).map(([id, h]) => [id, h ? { centre: h.centre, ...(h.heightM > 0.1 ? { heightM: h.heightM } : {}), widthM: h.widthM, ...(h.note ? { note: h.note } : {}) } : null])),
      ...(warnings.length ? { warnings } : {}),
      next: 'match_reference {jobId,index} finds real products per item; gap_report {jobId,index} lists what is missing.',
    });
  },
};

// -- ports (the real shop, the real index) -------------------------------------------------------------------------------

function makePorts(ctx: ToolContext, ref: StoredReference): MatchPorts {
  const items = new Map(ref.descriptor.items.map((i) => [i.id, i]));
  void items;
  return {
    async searchProducts(q, category, limit) {
      const t = ctx.session.searches.take();
      if (!t.ok) return { error: `more than ${ctx.limits.searchesPerMinute} searches per minute; retry in ${t.retryAfterMs} ms` };
      const r = await ctx.flat.searchProducts({ q, ...(category ? { category: category as never } : {}), limit });
      if (!r.ok) return { error: 'message' in r ? r.message : `shop search failed (${r.kind})` };
      return r.data.results.map<Candidate>((s, i) => ({ kind: 'product', id: s.productId, name: s.name, category: s.category, price: s.price, currency: s.currency, dims: s.dims, colours: s.colours, has3d: s.has3d, textRank: i }));
    },
    async clip(item, topK) {
      try {
        const res = await getImageMatcher().query({ image: { jobId: ref.jobId, index: ref.index }, box: item.box as [number, number, number, number], topK, source: 'all' });
        return res.results.map<Candidate>((h) => ({ kind: h.kind, id: h.id, name: h.name, category: h.category, price: h.price, currency: h.currency, dims: h.dims, has3d: h.has3d, clip: h.score }));
      } catch (e) {
        return { error: e instanceof ImageMatchError ? `${e.code}: ${e.message}` : String(e) };
      }
    },
    assets: () => cc0Assets(),
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function needRecorded(jobId: string, index: number): { ok: true; ref: StoredReference } | { ok: false; result: CallToolResult } {
  const ref = getReference(jobId, index);
  if (ref) return { ok: true, ref };
  return { ok: false, result: toolError('precondition_failed', `no descriptor recorded for ${jobId} #${index}`, 'Read the image (prompt reference_reader), then call record_reference first. Descriptors are kept in the memory of this server process.') };
}

// -- match_reference -----------------------------------------------------------------------------------------------------

function candidateLine(c: ItemMatch['candidates'][number]) {
  const k = c.candidate;
  return {
    ...(k.kind === 'product' ? { productId: k.id } : { assetId: k.id }),
    name: k.name.length > 70 ? `${k.name.slice(0, 69)}…` : k.name,
    score: c.score,
    ...(c.parts.clip !== null ? { clip: r3(c.parts.clip) } : {}),
    ...(k.price !== undefined ? { price: k.price, currency: k.currency ?? 'EUR' } : {}),
    ...(k.dims ? { dims: { w: r3(k.dims.w), d: r3(k.dims.d), h: r3(k.dims.h) } } : {}),
    has3d: k.has3d,
  };
}

const matchReference: ToolDef = {
  name: 'match_reference',
  description:
    'Per recorded item: top real products (text + CLIP, photo, price, has3d), verdict good|approx|none with reasons, and suggestGenerator, a CONCEPT stand-in (place_item concept:true).',
  inputSchema: obj({ ...refSchema, itemIds: { type: 'array', items: { type: 'string' }, description: 'Default all.' }, thumbs: { type: 'boolean', description: 'Default true.' } }, ['jobId']),
  annotations: READ,
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const p = parseArgs(MatchArgs, args);
    if (!p.ok) return p.result;
    const a = p.data;
    const rec = needRecorded(a.jobId, a.index);
    if (!rec.ok) return rec.result;
    const ref = rec.ref;
    if (a.itemIds) {
      const unknown = a.itemIds.filter((id) => !ref.descriptor.items.some((i) => i.id === id));
      if (unknown.length) return toolError('unknown_entity', `no item ${unknown.map((u) => `"${u}"`).join(', ')} in the descriptor`, `Items: ${ref.descriptor.items.map((i) => i.id).join(', ')}.`);
    }
    const run = await matchItems(ref.descriptor, makePorts(ctx, ref), a.itemIds);
    ref.matches = [...(ref.matches ?? []).filter((m) => !run.items.some((n) => n.itemId === m.itemId)), ...run.items];
    const productIds = run.items.flatMap((m) => m.candidates.filter((c) => c.candidate.kind === 'product').map((c) => c.candidate.id));
    const failed = await markSeen(ctx, productIds);
    if (failed) return failed;
    let content: CallToolResult['content'] = [];
    if (a.thumbs) {
      const tops = run.items.flatMap((m) => (m.candidates[0] ? [{ m, c: m.candidates[0].candidate }] : [])).slice(0, MAX_THUMBS);
      const raws = await Promise.all(tops.map(async ({ c }) => (c.kind === 'product' ? await productPhoto(ctx, c.id) : assetThumb(c.id))));
      const have: Labelled[] = tops.flatMap(({ m, c }, i) => (raws[i] ? [{ label: `${m.itemId}: ${c.id}`, raw: raws[i]! }] : []));
      content = (await pictureContent(have, THUMB_MAX_SIDE)).content;
    }
    const itemsOut = run.items.map((m) => ({
      id: m.itemId,
      verdict: m.verdict,
      ...(m.reasons.length ? { reasons: m.reasons } : {}),
      candidates: m.candidates.map(candidateLine),
      ...(ref.plan[m.itemId] ? { at: ref.plan[m.itemId]!.centre } : {}),
      ...(m.generator ? { suggestGenerator: { generator: m.generator.generator, params: m.generator.params, dims: m.generator.dims, concept: true, notes: m.generator.notes } } : { noGenerator: m.generatorWhy }),
      ...(m.verdict !== 'good' ? { trySearching: m.suggestedSearch } : {}),
    }));
    const n = (v: string) => run.items.filter((m) => m.verdict === v).length;
    return toolOk(
      {
        ok: true,
        jobId: a.jobId,
        index: a.index,
        summary: { good: n('good'), approx: n('approx'), none: n('none') },
        pictureSimilarity: run.clip === 'used' ? 'used' : `unavailable (${run.clip.unavailable}); ranked by text, size and colour only`,
        ...(run.text === 'used' ? {} : { textSearch: `incomplete (${run.text.unavailable})` }),
        items: itemsOut,
        note: 'Products listed are placeable with place_item (get_product for variants). suggestGenerator results are CONCEPT shapes: not products, not purchasable, shown labelled and kept out of the budget; prefer a real product when the verdict is good or approx. Next: gap_report.',
      },
      content,
    );
  },
};

// -- gap_report ----------------------------------------------------------------------------------------------------------

function saveDir(saveTo: string | undefined, jobId: string, index: number): { dir: string } | { error: CallToolResult } | undefined {
  if (saveTo) {
    const dir = resolve(process.cwd(), saveTo);
    const rel = relative(process.cwd(), dir);
    if (rel.startsWith('..') || isAbsolute(rel)) return { error: toolError('invalid_command', 'saveTo must be inside the working directory', `Use a relative path such as ".tmp/gap". Working directory: ${process.cwd()}`) };
    return { dir };
  }
  // The design runner sets FLAT_DESIGN_OUT (a trusted operator setting, so an absolute path is fine): reports go next to its renders.
  const out = process.env['FLAT_DESIGN_OUT'];
  return out ? { dir: join(resolve(out), 'gap-reports', `${jobId}-${index}`) } : undefined;
}

const gapReport: ToolDef = {
  name: 'gap_report',
  description:
    'Per item: target, best match, gap, concept alternative, search term. Markdown + JSON; saved to saveTo or the design folder.',
  inputSchema: obj({ ...refSchema, saveTo: { type: 'string', description: 'Directory under the working dir.' } }, ['jobId']),
  annotations: { ...READ, idempotentHint: false },
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const p = parseArgs(GapArgs, args);
    if (!p.ok) return p.result;
    const a = p.data;
    const rec = needRecorded(a.jobId, a.index);
    if (!rec.ok) return rec.result;
    const ref = rec.ref;
    const target = saveDir(a.saveTo, a.jobId, a.index);
    if (target && 'error' in target) return target.error;
    const missing = ref.descriptor.items.filter((i) => !ref.matches?.some((m) => m.itemId === i.id)).map((i) => i.id);
    if (missing.length) {
      const run = await matchItems(ref.descriptor, makePorts(ctx, ref), missing);
      ref.matches = [...(ref.matches ?? []), ...run.items];
      const failed = await markSeen(ctx, run.items.flatMap((m) => m.candidates.filter((c) => c.candidate.kind === 'product').map((c) => c.candidate.id)));
      if (failed) return failed;
    }
    const report = buildGapReport(ref, ref.matches ?? []);
    const markdown = gapMarkdown(report);
    let files: { markdown: string; json: string } | undefined;
    if (target && 'dir' in target) {
      try {
        mkdirSync(target.dir, { recursive: true });
        files = { markdown: join(target.dir, 'gap-report.md'), json: join(target.dir, 'gap-report.json') };
        writeFileSync(files.markdown, `${markdown}\n`);
        writeFileSync(files.json, `${JSON.stringify(report, null, 2)}\n`);
      } catch (e) {
        return toolError('internal_error', `could not write the report: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return toolOk({ ok: true, report, ...(files ? { files } : {}) }, [{ type: 'text', text: markdown }]);
  },
};

export function referenceDescriptorTools(): ToolDef[] {
  return [recordReference, matchReference, gapReport];
}
