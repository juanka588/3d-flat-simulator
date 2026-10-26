import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import type { ServerConfig } from './config';
import { SceneStore } from './store';
import { attachWebSocket } from './ws';

export interface RunningServer {
  store: SceneStore;
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const store = await SceneStore.open(config);
  const app = createApp(store, config);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => resolve(s as Server));
    s.once('error', reject);
  });
  const ws = attachWebSocket(server, store, config);
  const port = (server.address() as AddressInfo).port;
  return {
    store,
    server,
    port,
    url: `http://${config.host}:${port}`,
    async close() {
      ws.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await store.close();
    },
  };
}
