import { RenderSpec } from '@flat/scene';
import { z } from 'zod';
import { toolError } from '../errors';
import { READ } from './common';
import type { ToolDef } from './registry';

/**
 * Placeholder for the render tool. It is LISTED with its final name and argument schema (the
 * tools/list snapshot is the contract) and answers `not_implemented`. Lane E replaces it in place
 * (`tools/render.ts`) and removes this file's entry; the read, view and history tools live in
 * `read.ts`, `view.ts` and `history.ts`.
 */

/** Portable JSON Schema for `render_view` derived from `RenderSpec` (no explicit pose, no preview hook: those are internal). */
function renderViewSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(RenderSpec.omit({ pose: true, previewOf: true }), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  void _drop;
  return rest;
}

export function stubTools(): ToolDef[] {
  return [
    {
      name: 'render_view',
      description: 'Render the flat to an image to verify a change: a room overview, a walk-through view, a plan or an orbit view, with chosen date, time or lamps.',
      inputSchema: renderViewSchema(),
      annotations: READ,
      group: 'render',
      mutatesScene: false,
      handler: async () => toolError('not_implemented', 'render_view is not implemented yet in this build'),
    },
  ];
}
