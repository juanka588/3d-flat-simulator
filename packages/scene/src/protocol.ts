import { z } from 'zod';
import { Command, CommandEnvelope } from './commands/schema';
import { Scene } from './schema';

/** Wire contract between `apps/server` and its clients (REST bodies and WebSocket messages). */

/** What a command changed; mirrors `Changed` / `ApplyWarning` of the reducer. */
export const ApplyOutcome = z.object({
  changed: z.object({
    materials: z.array(z.string()),
    walls: z.array(z.string()),
    rooms: z.array(z.string()),
    lights: z.array(z.string()),
    site: z.boolean(),
    defaults: z.boolean(),
  }),
  warnings: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })),
  /** True when the command changed nothing (no revision, no log entry). */
  noop: z.literal(true).optional(),
});
export type ApplyOutcome = z.infer<typeof ApplyOutcome>;

const appliedFields = {
  /** Position in the server log of the current epoch (1-based, gapless). */
  seq: z.number().int().positive(),
  /** Scene revision after the entry; equals `seq` within an epoch. */
  rev: z.number().int().positive(),
  envelope: CommandEnvelope,
  /** Command restoring the scene to before this entry. */
  inverse: z.custom<Command>((v) => typeof v === 'object' && v !== null && 'type' in v),
  /** Set when the envelope is an undo / redo of the envelope with this id. */
  undoOf: z.string().optional(),
  redoOf: z.string().optional(),
};

/** First message on every WebSocket connection. */
export const HelloMsg = z.object({ type: z.literal('hello'), epoch: z.string(), rev: z.number().int().nonnegative(), scene: Scene });
/** Broadcast after every applied command / undo / redo, in log order. */
export const AppliedMsg = z.object({ type: z.literal('applied'), epoch: z.string(), ...appliedFields });
/** Broadcast when the scene is replaced by an import (`PUT /api/scene`): clients must resync. */
export const ResetMsg = z.object({ type: z.literal('reset'), epoch: z.string(), rev: z.number().int().nonnegative(), scene: Scene });
export const PongMsg = z.object({ type: z.literal('pong') });
export const ServerMsg = z.discriminatedUnion('type', [HelloMsg, AppliedMsg, ResetMsg, PongMsg]);
export const PingMsg = z.object({ type: z.literal('ping') });
export const ClientMsg = z.discriminatedUnion('type', [PingMsg]);
export type HelloMsg = z.infer<typeof HelloMsg>;
export type AppliedMsg = z.infer<typeof AppliedMsg>;
export type ResetMsg = z.infer<typeof ResetMsg>;
export type ServerMsg = z.infer<typeof ServerMsg>;
export type ClientMsg = z.infer<typeof ClientMsg>;

/** One line of `log.ndjson` and one item of `GET /api/log`. */
export const LogEntry = z.object({ epoch: z.string(), ...appliedFields, result: ApplyOutcome });
export type LogEntry = z.infer<typeof LogEntry>;

/** Response of `POST /api/commands`, `/api/undo` and `/api/redo` on success. */
export const PostCommandResponse = z.object({
  ok: z.literal(true),
  epoch: z.string(),
  rev: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  result: ApplyOutcome,
});
export type PostCommandResponse = z.infer<typeof PostCommandResponse>;

export const ErrorItem = z.object({ code: z.string(), path: z.string(), message: z.string(), hint: z.string().optional() });
/** Error body of every non-2xx response. `rev` is present for `precondition_failed`. */
export const ErrorResponse = z.object({
  ok: z.literal(false),
  errors: z.array(ErrorItem),
  rev: z.number().int().nonnegative().optional(),
  epoch: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const SceneResponse = z.object({ epoch: z.string(), rev: z.number().int().nonnegative(), scene: Scene });
export type SceneResponse = z.infer<typeof SceneResponse>;

export const HistoryItem = z.object({ id: z.string(), label: z.string(), ts: z.number(), author: CommandEnvelope.shape.author });
export const HistoryResponse = z.object({
  epoch: z.string(),
  rev: z.number().int().nonnegative(),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  /** Oldest first; the last item is what `undo` reverts. */
  past: z.array(HistoryItem),
  /** The last item is what `redo` re-applies. */
  future: z.array(HistoryItem),
});
export type HistoryResponse = z.infer<typeof HistoryResponse>;

export const LogResponse = z.object({
  epoch: z.string(),
  rev: z.number().int().nonnegative(),
  entries: z.array(LogEntry),
  /** True when entries older than `since` were compacted away; resync via `GET /api/scene`. */
  truncated: z.boolean(),
});
export type LogResponse = z.infer<typeof LogResponse>;
