import { fileURLToPath } from 'node:url';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Scene used on first boot (no snapshot yet). */
  sceneFile: string;
  materialsFile: string;
  allowedOrigins: string[];
  /** Extra `Host` names accepted besides loopback (needed for `HOST=0.0.0.0` LAN mode). */
  allowedHosts: string[];
  /** When set, writes need `Authorization: Bearer <token>`. */
  token?: string;
  /** Request body limit for commands/undo/redo, in bytes. */
  bodyLimit: number;
  /** Write requests allowed per client per second. */
  rateLimitPerSec: number;
  maxWsClients: number;
  /** WebSocket ping interval; a client that misses a pong is terminated. */
  wsHeartbeatMs: number;
  snapshotDebounceMs: number;
  /** Compact (snapshot + truncate the log) once the log holds this many entries. */
  compactAfter: number;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export const DEFAULT_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: env.HOST || '127.0.0.1',
    port: env.PORT ? Number(env.PORT) : 8787,
    dataDir: env.DATA_DIR || here('../data'),
    sceneFile: env.SCENE_FILE || here('../../../packages/scene/fixtures/charme-3205.flat.json'),
    materialsFile: env.MATERIALS_FILE || here('../../web/public/materials/catalog.json'),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedHosts: (env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    token: env.FLAT_TOKEN || undefined,
    bodyLimit: 2 * 1024 * 1024,
    rateLimitPerSec: env.RATE_LIMIT ? Number(env.RATE_LIMIT) : 200,
    maxWsClients: 50,
    wsHeartbeatMs: 30_000,
    snapshotDebounceMs: 500,
    compactAfter: 1000,
    log: (level, message) => console[level === 'info' ? 'log' : level](`[flat-server] ${message}`),
    ...overrides,
  };
}
