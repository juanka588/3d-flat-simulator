import { applyCommand, serializeScene } from '@flat/scene';
import type { Changed, CommandEnvelope, CommandError, Scene } from '@flat/scene';

/**
 * Pure client-side sync state machine (M3.12): no DOM, no WebSocket, no fetch.
 *
 * The server log defines order. The client keeps `confirmed` (the scene at `confirmedRev` of
 * `epoch`) plus `pending` (local envelopes sent but not yet seen in the log). What the user sees is
 * `pending` replayed over `confirmed` with the reducer. Remote entries advance `confirmed` and the
 * pending queue is rebased on top; a pending command that no longer applies is dropped and reported.
 * Last writer wins at command granularity.
 */

export type SyncStatus = 'connecting' | 'connected' | 'reconnecting' | 'conflict';

export interface PendingCommand {
  envelope: CommandEnvelope;
}

/** The server's scene under a different epoch, waiting for the user's decision. */
export interface Conflict {
  epoch: string;
  rev: number;
  scene: Scene;
  /** Local edits that would be lost by "Use server scene". */
  pendingCount: number;
}

export interface SyncState {
  confirmed: Scene | null;
  confirmedRev: number;
  epoch: string | null;
  pending: PendingCommand[];
  status: SyncStatus;
  conflict: Conflict | null;
  canUndo: boolean;
  canRedo: boolean;
}

export type SyncNotice =
  /** The server refused a command we sent. */
  | { kind: 'rejected'; envelope: CommandEnvelope; errors: CommandError[] }
  /** A pending command no longer applies after remote edits (e.g. its target was deleted). */
  | { kind: 'conflict'; envelope: CommandEnvelope; errors: CommandError[] }
  /** "Use server scene" threw away local edits. */
  | { kind: 'discarded'; count: number };

export interface SyncHost {
  /** Transmit a pending envelope (idempotent by id: the host may be asked again after a reconnect). */
  send: (envelope: CommandEnvelope) => void;
  /** The displayed scene changed because of remote data. `replace` = whole-scene swap (hello, snapshot). */
  display: (scene: Scene, changed: Changed, opts: { replace: boolean }) => void;
  notice: (notice: SyncNotice) => void;
  /** Entries after `since` are needed (`GET /api/log?since=`); answer with `onLog`. */
  needCatchUp: (since: number) => void;
  /** The full scene is needed (`GET /api/scene`); answer with `onSnapshot`. */
  needSnapshot: () => void;
  /** State changed (for the UI). */
  changed?: (state: SyncState) => void;
}

export interface AppliedInput {
  epoch: string;
  seq: number;
  rev: number;
  envelope: CommandEnvelope;
  undoOf?: string | undefined;
  redoOf?: string | undefined;
}
export interface SceneInput {
  epoch: string;
  rev: number;
  scene: Scene;
}
export interface LogInput {
  epoch: string;
  rev: number;
  entries: AppliedInput[];
  truncated: boolean;
}

export type CommandOutcome =
  /** 200: applied (an `applied` message follows) or a no-op (nothing follows). */
  | { kind: 'ok'; noop: boolean }
  /** 4xx: the server will never apply this command. */
  | { kind: 'rejected'; errors: CommandError[] };

const NO_CHANGE: Changed = { materials: [], walls: [], rooms: [], lights: [], site: false, defaults: false };

function union(a: string[], b: string[]): string[] {
  return b.length ? [...new Set([...a, ...b])] : a;
}
export function mergeChanged(a: Changed, b: Changed): Changed {
  return {
    materials: union(a.materials, b.materials),
    walls: union(a.walls, b.walls),
    rooms: union(a.rooms, b.rooms),
    lights: union(a.lights, b.lights),
    site: a.site || b.site,
    defaults: a.defaults || b.defaults,
  };
}
/** "Anything may have changed" (rebuilds the shell, keeps the camera). */
export const EVERYTHING: Changed = { materials: ['*'], walls: ['*'], rooms: ['*'], lights: ['*'], site: true, defaults: true };

/** Replays `pending` over `base`; commands that fail are returned in `dropped`. */
export function replay(
  base: Scene,
  pending: readonly PendingCommand[],
): { scene: Scene; changed: Changed; kept: PendingCommand[]; dropped: { envelope: CommandEnvelope; errors: CommandError[] }[] } {
  let scene = base;
  let changed = NO_CHANGE;
  const kept: PendingCommand[] = [];
  const dropped: { envelope: CommandEnvelope; errors: CommandError[] }[] = [];
  for (const p of pending) {
    const r = applyCommand(scene, p.envelope);
    if (!r.ok) {
      dropped.push({ envelope: p.envelope, errors: r.errors });
      continue;
    }
    scene = r.scene;
    changed = mergeChanged(changed, r.changed);
    kept.push(p);
  }
  return { scene, changed, kept, dropped };
}

export class SyncCore {
  confirmed: Scene | null = null;
  confirmedRev = 0;
  epoch: string | null = null;
  pending: PendingCommand[] = [];
  status: SyncStatus = 'connecting';
  conflict: Conflict | null = null;
  private serverCanUndo = false;
  private serverCanRedo = false;
  /** Set while "Keep mine" is in flight: the serialized scene we asked the server to adopt. */
  private overwriting: { scene: Scene; text: string; pendingIds: Set<string> } | null = null;
  /** "Use server scene" is waiting for a fresh snapshot (the held one went stale). */
  private adopting = false;
  /** A catch-up is needed before resuming (sending pending). */
  private catchingUp = false;

  constructor(private readonly host: SyncHost) {}

  get state(): SyncState {
    return {
      confirmed: this.confirmed,
      confirmedRev: this.confirmedRev,
      epoch: this.epoch,
      pending: this.pending,
      status: this.status,
      conflict: this.conflict,
      canUndo: this.serverCanUndo || this.pending.length > 0,
      canRedo: this.serverCanRedo && this.pending.length === 0,
    };
  }

  /** The scene to show: `pending` replayed over `confirmed` (null before the first hello). */
  display(): Scene | null {
    return this.confirmed ? replay(this.confirmed, this.pending).scene : null;
  }

  private emit(): void {
    this.host.changed?.(this.state);
  }

  // ---- local side -------------------------------------------------------------------------

  /** A command the user applied locally (the host already showed it). Sends it when connected. */
  local(envelope: CommandEnvelope): void {
    this.pending.push({ envelope });
    if (this.status === 'connected') this.host.send(envelope);
    this.emit();
  }

  /** History flags as reported by `GET /api/history`. */
  setHistoryFlags(canUndo: boolean, canRedo: boolean): void {
    this.serverCanUndo = canUndo;
    this.serverCanRedo = canRedo;
    this.emit();
  }

  /** The HTTP outcome for a command we sent. */
  onResponse(id: string, outcome: CommandOutcome): void {
    const i = this.pending.findIndex((p) => p.envelope.id === id);
    if (i < 0) return; // already confirmed through the log
    if (outcome.kind === 'ok') {
      // A no-op changes no revision and is never broadcast: nothing else will remove it.
      if (outcome.noop) {
        this.pending.splice(i, 1);
        // The effect may only be in log entries we have not received yet: show what is confirmed.
        this.rebaseAndShow(NO_CHANGE, { forceAll: true, replace: false });
      }
      return;
    }
    const [removed] = this.pending.splice(i, 1);
    this.host.notice({ kind: 'rejected', envelope: removed!.envelope, errors: outcome.errors });
    this.rebaseAndShow(NO_CHANGE, { forceAll: true, replace: false });
  }

  // ---- server side ---------------------------------------------------------------------------

  onHello(h: SceneInput): void {
    this.onSceneMessage(h);
  }

  /** `reset` (an import replaced the scene) is handled like a hello. */
  onReset(r: SceneInput): void {
    if (this.overwriting && serializeScene(r.scene) === this.overwriting.text) {
      this.finishOverwrite({ epoch: r.epoch, rev: r.rev });
      return;
    }
    this.onSceneMessage(r);
  }

  private onSceneMessage(m: SceneInput): void {
    if (this.epoch === null) {
      this.adopt(m);
      return;
    }
    if (m.epoch !== this.epoch) {
      this.enterConflict(m);
      return;
    }
    // Same epoch (a reconnect, or an echo of our own state).
    this.conflict = null;
    if (m.rev === this.confirmedRev) this.resume();
    else if (m.rev < this.confirmedRev) this.adopt(m); // the server lost entries: it wins
    else {
      this.catchingUp = true;
      this.status = 'reconnecting';
      this.host.needCatchUp(this.confirmedRev);
      this.emit();
    }
  }

  /** The socket went away; local edits keep working and queue up. */
  onDisconnect(): void {
    if (this.status !== 'conflict') this.status = 'reconnecting';
    this.catchingUp = false;
    this.emit();
  }

  onApplied(msg: AppliedInput): void {
    if (this.epoch === null || msg.epoch !== this.epoch) {
      if (this.conflict && msg.epoch === this.conflict.epoch) this.trackConflict(msg);
      return; // an unknown epoch is announced by a hello / reset
    }
    if (this.status === 'conflict') return;
    if (msg.seq <= this.confirmedRev) return; // already known (catch-up overlap)
    if (msg.seq !== this.confirmedRev + 1) {
      this.host.needCatchUp(this.confirmedRev);
      return;
    }
    const wasOldest = this.pending[0]?.envelope.id === msg.envelope.id;
    const changed = this.applyConfirmed(msg);
    if (!changed) return;
    // Our oldest command, now official: the displayed scene already equals the new replay.
    if (wasOldest) this.emit();
    else this.rebaseAndShow(changed, { forceAll: false, replace: false });
  }

  /** Answer to `needCatchUp`. */
  onLog(log: LogInput): void {
    if (this.epoch === null || log.epoch !== this.epoch) {
      // The server was replaced between hello and the log fetch.
      this.host.needSnapshot();
      return;
    }
    if (log.truncated) {
      this.host.needSnapshot();
      return;
    }
    let changed = NO_CHANGE;
    for (const entry of log.entries) {
      if (entry.seq <= this.confirmedRev) continue;
      if (entry.seq !== this.confirmedRev + 1) {
        this.host.needSnapshot();
        return;
      }
      const c = this.applyConfirmed(entry);
      if (!c) return;
      changed = mergeChanged(changed, c);
    }
    this.rebaseAndShow(changed, { forceAll: false, replace: false });
    this.catchingUp = false;
    this.resume();
  }

  /** Answer to `needSnapshot` (`GET /api/scene`), or a hello that rolled back. */
  onSnapshot(s: SceneInput): void {
    if (this.epoch !== null && s.epoch !== this.epoch && !this.adopting) {
      this.enterConflict(s);
      return;
    }
    this.adopting = false;
    this.adopt(s);
  }

  /** Applies one log entry to `confirmed` and drops it from pending; null when our copy diverged. */
  private applyConfirmed(msg: AppliedInput): Changed | null {
    const r = applyCommand(this.confirmed!, msg.envelope, { rev: this.confirmedRev });
    if (!r.ok) {
      // The reducer disagrees with the server: our copy diverged. Resync from the full scene.
      this.host.needSnapshot();
      return null;
    }
    this.confirmed = r.scene;
    this.confirmedRev = msg.rev;
    this.noteHistory(msg);
    const own = this.pending.findIndex((p) => p.envelope.id === msg.envelope.id);
    if (own >= 0) this.pending.splice(own, 1);
    return r.changed;
  }

  private noteHistory(msg: AppliedInput): void {
    if (msg.undoOf !== undefined) {
      this.serverCanRedo = true;
    } else if (msg.redoOf !== undefined) {
      this.serverCanUndo = true;
    } else {
      this.serverCanUndo = true;
      this.serverCanRedo = false;
    }
  }

  /** Replays pending over confirmed and shows the result; dropped commands are reported. */
  private rebaseAndShow(remote: Changed, opts: { forceAll: boolean; replace: boolean }): void {
    if (!this.confirmed) return;
    const r = replay(this.confirmed, this.pending);
    this.pending = r.kept;
    for (const d of r.dropped) this.host.notice({ kind: 'conflict', envelope: d.envelope, errors: d.errors });
    // A dropped command un-does something that was shown: treat everything as changed.
    const changed = opts.forceAll || r.dropped.length ? EVERYTHING : mergeChanged(remote, r.changed);
    this.host.display(r.scene, changed, { replace: opts.replace });
    this.emit();
  }

  /** Takes the server's scene as the confirmed one. */
  private adopt(s: SceneInput): void {
    this.epoch = s.epoch;
    this.confirmed = s.scene;
    this.confirmedRev = s.rev;
    this.conflict = null;
    this.catchingUp = false;
    // Pending commands that are already in the server log would be applied twice; they are
    // idempotent by id on the server, and replay simply drops the ones that no longer apply.
    this.rebaseAndShow(NO_CHANGE, { forceAll: true, replace: true });
    this.resume();
  }

  /** Connected and in sync: (re)send what the server may not have seen. */
  private resume(): void {
    if (this.catchingUp || this.epoch === null) return;
    this.status = 'connected';
    this.emit();
    for (const p of [...this.pending]) this.host.send(p.envelope);
  }

  // ---- epoch change ------------------------------------------------------------------------

  private enterConflict(m: SceneInput): void {
    this.status = 'conflict';
    this.conflict = { epoch: m.epoch, rev: m.rev, scene: m.scene, pendingCount: this.pending.length };
    this.emit();
  }

  /** While waiting for the decision, keep the held server scene current. */
  private trackConflict(msg: AppliedInput): void {
    const c = this.conflict;
    if (!c) return;
    if (msg.seq <= c.rev) return;
    const r = msg.seq === c.rev + 1 ? applyCommand(c.scene, msg.envelope, { rev: c.rev }) : null;
    if (r?.ok) this.conflict = { ...c, scene: r.scene, rev: msg.rev };
    else this.conflict = { ...c, rev: -1 }; // stale: refetch on "Use server scene"
  }

  /** "Use server scene": drop local edits and show the server's. */
  useServerScene(): void {
    const c = this.conflict;
    if (!c) return;
    if (c.rev < 0) {
      this.adopting = true;
      this.host.needSnapshot();
      this.discardPending();
      return;
    }
    this.discardPending();
    this.adopt({ epoch: c.epoch, rev: c.rev, scene: c.scene });
  }

  private discardPending(): void {
    if (this.pending.length) this.host.notice({ kind: 'discarded', count: this.pending.length });
    this.pending = [];
  }

  /**
   * "Keep mine" (or a local import): returns the scene to `PUT /api/scene` (the displayed one unless
   * `scene` is given). Call `finishOverwrite` with the server's answer (the `reset` echo does it too),
   * or `abortOverwrite` if the request failed.
   */
  beginOverwrite(scene: Scene | null = this.display() ?? this.conflict?.scene ?? null): Scene | null {
    if (!scene) return null;
    this.overwriting = { scene, text: serializeScene(scene), pendingIds: new Set(this.pending.map((p) => p.envelope.id)) };
    return scene;
  }

  finishOverwrite(r: { epoch: string; rev: number }): void {
    const o = this.overwriting;
    if (!o) return;
    this.overwriting = null;
    this.epoch = r.epoch;
    this.confirmed = o.scene;
    this.confirmedRev = r.rev;
    this.conflict = null;
    this.serverCanUndo = false;
    this.serverCanRedo = false;
    // Edits made while the PUT was in flight are not in the uploaded scene: they stay pending
    // (the displayed scene is unchanged: confirmed + those edits is what the user already sees).
    this.pending = this.pending.filter((p) => !o.pendingIds.has(p.envelope.id));
    this.resume();
  }

  abortOverwrite(): void {
    this.overwriting = null;
  }
}
