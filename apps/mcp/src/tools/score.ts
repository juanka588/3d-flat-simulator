import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GENERATORS, PRODUCT_CATEGORIES, type CameraPose, type Scene } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolError, toolOk } from '../errors';
import { ImageProviderError, SimilarityError, cosine, getImageProvider, getImageScorer, type ImageScorer } from '../imagegen';
import { RenderError, resolvePose, sharedMcpRenderer } from '../render';
import { getReference } from '../reference/engine';
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
 */

const SIZE = SIZE_OF_REFERENCE;
const RETURN_EDGE = 640;
/** CLIP cosine of two photos of the same room is typically 0.6 to 0.9: this range maps to 0..1. */
const CLIP_LO = 0.4;
const CLIP_HI = 0.9;
/** Every aesthetic point our render scores below the reference costs this much of the 0..1 aesthetic score. */
const AESTHETIC_SPAN = 3;

const ScoreArgs = z.strictObject({
  jobId: z.string().min(1).max(64),
  index: z.number().int().min(0).max(3).default(0),
  roomId: z.string().min(1).max(64).optional(),
  pose: z.record(z.string(), z.unknown()).optional(),
});

export const clipScore = (cos: number): number => clamp01((cos - CLIP_LO) / (CLIP_HI - CLIP_LO));
export const aestheticScore = (ours: number, target: number): number => clamp01(1 - Math.max(0, target - ours) / AESTHETIC_SPAN);

// -- per-iteration memory and files ---------------------------------------------------------------------------------------

const history = new Map<string, { iteration: number; overall: number | null }[]>();
/** For tests: forget the scores of earlier calls. */
export const clearScoreHistory = (): void => history.clear();

/** The runner sets FLAT_DESIGN_OUT (a trusted operator setting): each scoring is saved as `iterations/NN/`. */
function iterationDir(jobId: string, index: number): { dir: string; iteration: number } | undefined {
  const out = process.env['FLAT_DESIGN_OUT'];
  if (!out) return undefined;
  const root = join(resolve(out), 'iterations');
  const key = `${jobId}:${index}`;
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

// -- the tool ------------------------------------------------------------------------------------------------------------

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

async function scoreAgainstReference(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  const p = parseArgs(ScoreArgs, args);
  if (!p.ok) return p.result;
  const a = p.data;
  const meta = getJobMeta(a.jobId);
  const ref = getReference(a.jobId, a.index);
  const roomId = meta?.roomId ?? ref?.roomId ?? a.roomId;
  if (!roomId) return toolError('invalid_command', 'which room? The job was not made by this server and no descriptor names a room', 'Pass roomId.', { errors: [{ code: 'invalid_command', path: 'roomId', message: 'required for this job' }] });
  const t = ctx.session.renders.take();
  if (!t.ok) return toolError('rate_limited', `more than ${ctx.limits.rendersPerMinute} renders per minute`, `Wait ${t.retryAfterMs} ms and retry.`, { retryAfterMs: t.retryAfterMs });

  const skipped: Skip[] = [];
  const sc = await fetchScene(ctx);
  if (!sc.ok) return sc.result;
  const scene = sc.data.scene;

  // 1. our room from the reference's camera, with the instance mask
  let ours: Rgba;
  let oursB64: string;
  let instances: { img: Rgba; legend: InstanceLegendEntry[] } | undefined;
  let pose: CameraPose;
  try {
    pose = (a.pose as CameraPose | undefined) ?? meta?.pose ?? resolvePose(scene, { view: 'walk', roomId }, SIZE.width / SIZE.height).pose;
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
  const refImg = await readReferencePng(a.jobId, a.index);
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

  // 4. layout
  let layout: ReturnType<typeof compareLayouts> | undefined;
  if (!ref) skipped.push({ metric: 'layout', why: 'no descriptor recorded for this image (record_reference first)' });
  else if (instances) {
    const cats = ourCategories(scene);
    const boxes = itemBoxes(instances.img, instances.legend);
    const items: OurItem[] = [...boxes].flatMap(([id, b]) => {
      const c = cats.get(id);
      if (!c || (c.roomId && c.roomId !== roomId)) return [];
      return [{ id, category: c.category, name: c.name, box: b.box, pixels: b.pixels, locked: c.locked }];
    });
    layout = compareLayouts(
      ref.descriptor.items.map((i) => ({ id: i.id, category: i.category, subtype: i.subtype, box: i.box, importance: i.importance })),
      items,
      { width: instances.img.width, height: instances.img.height },
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

  // 6. overall
  const weights = ctx.config.scoreWeights ?? DEFAULT_SCORE_WEIGHTS;
  const parts = { palette: palette?.score, layout: layout?.score, clip: clip ? clipScore(clip.cosine) : undefined, aesthetic: aesthetic ? aestheticScore(aesthetic.ours, aesthetic.target) : undefined };
  const overall = overallScore(parts, weights);
  const diff = diffList({ palette, layout, clip, aesthetic });

  const key = `${a.jobId}:${a.index}`;
  const prevList = history.get(key) ?? [];
  const slot = iterationDir(a.jobId, a.index);
  const iteration = slot?.iteration ?? prevList.length + 1;
  const prev = prevList[prevList.length - 1];
  prevList.push({ iteration, overall: overall.score });
  history.set(key, prevList);
  const improvement = prev?.overall != null && overall.score != null ? round(overall.score - prev.overall, 4) : undefined;

  const data = {
    ok: true,
    jobId: a.jobId,
    index: a.index,
    roomId,
    iteration,
    overall: overall.score,
    ...(improvement !== undefined ? { improvement, previousOverall: prev!.overall } : {}),
    weights: overall.used,
    scores: {
      palette: palette ? { score: palette.score, meanDeltaE: palette.meanDeltaE, roles: palette.roles, pairs: palette.pairs } : null,
      layout: layout ? { score: layout.score, perCategory: layout.perCategory, matched: layout.matched, missing: layout.missing, misplaced: layout.misplaced, extra: layout.extra } : null,
      clip: clip ? { cosine: clip.cosine, score: round(clipScore(clip.cosine), 4), model: clip.model } : null,
      aesthetic: aesthetic ? { ours: aesthetic.ours, target: aesthetic.target, score: round(aestheticScore(aesthetic.ours, aesthetic.target), 4), model: aesthetic.model, licence: aesthetic.licence } : null,
    },
    diff,
    ...(skipped.length ? { skipped, note: `not computed: ${skipped.map((s) => `${s.metric} (${s.why})`).join('; ')}. The overall score uses the metrics that were available.` } : {}),
    next: 'Read the diff list with the critic rubric (prompt close_the_gap / styles://roles/critic), fix the biggest items, render, then score again. Stop when the overall improves by less than 0.02.',
  };

  let files: Record<string, string> | undefined;
  if (slot) {
    try {
      mkdirSync(slot.dir, { recursive: true });
      files = { score: join(slot.dir, 'score.json'), render: join(slot.dir, 'render.png') };
      writeFileSync(files['render']!, Buffer.from(oursB64, 'base64'));
      if (!('why' in refImg)) {
        files['target'] = join(slot.dir, 'target.png');
        copyFileSync(refImg.file, files['target']);
      }
      writeFileSync(files['score']!, `${JSON.stringify({ ...data, pose, savedAt: new Date().toISOString() }, null, 2)}\n`);
    } catch (e) {
      return toolError('internal_error', `could not save the iteration: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const small = encodePng(downscale(ours, RETURN_EDGE)).toString('base64');
  const label = `Our render of "${roomId}" from the reference camera (iteration ${iteration}, overall ${overall.score ?? 'n/a'}).`;
  return toolOk({ ...data, ...(files ? { files } : {}) }, [
    { type: 'text', text: label },
    { type: 'image', data: small, mimeType: 'image/png' },
  ]);
}

export function scoreTools(): ToolDef[] {
  return [
    {
      name: 'score_against_reference',
      description: 'Score our room against a reference image, rendered from its camera: palette ΔE per role, layout IoU (needs record_reference), CLIP, aesthetic; overall 0-1; diff list.',
      inputSchema: obj(
        {
          jobId: { type: 'string' },
          index: { type: 'integer', minimum: 0, maximum: 3 },
          roomId: { type: 'string', description: 'Only for images not made here.' },
          pose: { type: 'object', description: 'As render_view. Default: the reference camera.' },
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
