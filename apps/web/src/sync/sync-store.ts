import { create } from 'zustand';
import type { SyncStatus } from './sync-core';

export interface Notice {
  id: number;
  kind: 'info' | 'warning' | 'error';
  text: string;
}

export interface ConflictInfo {
  epoch: string;
  rev: number;
  /** Local edits that "Use server scene" would discard. */
  pendingCount: number;
}

/** What the UI and the test hook know about the sync lane. */
interface SyncUi {
  mode: 'local' | 'server';
  /** Origin of the connected server (no trailing slash); null in Local mode. The viewer fetches provider models from it. */
  serverUrl: string | null;
  status: SyncStatus;
  rev: number;
  epoch: string | null;
  pending: number;
  conflict: ConflictInfo | null;
  notices: Notice[];
  /** Resolves a conflict; null in local mode. */
  resolve: { useServer: () => void; keepMine: () => void } | null;
  pushNotice: (kind: Notice['kind'], text: string) => void;
  dismissNotice: (id: number) => void;
}

let nextNotice = 1;
const MAX_NOTICES = 4;

export const useSyncStore = create<SyncUi>((set) => ({
  mode: 'local',
  serverUrl: null,
  status: 'connecting',
  rev: 0,
  epoch: null,
  pending: 0,
  conflict: null,
  notices: [],
  resolve: null,
  pushNotice: (kind, text) => set((s) => ({ notices: [...s.notices, { id: nextNotice++, kind, text }].slice(-MAX_NOTICES) })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));

/** Text of the status chip. */
export function statusLabel(s: Pick<SyncUi, 'mode' | 'status' | 'rev'>): string {
  if (s.mode === 'local') return 'Local';
  switch (s.status) {
    case 'connected':
      return `Connected · rev ${s.rev}`;
    case 'conflict':
      return 'Conflict: choose';
    case 'reconnecting':
      return 'Reconnecting…';
    default:
      return 'Connecting…';
  }
}

export function connectionInfo(): { mode: 'local' | 'server'; status: SyncStatus | 'local'; rev: number; epoch: string | null; pending: number } {
  const s = useSyncStore.getState();
  return { mode: s.mode, status: s.mode === 'local' ? 'local' : s.status, rev: s.rev, epoch: s.epoch, pending: s.pending };
}
