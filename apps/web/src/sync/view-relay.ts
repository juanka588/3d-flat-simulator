import { ViewMsg } from '@flat/scene';
import type { CameraPose, LightingView } from '@flat/scene';
import { useViewStore } from '../state/viewStore';

/** What a view message does to the tab; injectable for tests. */
export interface ViewHost {
  /** The "Follow assistant view" preference. */
  follow: () => boolean;
  /** Epoch of the scene the tab shows, or null. */
  epoch: () => string | null;
  applyPose: (pose: CameraPose) => void;
  applyLighting: (partial: Partial<LightingView>) => void;
}

export type ViewOutcome = 'applied' | 'not-following' | 'stale' | 'foreign-epoch' | 'invalid';

/**
 * Handles `view` messages of the WebSocket (M4 `sync_to_user_tab`): ephemeral, never part of the scene.
 * - dropped unless "Follow assistant view" is on (the seq is still recorded, so switching it on later does not replay old views);
 * - dropped when the message names another epoch than the displayed scene (`epoch` is optional on the wire);
 * - dropped when `seq` is not newer than the last one seen on this connection (the server restarts its
 *   counter with the process, so `reset()` is called on every `hello`).
 * Lighting only touches the lighting view (never the scene), and only the keys the message carries:
 * the schema's `.partial()` still fills defaults for absent keys, so the raw keys decide.
 */
export class ViewRelay {
  private lastSeq = -1;

  constructor(private readonly host: ViewHost) {}

  reset(): void {
    this.lastSeq = -1;
  }

  handle(raw: unknown): ViewOutcome {
    const parsed = ViewMsg.safeParse(raw);
    if (!parsed.success) return 'invalid';
    const msg = parsed.data;
    const epoch = (raw as { epoch?: unknown }).epoch;
    const mine = this.host.epoch();
    if (typeof epoch === 'string' && mine !== null && epoch !== mine) return 'foreign-epoch';
    if (msg.seq <= this.lastSeq) return 'stale';
    this.lastSeq = msg.seq;
    if (!this.host.follow()) return 'not-following';
    if (msg.pose) this.host.applyPose(msg.pose);
    const rawLighting = (raw as { lighting?: Record<string, unknown> }).lighting;
    if (msg.lighting && rawLighting) {
      const partial: Record<string, unknown> = {};
      for (const key of Object.keys(rawLighting)) partial[key] = (msg.lighting as Record<string, unknown>)[key];
      this.host.applyLighting(partial as Partial<LightingView>);
    }
    return 'applied';
  }
}

/** A relay wired to the view store; `epoch` tells which scene epoch the tab shows. */
export function createViewRelay(epoch: () => string | null): ViewRelay {
  return new ViewRelay({
    follow: () => useViewStore.getState().followAssistant,
    epoch,
    applyPose: (pose) => useViewStore.getState().setCamera(pose),
    applyLighting: (partial) => useViewStore.getState().setLighting(partial),
  });
}

let active: ViewRelay | null = null;

/** The relay of the connected sync client, or null in local mode (the test hook injects through it). */
export function activeViewRelay(): ViewRelay | null {
  return active;
}

export function setActiveViewRelay(relay: ViewRelay | null): void {
  active = relay;
}
