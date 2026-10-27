import { z } from 'zod';
import { Command, CommandEnvelope } from './commands/schema';
import { Scene } from './schema';
import { CameraPose, LightingView } from './view';

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
/**
 * Ephemeral view relay (M4, `sync_to_user_tab`): the MCP server asks the user's tab to show a camera
 * pose and/or lighting. NOT logged, NOT part of the scene, not replayed to late joiners; the tab
 * applies it only while "Follow assistant view" is on. `seq` increases per server process so a tab
 * can drop stale or reordered messages.
 */
export const ViewMsg = z.object({
  type: z.literal('view'),
  seq: z.number().int().nonnegative(),
  /** Who asked, for the UI (e.g. the MCP client name). */
  from: z.string().max(200).optional(),
  pose: CameraPose.optional(),
  /** Partial lighting view merged into the tab's lighting. */
  lighting: LightingView.partial().optional(),
});
export const ServerMsg = z.discriminatedUnion('type', [HelloMsg, AppliedMsg, ResetMsg, PongMsg, ViewMsg]);
export const PingMsg = z.object({ type: z.literal('ping') });
export const ClientMsg = z.discriminatedUnion('type', [PingMsg]);
export type HelloMsg = z.infer<typeof HelloMsg>;
export type AppliedMsg = z.infer<typeof AppliedMsg>;
export type ResetMsg = z.infer<typeof ResetMsg>;
export type ViewMsg = z.infer<typeof ViewMsg>;
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

/** Body of `POST /api/view`: relayed to every WebSocket client as a `ViewMsg`. At least one of `pose` / `lighting`. */
export const PostViewBody = z
  .object({
    pose: CameraPose.optional(),
    lighting: LightingView.partial().optional(),
    from: z.string().max(200).optional(),
  })
  .refine((b) => b.pose !== undefined || b.lighting !== undefined, { message: 'send pose and/or lighting' });
export type PostViewBody = z.infer<typeof PostViewBody>;
/** Response of `POST /api/view`: how many clients received it. */
export const PostViewResponse = z.object({ ok: z.literal(true), delivered: z.number().int().nonnegative() });
export type PostViewResponse = z.infer<typeof PostViewResponse>;

/**
 * Named checkpoint of the shared history (M4.7). `depth` is the undo-stack length when it was taken,
 * so `undo-to` undoes entries (whoever made them: the stack is shared) until the stack is that deep
 * again. A checkpoint survives restarts (it is persisted with the snapshot) and dies with its epoch.
 */
export const Checkpoint = z.object({
  name: z.string().min(1).max(80),
  rev: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  depth: z.number().int().nonnegative(),
  ts: z.number(),
  author: CommandEnvelope.shape.author,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/** Body of `POST /api/checkpoints`. An existing name is moved to the current state. */
export const PostCheckpointBody = z.object({
  name: z.string().min(1).max(80),
  author: CommandEnvelope.shape.author.optional(),
});
export type PostCheckpointBody = z.infer<typeof PostCheckpointBody>;
/** Response of `POST /api/checkpoints`. */
export const PostCheckpointResponse = z.object({ ok: z.literal(true), epoch: z.string(), checkpoint: Checkpoint });
export type PostCheckpointResponse = z.infer<typeof PostCheckpointResponse>;
/** Response of `GET /api/checkpoints`, oldest first. */
export const CheckpointsResponse = z.object({ epoch: z.string(), rev: z.number().int().nonnegative(), checkpoints: z.array(Checkpoint) });
export type CheckpointsResponse = z.infer<typeof CheckpointsResponse>;

/**
 * Body of `POST /api/undo-to`: undoes until the history is back at the checkpoint's depth. Atomic
 * from the client's view (one request; each undone entry is still logged as an undo). 404 for an
 * unknown checkpoint, 409 when the stack is already shallower than the checkpoint (nothing to
 * undo) or `ifRev` is stale. Redo works afterwards.
 */
export const UndoToBody = z.object({
  checkpoint: z.string().min(1).max(80),
  id: z.string().min(1).max(64).optional(),
  author: CommandEnvelope.shape.author.optional(),
  ifRev: z.number().int().nonnegative().optional(),
});
export type UndoToBody = z.infer<typeof UndoToBody>;
/** Response of `POST /api/undo-to`: the last step's outcome plus how many entries were undone. */
export const UndoToResponse = PostCommandResponse.extend({ steps: z.number().int().nonnegative() });
export type UndoToResponse = z.infer<typeof UndoToResponse>;
