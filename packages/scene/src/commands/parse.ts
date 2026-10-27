import { z } from 'zod';
import {
  COMMAND_SCHEMA_BY_TYPE,
  COMMAND_TYPES,
  Command,
  CommandEnvelope,
  EnvelopeShell,
  RESERVED_COMMAND_TYPES,
  TRUSTED_BATCH,
  TrustedCommandEnvelope,
  type Author,
  type Command as CommandT,
} from './schema';
import { err, type CommandError } from './util';

/** Envelope version this build understands. */
export const ENVELOPE_VERSION = 1;

export type ParseCommandResult = { ok: true; envelope: CommandEnvelope } | { ok: false; errors: CommandError[] };

const pathOf = (path: readonly PropertyKey[]) => path.map(String).join('/');

function zodErrors(error: z.ZodError, prefix: string): CommandError[] {
  return error.issues.map((issue) => {
    const sub = pathOf(issue.path);
    const path = [prefix, sub].filter(Boolean).join('/');
    let message = issue.message;
    if (issue.code === 'unrecognized_keys') message = `unknown key(s) ${issue.keys.map((k) => `"${k}"`).join(', ')}`;
    return err('invalid_command', path, message);
  });
}

/**
 * Upgrades an older envelope to the current version. Only v1 exists, so this rejects
 * versions it cannot understand; later versions add `case` branches here.
 */
export function migrateCommand(input: unknown): { ok: true; envelope: unknown } | { ok: false; errors: CommandError[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [err('invalid_command', '', 'command envelope must be an object')] };
  }
  const v = (input as { v?: unknown }).v;
  if (typeof v === 'number' && v > ENVELOPE_VERSION) {
    return {
      ok: false,
      errors: [err('invalid_command', 'v', `envelope version ${v} is newer than supported (${ENVELOPE_VERSION})`, 'upgrade this app or send v:1')],
    };
  }
  if (v !== ENVELOPE_VERSION) {
    return { ok: false, errors: [err('invalid_command', 'v', `envelope version must be ${ENVELOPE_VERSION}`, 'send {"v":1,...}')] };
  }
  return { ok: true, envelope: input };
}

function parseCmd(cmd: unknown, prefix: string, nested: boolean, trusted: boolean): CommandError[] {
  if (typeof cmd !== 'object' || cmd === null || Array.isArray(cmd)) {
    return [err('invalid_command', prefix, 'command must be an object with a "type"')];
  }
  const type = (cmd as { type?: unknown }).type;
  const typePath = `${prefix}/type`;
  if (typeof type !== 'string') {
    return [err('invalid_command', typePath, 'missing command "type"', `valid types: ${COMMAND_TYPES.join(', ')}`)];
  }
  if (nested && type === 'batch') {
    return [err('invalid_command', typePath, 'batches cannot be nested', 'put the commands directly in one batch')];
  }
  // Own keys only: "constructor" or "__proto__" must not resolve through the prototype chain.
  const reserved = Object.hasOwn(RESERVED_COMMAND_TYPES, type) ? RESERVED_COMMAND_TYPES[type] : undefined;
  if (reserved) return [err('not_supported', typePath, `command "${type}" is not supported yet`, reserved)];
  const schema = type === 'batch' && trusted ? TRUSTED_BATCH : COMMAND_SCHEMA_BY_TYPE.get(type);
  if (!schema) {
    return [err('invalid_command', typePath, `unknown command type "${type}"`, `valid types: ${COMMAND_TYPES.join(', ')}`)];
  }
  if (type === 'batch') {
    const body = cmd as { commands?: unknown };
    if (Array.isArray(body.commands)) {
      const errors: CommandError[] = [];
      body.commands.forEach((c, i) => errors.push(...parseCmd(c, `${prefix}/commands/${i}`, true, trusted)));
      if (errors.length) return errors;
    }
  }
  const r = schema.safeParse(cmd);
  return r.success ? [] : zodErrors(r.error, prefix);
}

export interface ParseOptions {
  /**
   * Internal: accept batches above the 500-command cap. Only for commands that history generated
   * itself (inverses); every payload is still validated. Never set it for external input.
   */
  trusted?: boolean;
}

/** Validates an unknown value as a command envelope. Never throws; errors are readable and carry codes. */
export function parseCommand(input: unknown, options: ParseOptions = {}): ParseCommandResult {
  const trusted = options.trusted === true;
  try {
    const migrated = migrateCommand(input);
    if (!migrated.ok) return migrated;
    const shell = EnvelopeShell.safeParse(migrated.envelope);
    const errors: CommandError[] = shell.success ? [] : zodErrors(shell.error, '');
    const cmd = (migrated.envelope as { cmd?: unknown }).cmd;
    errors.push(...parseCmd(cmd, 'cmd', false, trusted));
    if (errors.length) return { ok: false, errors };
    const full = (trusted ? TrustedCommandEnvelope : CommandEnvelope).safeParse(migrated.envelope);
    if (!full.success) return { ok: false, errors: zodErrors(full.error, '') };
    return { ok: true, envelope: full.data };
  } catch (e) {
    return { ok: false, errors: [err('invalid_command', '', `could not parse command: ${e instanceof Error ? e.message : String(e)}`)] };
  }
}

/** Builds an envelope; ids and timestamps are supplied by the caller (the reducer never reads a clock). */
export function makeEnvelope(
  cmd: CommandT,
  meta: { id: string; ts: number; author?: Author; coalesceKey?: string; ifRev?: number },
): CommandEnvelope {
  return {
    v: 1,
    id: meta.id,
    ts: meta.ts,
    author: meta.author ?? { kind: 'user' },
    ...(meta.coalesceKey !== undefined ? { coalesceKey: meta.coalesceKey } : {}),
    ...(meta.ifRev !== undefined ? { ifRev: meta.ifRev } : {}),
    cmd,
  };
}

/**
 * JSON Schema of the full command union, as zod emits it (used by the contract snapshot and for
 * documentation). It is NOT usable as an LLM tool schema (`oneOf` root, nullable as `anyOf`); use
 * `commandToolSchemas()` for tools.
 */
export function commandJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Command, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

/** JSON Schema of the whole envelope. */
export function envelopeJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(CommandEnvelope, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}
