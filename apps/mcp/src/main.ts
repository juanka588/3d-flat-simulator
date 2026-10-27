#!/usr/bin/env -S npx tsx
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config';
import { HttpFlatApi } from './flatApi';
import { parseArgs } from './cli';
import { startHttp } from './http';
import { createFlatMcpServer } from './server';

/**
 * Entry point. Default: MCP over stdio (`pnpm mcp`). With `--http [--port 8788] [--host 127.0.0.1]`:
 * streamable HTTP at `http://<host>:<port>/mcp` plus `GET /healthz`. stdout carries JSON-RPC ONLY on
 * stdio; every diagnostic goes to stderr. The scene server is contacted lazily per tool call, so
 * starting this process never fails when the server is down (tools answer `server_unreachable`).
 */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const flat = new HttpFlatApi(config);

  let close: () => Promise<void>;
  if (args.http) {
    const running = await startHttp({ config, flat, host: args.host, port: args.port, ...(process.env.FLAT_MCP_ALLOWED_HOSTS ? { allowedHosts: process.env.FLAT_MCP_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) } : {}) });
    config.log('info', `http ready at ${running.url}; scene server ${config.serverUrl}${config.token ? '; bearer token required' : ''}${config.readOnly ? '; READ-ONLY' : ''}`);
    close = () => running.close();
  } else {
    const handle = serveStdio(() => createFlatMcpServer({ config, flat }), { onerror: (e) => config.log('error', e.message) });
    config.log('info', `stdio ready; scene server ${config.serverUrl}${config.readOnly ? '; READ-ONLY' : ''}`);
    close = () => handle.close();
  }

  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void close().finally(() => process.exit(0));
    });
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[flat-mcp] error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
