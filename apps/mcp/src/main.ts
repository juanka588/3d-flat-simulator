#!/usr/bin/env -S npx tsx
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { assertGeneratorsRegistered } from '@flat/assets';
import { loadConfig } from './config';
import { HttpFlatApi } from './flatApi';
import { parseArgs } from './cli';
import { startHttp } from './http';
import { McpRenderer, closeSharedRenderer, sharedRenderer } from './render';
import { createFlatMcpServer } from './server';

/**
 * Entry point. Default: MCP over stdio (`pnpm mcp`). With `--http [--port 8788] [--host 127.0.0.1]`:
 * streamable HTTP at `http://<host>:<port>/mcp` plus `GET /healthz`. stdout carries JSON-RPC ONLY on
 * stdio; every diagnostic goes to stderr. The scene server is contacted lazily per tool call, so
 * starting this process never fails when the server is down (tools answer `server_unreachable`).
 */

async function main(): Promise<void> {
  assertGeneratorsRegistered();
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const flat = new HttpFlatApi(config);
  // Lazy: the browser (and Playwright) start at the first render, never at start-up.
  const renderer = new McpRenderer(flat, sharedRenderer({ webUrl: config.webUrl, renderChannel: config.renderChannel, log: config.log }));

  // FLAT_MCP_PREWARM=1 starts the browser in the background now, so the first render_view does not pay for it.
  if (process.env['FLAT_MCP_PREWARM'] === '1') void renderer.browser.session.warmUp({ width: 1024, height: 768 }).catch((e: unknown) => config.log('warn', `render prewarm failed: ${e instanceof Error ? e.message : String(e)}`));

  let close: () => Promise<void> = async () => undefined;
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void close()
      .catch(() => undefined)
      .then(() => closeSharedRenderer())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };

  if (args.http) {
    const running = await startHttp({ config, flat, renderer, host: args.host, port: args.port, ...(process.env.FLAT_MCP_ALLOWED_HOSTS ? { allowedHosts: process.env.FLAT_MCP_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) } : {}) });
    config.log('info', `http ready at ${running.url}; scene server ${config.serverUrl}${config.token ? '; bearer token required' : ''}${config.readOnly ? '; READ-ONLY' : ''}`);
    close = () => running.close();
  } else {
    // stdout is the JSON-RPC channel: anything a dependency prints with console.log/info/debug (Playwright
    // download progress, framework banners) would corrupt the protocol, so it goes to stderr instead.
    for (const method of ['log', 'info', 'debug'] as const) console[method] = (...a: unknown[]) => console.error(...a); // eslint-disable-line no-console
    const handle = serveStdio(() => createFlatMcpServer({ config, flat, renderer }), { onerror: (e) => config.log('error', e.message) });
    config.log('info', `stdio ready; scene server ${config.serverUrl}${config.readOnly ? '; READ-ONLY' : ''}`);
    close = () => handle.close();
    // The client going away (stdin EOF) ends the session.
    process.stdin.once('close', () => shutdown());
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`[flat-mcp] error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
