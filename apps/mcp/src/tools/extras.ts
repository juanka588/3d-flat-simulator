import type { CallToolResult } from '@modelcontextprotocol/server';
import { toolError } from '../errors';

/**
 * The arguments every WRITE tool accepts besides its command fields (M4.5 / M4.6):
 *  - `preview`: compute the change against a fresh scene and return the diff; nothing is committed;
 *  - `render`: also return an image after the change: `true` = the overview of the first changed room
 *    (else the whole flat from above), or `render_view` arguments (validated against the same schema);
 *  - `ifRev`: optimistic concurrency, apply only if the flat is still at that revision (`stale_scene` otherwise);
 *  - `label`: short description shown in the undo history. Leaf tools only; `batch` already has a
 *    required `label`, which is left untouched.
 * They are injected into the advertised schema by `withMcpExtras` and stripped by `splitExtras`
 * before the arguments become a command.
 */

const PREVIEW = { type: 'boolean', description: 'true: change nothing, return what the change would do (diff, warnings, would-be changed ids).' };
const RENDER = {
  anyOf: [{ type: 'boolean' }, { type: 'object', additionalProperties: true }],
  description: 'true, or render_view arguments: also return an image of the result (or of the previewed state). true = overview of the first changed room, else the flat from above.',
};
const IFREV = { type: 'integer', minimum: 0, description: 'Apply only if the flat is still at this revision (rev of a result, baseRev of a preview), else stale_scene and nothing changes.' };
const LABEL = { type: 'string', minLength: 1, maxLength: 200, description: 'Short description of this change for the undo history.' };

type Json = Record<string, unknown>;

/** Pure: a copy of a tool input schema with `preview`, `render` (and `label` when absent) added. */
export function withMcpExtras<T extends Json>(schema: T): T {
  const props = (schema.properties ?? {}) as Json;
  for (const k of ['preview', 'render', 'ifRev']) if (k in props) throw new Error(`schema already has a "${k}" property`);
  const extra: Json = { preview: PREVIEW, render: RENDER, ifRev: IFREV };
  if (!('label' in props)) extra.label = LABEL;
  return { ...schema, properties: { ...props, ...extra } };
}

export interface Extras {
  preview: boolean;
  render: true | Json | undefined;
  ifRev: number | undefined;
  /** Present only for leaf tools. */
  label: string | undefined;
}

/** Separates the extras from the command fields; a malformed extra is an `invalid_command`. */
export function splitExtras(args: Json, opts: { labelIsExtra: boolean }): { ok: true; extras: Extras; rest: Json } | { ok: false; result: CallToolResult } {
  const { preview, render, ifRev, ...others } = args;
  const bad = (path: string, message: string) => ({ ok: false as const, result: toolError('invalid_command', `${path}: ${message}`, undefined, { errors: [{ code: 'invalid_command', path, message }] }) });
  if (preview !== undefined && typeof preview !== 'boolean') return bad('preview', 'expected true or false');
  let renderSpec: true | Json | undefined;
  if (render === true) renderSpec = true;
  else if (render !== undefined && render !== false) {
    if (typeof render !== 'object' || render === null || Array.isArray(render)) return bad('render', 'expected true, false or an object of render_view arguments');
    renderSpec = render as Json;
  }
  if (ifRev !== undefined && (typeof ifRev !== 'number' || !Number.isInteger(ifRev) || ifRev < 0)) return bad('ifRev', 'expected a non-negative integer revision (baseRev of a preview)');
  let label: string | undefined;
  let rest = others;
  if (opts.labelIsExtra && 'label' in others) {
    const { label: l, ...r } = others;
    if (typeof l !== 'string' || l.trim().length < 1 || l.length > 200) return bad('label', 'expected a string of 1 to 200 characters');
    label = l.trim();
    rest = r;
  }
  return { ok: true, extras: { preview: preview === true, render: renderSpec, ifRev: ifRev as number | undefined, label }, rest };
}
