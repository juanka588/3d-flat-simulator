import type { McpServer } from '@modelcontextprotocol/server';
import { CONVENTIONS_MD } from './conventions';
import type { FlatApi } from './flatApi';
import { apiFailure } from './errors';
import { buildMaterialListing, buildSummary } from './readModel';
import { registerStyleResources } from './stylesMcp';
import type { McpSession } from './tools';
import { authorText } from './tools/common';

/**
 * Resources (M4.4): `scene://current` (the whole scene), `scene://summary` (the brief summary),
 * `scene://history` (undo/redo stacks and checkpoints), `materials://list` (library + scene materials),
 * `docs://conventions` (plan conventions). Read-only; failures are thrown as errors with the tool
 * error's message (resources have no `isError`).
 */

type Deps = { flat: FlatApi; session: McpSession };

function fail(result: ReturnType<typeof apiFailure>): never {
  const body = result.structuredContent as { code?: string; message?: string; hint?: string } | undefined;
  throw new Error(`${body?.code ?? 'error'}: ${body?.message ?? 'request failed'}${body?.hint ? ` (${body.hint})` : ''}`);
}

export const RESOURCE_URIS = ['scene://current', 'scene://summary', 'scene://history', 'materials://list', 'docs://conventions'] as const;

export function registerResources(server: McpServer, deps: Deps): void {
  const json = (uri: URL, data: unknown) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }] });

  server.registerResource('current-scene', 'scene://current', { title: 'Current scene', description: 'The whole scene as JSON (walls, openings, rooms, lights, materials) with its epoch and revision. Can be large: prefer get_scene_summary.', mimeType: 'application/json' }, async (uri) => {
    const r = await deps.flat.getScene();
    if (!r.ok) fail(apiFailure(r));
    return json(uri, r.data);
  });

  server.registerResource('scene-summary', 'scene://summary', { title: 'Scene summary', description: 'Brief overview of the flat (same as get_scene_summary).', mimeType: 'application/json' }, async (uri) => {
    const s = await buildSummary(deps, 'brief');
    if (!s.ok) fail(s.result);
    return json(uri, s.data);
  });

  server.registerResource('scene-history', 'scene://history', { title: 'History and checkpoints', description: 'Undo and redo stacks (shared with the user) and the named checkpoints.', mimeType: 'application/json' }, async (uri) => {
    const h = await deps.flat.history();
    if (!h.ok) fail(apiFailure(h));
    const cps = await deps.flat.listCheckpoints();
    const item = (e: { id: string; label: string; ts: number; author: { kind: string; name?: string | undefined } }) => ({ id: e.id, label: e.label, ts: e.ts, author: authorText(e.author) });
    return json(uri, {
      rev: h.data.rev,
      canUndo: h.data.canUndo,
      canRedo: h.data.canRedo,
      past: h.data.past.map(item),
      redoNext: [...h.data.future].reverse().map(item),
      checkpoints: cps.ok ? cps.data.checkpoints.map((c) => ({ name: c.name, rev: c.rev, depth: c.depth, ts: c.ts, author: authorText(c.author) })) : [],
    });
  });

  server.registerResource('materials-list', 'materials://list', { title: 'Materials', description: 'Library textures (slug | name | category | tile size | colour | roughness) and the flat\'s own materials.', mimeType: 'text/plain' }, async (uri) => {
    const m = await buildMaterialListing(deps);
    if (!m.ok) fail(m.result);
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: m.data.text }] };
  });

  server.registerResource('conventions', 'docs://conventions', { title: 'Plan conventions', description: 'Units, orientation, left/right, finish precedence, structural rules.', mimeType: 'text/markdown' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: CONVENTIONS_MD }],
  }));
  registerStyleResources(server);
}
