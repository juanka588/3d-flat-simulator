import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { assetThumb } from '../assetCatalog';
import { toolError, toolOk } from '../errors';
import { ImageMatchError, getImageMatcher, type MatchHit, type MatchRequest } from '../imagegen';
import { MAX_THUMBS, THUMB_MAX_SIDE, pictureContent, type Labelled } from '../imageContent';
import { READ, obj, parseArgs } from './common';
import { markSeen, productPhoto } from './products';
import type { ToolDef } from './registry';

/**
 * `match_crop` (CG3): "what real product or library model looks like this part of the reference image?". The crop is embedded
 * by the local sidecar (CLIP) and compared with the catalogue photos and the HD / CC0 thumbnails. Products come back as
 * productIds that are registered as seen by this session, so place_item accepts them.
 */

const Rgb = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);

export const MatchCropArgs = z
  .strictObject({
    image: z.union([z.strictObject({ path: z.string().min(1).max(500) }), z.strictObject({ jobId: z.string().min(1).max(64), index: z.number().int().min(0).max(3) })]).optional(),
    box: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0), z.number().min(0)]).optional(),
    text: z.string().min(1).max(300).optional(),
    mask: z.strictObject({ path: z.string().min(1).max(500), color: Rgb.optional() }).optional(),
    cutout: z.boolean().optional(),
    category: z.string().min(1).max(32).optional(),
    maxPrice: z.number().min(0).max(1_000_000).optional(),
    source: z.enum(['catalog', 'hd', 'all']).optional(),
    topK: z.number().int().min(1).max(MAX_THUMBS).default(5),
    thumbs: z.boolean().default(true),
  })
  .refine((a) => a.image || a.text, { message: 'give image (with box) or text' })
  .refine((a) => !a.box || (a.box[2] > a.box[0] && a.box[3] > a.box[1]), { message: 'box must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0', path: ['box'] });

const num = { type: 'number', minimum: 0 };

function matchFailure(e: unknown): CallToolResult {
  if (e instanceof ImageMatchError) {
    switch (e.code) {
      case 'invalid_request':
        return toolError('invalid_command', e.message);
      case 'index_missing':
        return toolError('not_implemented', e.message, 'Ask the user to run `pnpm imagegen:index` (builds the catalogue and library indexes, about a minute), then retry; search_products still works.');
      case 'model_missing':
        return toolError('not_implemented', e.message, 'The CLIP weights (0.6 GB) are not downloaded: `pnpm imagegen:setup --download`.');
      case 'unavailable':
        return toolError('render_unavailable', e.message, 'Start the image service with `pnpm imagegen` (or set IMAGEGEN_URL); search_products works without it.');
      default:
        return toolError('render_failed', e.message);
    }
  }
  return toolError('internal_error', e instanceof Error ? e.message : String(e));
}

const hitLine = (h: MatchHit) => ({
  ...(h.kind === 'product' ? { productId: h.id } : { assetId: h.id }),
  score: Math.round(h.score * 1000) / 1000,
  name: h.name.length > 100 ? `${h.name.slice(0, 99)}…` : h.name,
  ...(h.price !== undefined ? { price: h.price, currency: h.currency ?? 'EUR' } : {}),
  ...(h.dims ? { dims: h.dims } : {}),
  ...(h.category ? { category: h.category } : {}),
  has3d: h.has3d,
});

export function matchTools(): ToolDef[] {
  return [
    {
      name: 'match_crop',
      description:
        'Real products and library models like a crop of a reference image (box in px) or a text. Returns id, score, price, dims, has3d, 160px photo. Products are placeable; assets are shapes for place_item mesh. Needs the image service.',
      inputSchema: obj({
        image: { type: 'object', description: '{jobId,index} or {path}.' },
        box: { type: 'array', items: num, minItems: 4, maxItems: 4, description: '[x0,y0,x1,y1] px; default whole image.' },
        text: { type: 'string', maxLength: 300, description: 'e.g. "freestanding white bathtub".' },
        mask: { type: 'object', description: '{path,color?}: render_passes instance-id image and the [r,g,b] of the object (our renders).' },
        cutout: { type: 'boolean', description: 'Whiten the crop background.' },
        category: { type: 'string' },
        maxPrice: { type: 'number', minimum: 0 },
        source: { type: 'string', enum: ['catalog', 'hd', 'all'] },
        topK: { type: 'integer', minimum: 1, maximum: MAX_THUMBS, description: 'Default 5.' },
        thumbs: { type: 'boolean', description: 'Default true.' },
      }),
      annotations: READ,
      group: 'read',
      mutatesScene: false,
      async handler(ctx, args) {
        const p = parseArgs(MatchCropArgs, args);
        if (!p.ok) return p.result;
        const a = p.data;
        const t = ctx.session.searches.take();
        if (!t.ok) return toolError('rate_limited', `more than ${ctx.limits.searchesPerMinute} searches per minute`, `Wait ${t.retryAfterMs} ms and retry.`, { retryAfterMs: t.retryAfterMs });
        const req: MatchRequest = {
          topK: a.topK,
          ...(a.image ? { image: a.image } : {}),
          ...(a.box ? { box: a.box } : {}),
          ...(a.text ? { text: a.text } : {}),
          ...(a.mask ? { mask: { path: a.mask.path, ...(a.mask.color ? { color: a.mask.color } : {}) } } : {}),
          ...(a.cutout ? { cutout: true } : {}),
          ...(a.category ? { category: a.category } : {}),
          ...(a.maxPrice !== undefined ? { maxPrice: a.maxPrice } : {}),
          ...(a.source ? { source: a.source } : {}),
        };
        let res;
        try {
          res = await getImageMatcher().query(req);
        } catch (e) {
          return matchFailure(e);
        }
        const hits = res.results.slice(0, a.topK);
        const products = hits.filter((h) => h.kind === 'product').map((h) => h.id);
        const failed = await markSeen(ctx, products);
        if (failed) return failed;
        let content: CallToolResult['content'] = [];
        let noPhoto: string[] = [];
        if (a.thumbs && hits.length) {
          const raws = await Promise.all(hits.map(async (h) => (h.kind === 'product' ? await productPhoto(ctx, h.id) : assetThumb(h.id))));
          const have: Labelled[] = hits.flatMap((h, i) => (raws[i] ? [{ label: `${h.id} score ${h.score.toFixed(3)}`, raw: raws[i]! }] : []));
          const pics = await pictureContent(have, THUMB_MAX_SIDE);
          content = pics.content;
          noPhoto = [...hits.filter((_, i) => !raws[i]).map((h) => h.id), ...pics.skipped.map((l) => l.split(' ')[0]!)];
        }
        return toolOk(
          {
            ok: true,
            count: hits.length,
            results: hits.map(hitLine),
            ...(noPhoto.length ? { noPhoto } : {}),
            ...(res.missing?.length ? { missingIndex: res.missing } : {}),
            note: hits.length ? 'Scores are CLIP cosine similarities: judge the photos, not just the order. Next: get_product, then get_placement_options / place_item.' : 'No match: loosen category / maxPrice.',
          },
          content,
        );
      },
    },
  ];
}
