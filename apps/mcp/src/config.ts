/**
 * Configuration of the MCP server, read once from the environment (never from tool arguments).
 *
 * | env | default | |
 * |---|---|---|
 * | `FLAT_SERVER_URL` | `http://127.0.0.1:8787` | the scene server (`apps/server`) |
 * | `FLAT_TOKEN` | unset | bearer token for the scene server (and for the HTTP transport, M4.2) |
 * | `FLAT_MCP_READONLY` | `false` | `1`/`true`: only read, view and history-read tools are listed and callable |
 * | `FLAT_MCP_TOOLS` | unset (all) | comma-separated allow-list of tool names |
 * | `FLAT_WEB_URL` | unset | URL of a running web app to render against instead of serving `apps/web/dist` |
 * | `FLAT_RENDER_CHANNEL` | unset (bundled Chromium + SwiftShader) | `chrome`: use the installed Chrome (GPU) |
 * | `FLAT_MCP_MAX_BATCH` | `50` | commands per `batch` |
 * | `FLAT_MCP_WRITES_PER_MIN` | `30` | write calls per minute |
 * | `FLAT_MCP_RENDERS_PER_MIN` | `10` | renders per minute |
 * | `FLAT_MCP_MAX_ARG_BYTES` | `262144` | JSON size of one call's arguments |
 * | `FLAT_MCP_TIMEOUT_MS` | `10000` | per request to the scene server |
 */

export interface McpLimits {
  /** Maximum commands in one `batch` (the reducer itself allows 500). */
  maxBatch: number;
  writesPerMinute: number;
  rendersPerMinute: number;
  /** Maximum size of a call's JSON arguments, in bytes. */
  maxArgBytes: number;
}

export interface McpConfig {
  serverUrl: string;
  token?: string;
  readOnly: boolean;
  /** Allow-list of tool names; `undefined` = every tool. */
  toolAllowList?: string[];
  webUrl?: string;
  renderChannel?: 'chrome';
  limits: McpLimits;
  /** Per-request timeout to the scene server, ms. */
  requestTimeoutMs: number;
  /** Diagnostics; writes to stderr only (stdout is the JSON-RPC channel on stdio). */
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
const num = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const DEFAULT_LIMITS: McpLimits = { maxBatch: 50, writesPerMinute: 30, rendersPerMinute: 10, maxArgBytes: 256 * 1024 };

/** Logs to stderr: stdout must carry JSON-RPC only (ESLint forbids `console.log` here). */
export function stderrLog(level: 'info' | 'warn' | 'error', message: string): void {
  process.stderr.write(`[flat-mcp] ${level}: ${message}\n`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<McpConfig> = {}): McpConfig {
  const allow = (env.FLAT_MCP_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const channel = env.FLAT_RENDER_CHANNEL?.trim();
  return {
    serverUrl: (env.FLAT_SERVER_URL?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    token: env.FLAT_TOKEN || undefined,
    readOnly: truthy(env.FLAT_MCP_READONLY),
    toolAllowList: allow.length ? allow : undefined,
    webUrl: env.FLAT_WEB_URL?.trim() || undefined,
    renderChannel: channel === 'chrome' ? 'chrome' : undefined,
    limits: {
      maxBatch: num(env.FLAT_MCP_MAX_BATCH, DEFAULT_LIMITS.maxBatch),
      writesPerMinute: num(env.FLAT_MCP_WRITES_PER_MIN, DEFAULT_LIMITS.writesPerMinute),
      rendersPerMinute: num(env.FLAT_MCP_RENDERS_PER_MIN, DEFAULT_LIMITS.rendersPerMinute),
      maxArgBytes: num(env.FLAT_MCP_MAX_ARG_BYTES, DEFAULT_LIMITS.maxArgBytes),
    },
    requestTimeoutMs: num(env.FLAT_MCP_TIMEOUT_MS, 10_000),
    log: stderrLog,
    ...overrides,
  };
}
