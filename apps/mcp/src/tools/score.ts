import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GENERATORS, PRODUCT_CATEGORIES, type CameraPose, type Scene } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolError, toolOk } from '../errors';
import { ImageProviderError, SimilarityError, cosine, getImageProvider, getImageScorer, type ImageScorer } from '../imagegen';
import { RenderError, resolvePose, sharedMcpRenderer } from '../render';
import { getReference, referencesOfRoom, type StoredReference } from '../reference/engine';
import { layoutIntent } from '../reference/views';
import { kmeansLab } from '../score/color';
import { DEFAULT_SCORE_WEIGHTS, clamp01, comparePalettes, compareLayouts, diffList, itemBoxes, overallScore, round, type InstanceLegendEntry, type OurItem } from '../score/metrics';
import { decodePng, downscale, encodePng, type Rgba } from '../score/png';
import { READ, fetchScene, obj, parseArgs } from './common';
import { SIZE_OF_REFERENCE, getJobMeta } from './reference';
import type { Renderer, ToolContext, ToolDef } from './registry';

/**
 * `score_against_reference` (CG5): how close OUR room, seen from the camera of the reference image, is to that image.
 * Palette (k-means in Lab, ΔE2000 per role), layout (box IoU per category from the recorded descriptor and our instance mask),
 * CLIP image similarity and an aesthetic score (both from the local sidecar, skipped with a note when it is down), a weighted
 * overall score and a short machine diff list the critic turns into fixes. The scoring maths is in `../score/metrics.ts`.
 *
 * With `all` it scores every recorded view of the same room and zone (one reference per camera) and aggregates by the view
 * weights; the diff lines carry the view they come from. Each scoring also keeps the scene it scored (`scene.flat.json` in the
 * iteration folder) so a runner can put the best iteration back.
 */

const SIZE = SIZE_OF_REFERENCE;
const RETURN_EDGE = 640;
/** CLIP cosine of two photos of the same room is typically 0.6 to 0.9: this range maps to 0..1. */
const CLIP_LO = 0.4;
const CLIP_HI = 0.9;
/** Every aesthetic point our render scores below the reference costs this much of the 0..1 aesthetic score. */
const AESTHETIC_SPAN = 3;
const MAX_DIFF_LINES = 24;

const ScoreArgs = z.strictObject({
  jobId: z.string().min(1).max(64),
  index: z.number().int().min(0).max(3).default(0),
  roomId: z.string().min(1).max(64).optional(),
  pose: z.record(z.string(), z.unknown()).optional(),
  all: z.boolean().default(false),
});

export const clipScore = (cos: number): number => clamp01((cos - CLIP_LO) / (CLIP_HI - CLIP_LO));
export const aestheticScore = (ours: number, target: number): number => clamp01(1 - Math.max(0, target - ours) / AESTHETIC_SPAN);

// -- per-iteration memory and files ---------------------------------------------------------------------------------------

const history = new Map<string, { iteration: number; overall: number | null }[]>();
/** For tests: forget the scores of earlier calls. */
export const clearScoreHistory = (): void => history.clear();

/** The runner sets FLAT_DESIGN_OUT (a trusted operator setting): each scoring is saved as `iterations/NN/`. */
function iterationDir(key: string): { dir: string; iteration: number } | undefined {
  const out = process.env['FLAT_DESIGN_OUT'];
  if (!out) return undefined;
  const root = join(resolve(out), 'iterations');
  const prev = history.get(key) ?? [];
  let n = prev.length + 1;
  if (existsSync(root)) {
    const taken = readdirSync(root).map((d) => Number(d.replace(/^iter-/, ''))).filter(Number.isFinite);
    n = Math.max(n, (taken.length ? Math.max(...taken) : 0) + 1);
  }
  return { dir: join(root, `iter-${String(n).padStart(2, '0')}`), iteration: n };
}

// -- our items -----------------------------------------------------------------------------------------------------------

function ourCategories(scene: Scene): Map<string, { category: string; name: string; locked: boolean; roomId?: string | undefined }> {
  const m = new Map<string, { category: string; name: string; locked: boolean; roomId?: string | undefined }>();
  for (const it of scene.items) {
    const gen = it.mesh?.kind === 'parametric' ? GENERATORS.get(it.mesh.generator) : undefined;
    const tail = it.assetId.replace(/^(param|builtin):/, '');
    const category = it.product?.category ?? gen?.category ?? ((PRODUCT_CATEGORIES as readonly string[]).includes(tail) ? tail : 'other');
    const name = it.product?.name ?? (it.concept ? `concept ${it.mesh?.kind === 'parametric' ? it.mesh.generator : 'shape'}` : it.assetId);
    m.set(it.id, { category, name, locked: Boolean(it.locked), roomId: it.roomId });
  }
  return m;
}

// -- one view --------------------------------------------------------------------------------------------------------------

interface Skip {
  metric: string;
  why: string;
}

async function readReferencePng(jobId: string, index: number): Promise<{ file: string; bytes: Buffer } | { why: string }> {
  try {
    const st = await getImageProvider().poll(jobId, { waitMs: 0 });
    const img = st.images[index];
    if (!img) return { why: `job ${jobId} has no image #${index} (status ${st.status})` };
    if (!existsSync(img.path)) return { why: `the reference file ${img.path} is not on this machine` };
    return { file: img.path, bytes: readFileSync(img.path) };
  } catch (e) {
    return { why: e instanceof ImageProviderError ? e.message : e instanceof Error ? e.message : String(e) };
  }
}

type Metrics = ReturnType<typeof metricsOf>;
const metricsOf = (palette: ReturnType<typeof comparePalettes> | undefined, layout: ReturnType<typeof compareLayouts> | undefined, clip: { cosine: number; model: string } | undefined, aesthetic: { ours: number; target: number; model: string; licence: string } | undefined) => ({
  palette: palette ? { score: palette.score, meanDeltaE: palette.meanDeltaE, roles: palette.roles, pairs: palette.pairs } : null,
  layout: layout ? { score: layout.score, perCategory: layout.perCategory, matched: layout.matched, missing: layout.missing, misplaced: layout.misplaced, extra: layout.extra, ...(layout.intentFixed?.length ? { intentFixed: layout.intentFixed } : {}) } : null,
  clip: clip ? { cosine: clip.cosine, score: round(clipScore(clip.cosine), 4), model: clip.model } : null,
  aesthetic: aesthetic ? { ours: aesthetic.ours, target: aesthetic.target, score: round(aestheticScore(aesthetic.ours, aesthetic.target), 4), model: aesthetic.model, licence: aesthetic.licence } : null,
});

interface Scored {
  jobId: string;
  index: number;
  roomId: string;
  view?: string | undefined;
  zone?: string | undefined;
  weight: number;
  pose: CameraPose;
  overall: number | null;
  weights: Record<string, number>;
  scores: Metrics;
  diff: string[];
  skipped: Skip[];
  ours: Rgba;
  oursB64: string;
  refImg: { file: string; bytes: Buffer } | { why: string };
}

const isResult = (x: Scored | CallToolResult): x is CallToolResult => 'content' in x;

/** Renders our room from the reference camera and scores it against one reference image. */
async function scoreOne(ctx: ToolContext, scene: Scene, t: { jobId: string; index: number; roomId?: string | undefined; pose?: CameraPose | undefined; rate?: boolean }): Promise<Scored | CallToolResult> {
  const meta = getJobMeta(t.jobId);
  const ref: StoredReference | undefined = getReference(t.jobId, t.index);
  const roomId = meta?.roomId ?? ref?.roomId ?? t.roomId;
  if (!roomId) return toolError('invalid_command', 'which room? The job was not made by this server and no descriptor names a room', 'Pass roomId.', { errors: [{ code: 'invalid_command', path: 'roomId', message: 'required for this job' }] });
  const take = t.rate === false ? { ok: true as const } : ctx.session.renders.take();
  if (!take.ok) return toolError('rate_limited', `more than ${ctx.limits.rendersPerMinute} renders per minute`, `Wait ${take.retryAfterMs} ms and retry.`, { retryAfterMs: take.retryAfterMs });

  const skipped: Skip[] = [];
  // 1. our room from the reference's camera, with the instance mask
  let ours: Rgba;
  let oursB64: string;
  let instances: { img: Rgba; legend: InstanceLegendEntry[] } | undefined;
  let pose: CameraPose;
  try {
    pose = t.pose ?? meta?.pose ?? resolvePose(scene, { view: 'walk', roomId }, SIZE.width / SIZE.height).pose;
    const r: Renderer = ctx.renderer ?? sharedMcpRenderer(ctx.flat, { webUrl: ctx.config.webUrl, renderChannel: ctx.config.renderChannel, log: ctx.config.log });
    const out = await r.render({ view: 'walk', roomId, pose, size: { ...SIZE } }, { format: 'png', session: ctx.session, passes: { kinds: ['instances'] } });
    oursB64 = out.image;
    ours = decodePng(Buffer.from(out.image, 'base64'));
    const url = out.passes?.images['instances'];
    const legend = (out.passes?.legend?.instances ?? []) as InstanceLegendEntry[];
    if (url && legend.length) instances = { img: decodePng(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')), legend };
    else skipped.push({ metric: 'layout', why: 'this renderer draws no instance pass' });
  } catch (e) {
    if (e instanceof RenderError) return e.result ?? toolError(e.code, e.message, e.hint);
    return toolError('render_failed', e instanceof Error ? e.message : String(e), 'Our render must work for scoring; try render_view for the room first.');
  }

  // 2. the reference image
  const refImg = await readReferencePng(t.jobId, t.index);
  let refRgba: Rgba | undefined;
  let refB64: string | undefined;
  if ('why' in refImg) skipped.push({ metric: 'palette', why: refImg.why }, { metric: 'clip', why: refImg.why }, { metric: 'aesthetic', why: refImg.why });
  else {
    try {
      refRgba = decodePng(refImg.bytes);
      refB64 = refImg.bytes.toString('base64');
    } catch (e) {
      const why = `the reference image cannot be read: ${e instanceof Error ? e.message : String(e)}`;
      skipped.push({ metric: 'palette', why }, { metric: 'clip', why }, { metric: 'aesthetic', why });
    }
  }

  // 3. palette
  const palette = refRgba ? comparePalettes(kmeansLab(refRgba, 6), kmeansLab(ours, 6), ref?.descriptor.palette ?? []) : undefined;

  // 4. layout. The pieces the layout intent fixes (sofa, rug, coffee table in front of the TV) are scored for presence, not for
  // where the image happened to draw them: the image follows the camera, the layout follows the room.
  let layout: ReturnType<typeof compareLayouts> | undefined;
  let intentCategories: Set<string> | undefined;
  if (!ref) skipped.push({ metric: 'layout', why: 'no descriptor recorded for this image (record_reference first)' });
  else if (instances) {
    const cats = ourCategories(scene);
    const boxes = itemBoxes(instances.img, instances.legend);
    const items: OurItem[] = [...boxes].flatMap(([id, b]) => {
      const c = cats.get(id);
      if (!c || (c.roomId && c.roomId !== roomId)) return [];
      return [{ id, category: c.category, name: c.name, box: b.box, pixels: b.pixels, locked: c.locked }];
    });
    try {
      const fixes = layoutIntent(scene, roomId, ref.zone ?? meta?.zone).fixes;
      if (fixes.length) intentCategories = new Set(fixes);
    } catch {
      // no layout intent for this room: plain comparison
    }
    layout = compareLayouts(
      ref.descriptor.items.map((i) => ({ id: i.id, category: i.category, subtype: i.subtype, box: i.box, importance: i.importance })),
      items,
      { width: instances.img.width, height: instances.img.height },
      intentCategories,
    );
  }

  // 5. CLIP and aesthetic (sidecar)
  const scorer: ImageScorer = getImageScorer();
  let clip: { cosine: number; model: string } | undefined;
  let aesthetic: { ours: number; target: number; model: string; licence: string } | undefined;
  if (refB64) {
    try {
      const e = await scorer.embed([oursB64, refB64]);
      if (e.vectors.length === 2) clip = { cosine: round(cosine(e.vectors[0]!, e.vectors[1]!), 4), model: e.model };
    } catch (e) {
      skipped.push({ metric: 'clip', why: e instanceof SimilarityError ? `${e.code}: ${e.message}` : String(e) });
    }
    try {
      const s = await scorer.aesthetic([oursB64, refB64]);
      if (s.scores.length === 2) aesthetic = { ours: round(s.scores[0]!, 2), target: round(s.scores[1]!, 2), model: s.model, licence: s.licence };
    } catch (e) {
      skipped.push({ metric: 'aesthetic', why: e instanceof SimilarityError ? `${e.code}: ${e.message}` : String(e) });
    }
  }

  // 6. overall and the diff list (what the matcher found decides what is worth chasing)
  const weights = ctx.config.scoreWeights ?? DEFAULT_SCORE_WEIGHTS;
  const parts = { palette: palette?.score, layout: layout?.score, clip: clip ? clipScore(clip.cosine) : undefined, aesthetic: aesthetic ? aestheticScore(aesthetic.ours, aesthetic.target) : undefined };
  const overall = overallScore(parts, weights);
  const matches = ref?.matches?.length ? new Map(ref.matches.map((m) => [m.itemId, { verdict: m.verdict, concept: Boolean(m.generator) }] as const)) : undefined;
  const diff = diffList({ palette, layout, clip, aesthetic, matches, intentCategories });

  return {
    jobId: t.jobId,
    index: t.index,
    roomId,
    view: ref?.view ?? meta?.view,
    zone: ref?.zone ?? meta?.zone,
    weight: ref?.weight ?? meta?.weight ?? 1,
    pose,
    overall: overall.score,
    weights: overall.used,
    scores: metricsOf(palette, layout, clip, aesthetic),
    diff,
    skipped,
    ours,
    oursB64,
    refImg,
  };
}

// -- aggregate -------------------------------------------------------------------------------------------------------------

/** Weighted mean of the numbers that exist (weights renormalised over them); null when none. */
function wmean(xs: { v: number | null | undefined; w: number }[]): number | null {
  const have = xs.filter((x): x is { v: number; w: number } => typeof x.v === 'number');
  const total = have.reduce((a, x) => a + x.w, 0);
  return have.length && total > 0 ? round(have.reduce((a, x) => a + x.v * x.w, 0) / total, 4) : null;
}

/** The diff lines of all views: tagged with their view, the same line from several views merged into one tag list. */
export function mergeDiffs(views: { view?: string | undefined; diff: string[] }[]): string[] {
  const order: string[] = [];
  const tags = new Map<string, string[]>();
  for (const v of views) {
    for (const line of v.diff) {
      if (!tags.has(line)) {
        tags.set(line, []);
        order.push(line);
      }
      if (v.view && !tags.get(line)!.includes(v.view)) tags.get(line)!.push(v.view);
    }
  }
  const tagged = order.map((l) => ({ l, text: tags.get(l)!.length ? `[${tags.get(l)!.join(',')}] ${l}` : l }));
  // the gaps to accept always go last, whatever the view
  return [...tagged.filter((t) => !t.l.startsWith('accept gap')), ...tagged.filter((t) => t.l.startsWith('accept gap'))].map((t) => t.text).slice(0, MAX_DIFF_LINES);
}

const sceneSnapshot = (scene: Scene) => `${JSON.stringify(scene)}\n`;

async function scoreAgainstReference(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  const p = parseArgs(ScoreArgs, args);
  if (!p.ok) return p.result;
  const a = p.data;
  const sc = await fetchScene(ctx);
  if (!sc.ok) return sc.result;
  const scene = sc.data.scene;

  const first = getReference(a.jobId, a.index);
  const firstMeta = getJobMeta(a.jobId);
  const roomId = firstMeta?.roomId ?? first?.roomId ?? a.roomId;
  const zone = first?.zone ?? firstMeta?.zone;

  // the views to score: this image, or (all) the latest recorded reference of every view of its room and zone
  const targets: { jobId: string; index: number; pose?: CameraPose | undefined }[] = [{ jobId: a.jobId, index: a.index, pose: a.pose as CameraPose | undefined }];
  if (a.all && roomId) {
    const set = referencesOfRoom(roomId, zone);
    if (set.length) {
      targets.length = 0;
      for (const r of set) targets.push({ jobId: r.jobId, index: r.index });
      if (!targets.some((t) => t.jobId === a.jobId && t.index === a.index)) targets.unshift({ jobId: a.jobId, index: a.index, pose: a.pose as CameraPose | undefined });
    }
  }
  const aggregate = a.all && targets.length > 1;

  const scored: Scored[] = [];
  // one scoring call is one render of the rate limit, however many views it draws
  for (const [i, t] of targets.entries()) {
    const r = await scoreOne(ctx, scene, { ...t, roomId: a.roomId, rate: i === 0 });
    if (isResult(r)) return r;
    scored.push(r);
  }
  const head = scored[0]!;
  const key = aggregate ? `set:${head.roomId}:${zone ?? ''}` : `${a.jobId}:${a.index}`;
  const prevList = history.get(key) ?? [];
  const slot = iterationDir(key);
  const iteration = slot?.iteration ?? prevList.length + 1;
  const prev = prevList[prevList.length - 1];

  let overall: number | null;
  let weights: Record<string, number>;
  let scores: unknown;
  let diff: string[];
  let skipped: Skip[];
  const views = scored.map((s) => ({ s, w: s.weight }));
  if (aggregate) {
    overall = wmean(views.map(({ s, w }) => ({ v: s.overall, w })));
    weights = head.weights;
    const metric = (m: 'palette' | 'layout' | 'clip' | 'aesthetic') => {
      const v = wmean(views.map(({ s, w }) => ({ v: (s.scores[m] as { score: number } | null)?.score, w })));
      return v === null ? null : { score: v };
    };
    scores = { palette: metric('palette'), layout: metric('layout'), clip: metric('clip'), aesthetic: metric('aesthetic') };
    diff = mergeDiffs(scored);
    skipped = scored.flatMap((s) => s.skipped.map((k) => ({ metric: k.metric, why: s.view ? `${s.view}: ${k.why}` : k.why })));
  } else {
    overall = head.overall;
    weights = head.weights;
    scores = head.scores;
    diff = head.diff;
    skipped = head.skipped;
  }
  prevList.push({ iteration, overall });
  history.set(key, prevList);
  const improvement = prev?.overall != null && overall !== null ? round(overall - prev.overall, 4) : undefined;
  const sumWeights = views.reduce((acc, v) => acc + v.w, 0) || 1;

  const viewOut = scored.map((s) => ({
    view: s.view ?? 'default',
    ...(s.zone ? { zone: s.zone } : {}),
    weight: round(s.weight / sumWeights, 3),
    jobId: s.jobId,
    index: s.index,
    overall: s.overall,
    scores: s.scores,
    diff: s.diff,
    pose: s.pose,
    ...(s.skipped.length ? { skipped: s.skipped } : {}),
  }));

  const data = {
    ok: true,
    jobId: a.jobId,
    index: a.index,
    roomId: head.roomId,
    ...(zone ? { zone } : {}),
    iteration,
    overall,
    ...(improvement !== undefined ? { improvement, previousOverall: prev!.overall } : {}),
    weights,
    scores,
    ...(aggregate ? { views: viewOut.map(({ view, weight, overall: o, jobId, index, zone: z, skipped: sk }) => ({ view, ...(z ? { zone: z } : {}), weight, overall: o, jobId, index, ...(sk ? { skipped: sk } : {}) })) } : {}),
    diff,
    ...(skipped.length ? { skipped, note: `not computed: ${skipped.map((s) => `${s.metric} (${s.why})`).join('; ')}. The overall score uses the metrics that were available.` } : {}),
    next: aggregate
      ? 'Tags [view] say which camera shows a fault. Fix the biggest items (rubric: prompt close_the_gap / styles://roles/critic), render, score again. Keep the best iteration; stop when the gain is under 0.02 twice in a row.'
      : 'Read the diff list with the critic rubric (prompt close_the_gap / styles://roles/critic), fix the biggest items, render, then score again. Stop when the overall improves by less than 0.02.',
  };

  let files: Record<string, string> | undefined;
  if (slot) {
    try {
      mkdirSync(slot.dir, { recursive: true });
      files = { score: join(slot.dir, 'score.json'), scene: join(slot.dir, 'scene.flat.json') };
      writeFileSync(files['scene']!, sceneSnapshot(scene));
      if (!aggregate) {
        files['render'] = join(slot.dir, 'render.png');
        writeFileSync(files['render'], Buffer.from(head.oursB64, 'base64'));
        if (!('why' in head.refImg)) {
          files['target'] = join(slot.dir, 'target.png');
          copyFileSync(head.refImg.file, files['target']);
        }
      }
      const saved: Record<string, unknown> = { ...data, rev: sc.data.rev, pose: aggregate ? undefined : head.pose, savedAt: new Date().toISOString() };
      if (aggregate) {
        // per view: the full scores, the render and the target it was compared with
        saved['views'] = viewOut;
        for (const s of scored) {
          const vdir = join(slot.dir, 'views', s.view ?? 'default');
          mkdirSync(vdir, { recursive: true });
          writeFileSync(join(vdir, 'render.png'), Buffer.from(s.oursB64, 'base64'));
          if (!('why' in s.refImg)) copyFileSync(s.refImg.file, join(vdir, 'target.png'));
        }
      }
      writeFileSync(files['score']!, `${JSON.stringify(saved, null, 2)}\n`);
    } catch (e) {
      return toolError('internal_error', `could not save the iteration: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const content: CallToolResult['content'] = [];
  for (const s of scored) {
    const label = aggregate
      ? `Our render of "${s.roomId}", view ${s.view ?? 'default'} (iteration ${iteration}, this view ${s.overall ?? 'n/a'}, all views ${overall ?? 'n/a'}).`
      : `Our render of "${s.roomId}" from the reference camera (iteration ${iteration}, overall ${overall ?? 'n/a'}).`;
    content.push({ type: 'text', text: label }, { type: 'image', data: encodePng(downscale(s.ours, aggregate ? 480 : RETURN_EDGE)).toString('base64'), mimeType: 'image/png' });
  }
  return toolOk({ ...data, ...(files ? { files } : {}) }, content);
}

export function scoreTools(): ToolDef[] {
  return [
    {
      name: 'score_against_reference',
      description: 'Score our room against a reference, from its camera: palette, layout IoU (record_reference first), CLIP, aesthetic; overall 0-1; diff list. all: every view of the room, weighted.',
      inputSchema: obj(
        {
          jobId: { type: 'string' },
          index: { type: 'integer', minimum: 0, maximum: 3 },
          roomId: { type: 'string', description: 'Only for images not made here.' },
          pose: { type: 'object', description: 'As render_view.' },
          all: { type: 'boolean' },
        },
        ['jobId'],
      ),
      annotations: { ...READ, idempotentHint: false },
      group: 'read',
      mutatesScene: false,
      handler: scoreAgainstReference,
    },
  ];
}
