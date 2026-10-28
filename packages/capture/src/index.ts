import type { CommandEnvelope, Scene } from '@flat/scene';
import type { CaptureAsset, Observation } from './schema';

export * from './schema';

/** Turns a capture into observations. Implementations are local-only (see README, privacy rule). */
export interface CaptureImporter {
  observe(asset: CaptureAsset): Promise<Observation[]>;
}

export interface ObservationsToCommandsOptions {
  /** Envelope timestamp (ms). Defaults to `Date.now()`. */
  ts?: number;
  /** Envelope id factory. Defaults to `capture-<ts>-<n>`. */
  newId?: () => string;
}

/**
 * Proposes commands for observations. Never writes a Scene: callers run the result through the normal command
 * pipeline (undo, history, structural guards, MCP preview). Envelopes are authored as `planner`.
 *
 * Today only wall colour samples that carry a matched `materialId` for a room that exists produce a
 * `room.setWallFinish`; every other observation yields no command yet.
 */
export function observationsToCommands(scene: Scene, observations: readonly Observation[], opts: ObservationsToCommandsOptions = {}): CommandEnvelope[] {
  const ts = opts.ts ?? Date.now();
  let n = 0;
  const newId = opts.newId ?? (() => `capture-${ts}-${n++}`);
  const rooms = new Set(scene.rooms.map((r) => r.id));
  const out: CommandEnvelope[] = [];
  for (const o of observations) {
    if (o.type !== 'colour' || o.target.surface !== 'wall' || !o.materialId || !rooms.has(o.target.roomId)) continue;
    out.push({
      v: 1,
      id: newId(),
      ts,
      author: { kind: 'planner', name: 'capture' },
      cmd: { type: 'room.setWallFinish', roomId: o.target.roomId, materialId: o.materialId },
    });
  }
  return out;
}
