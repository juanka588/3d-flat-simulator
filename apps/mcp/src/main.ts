#!/usr/bin/env -S npx tsx
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config';
import { HttpFlatApi } from './flatApi';
import { createFlatMcpServer } from './server';

/**
 * Entry point: MCP over stdio (`pnpm mcp`). stdout carries JSON-RPC ONLY; every diagnostic goes to
 * stderr. The scene server is contacted lazily per tool call, so starting this process never fails
 * when the server is down (tools answer `server_unreachable` instead).
 */
const config = loadConfig();
const flat = new HttpFlatApi(config);

const handle = serveStdio(() => createFlatMcpServer({ config, flat }), {
  onerror: (e) => config.log('error', e.message),
});
config.log('info', `stdio ready; scene server ${config.serverUrl}${config.readOnly ? '; READ-ONLY' : ''}`);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void handle.close().finally(() => process.exit(0));
  });
}
