import type { CallToolResult } from '@modelcontextprotocol/server';
import { toolError } from '../errors';

/**
 * The arguments every WRITE tool accepts besides its command fields (M4.5 / M4.6):
 *  - `preview`: compute the change against a fresh scene and return the diff; nothing is committed;
 *  - `render`: also return an image after the change (lane E; `render_unavailable` until it lands);
 *  - `label`: short description shown in the undo history. Leaf tools only; `batch` already has a
 *    required `label`, which is left untouched.
 * They are injected into the advertised schema by `withMcpExtras` and stripped by `splitExtras`
 * before the arguments become a command.
 */

const PREVIEW = { type: 'boolean', description: 'true: do NOT change the flat; return what the change would do (diff, warnings, would-be changed ids). Use it to show the user before applying.' };
const RENDER = {
  anyOf: [{ type: 'boolean' }, { type: 'object', additionalProperties: true }],
  description: 'true or render_view arguments (view, roomId, ...): also return an image of the result (after the change, or of the previewed state). Without the render service the result carries render_unavailable.',
};
const LABEL = { type: 'string', minLength: 1, maxLength: 200, description: 'Short description of this change, shown in the undo history (at most 200 characters).' };

type Json = Record<string, unknown>;

/** Pure: a copy of a tool input schema with `preview`, `render` (and `label` when absent) added. */
export function withMcpExtras<T extends Json>(schema: T): T {
  const props = (schema.properties ?? {}) as Json;
  for (const k of ['preview', 'render']) if (k in props) throw new Error(`schema already has a "${k}" property`);
  const extra: Json = { preview: PREVIEW, render: RENDER };
  if (!('label' in props)) extra.label = LABEL;
  return { ...schema, properties: { ...props, ...extra } };
}

export interface Extras {
  preview: boolean;
  render: true | Json | undefined;
  /** Present only for leaf tools. */
  label: string | undefined;
}

/** Separates the extras from the command fields; a malformed extra is an `invalid_command`. */
export function splitExtras(args: Json, opts: { labelIsExtra: boolean }): { ok: true; extras: Extras; rest: Json } | { ok: false; result: CallToolResult } {
  const { preview, render, ...others } = args;
  const bad = (path: string, message: string) => ({ ok: false as const, result: toolError('invalid_command', `${path}: ${message}`, undefined, { errors: [{ code: 'invalid_command', path, message }] }) });
  if (preview !== undefined && typeof preview !== 'boolean') return bad('preview', 'expected true or false');
  let renderSpec: true | Json | undefined;
  if (render === true) renderSpec = true;
  else if (render !== undefined && render !== false) {
    if (typeof render !== 'object' || render === null || Array.isArray(render)) return bad('render', 'expected true, false or an object of render_view arguments');
    renderSpec = render as Json;
  }
  let label: string | undefined;
  let rest = others;
  if (opts.labelIsExtra && 'label' in others) {
    const { label: l, ...r } = others;
    if (typeof l !== 'string' || l.trim().length < 1 || l.length > 200) return bad('label', 'expected a string of 1 to 200 characters');
    label = l.trim();
    rest = r;
  }
  return { ok: true, extras: { preview: preview === true, render: renderSpec, label }, rest };
}
