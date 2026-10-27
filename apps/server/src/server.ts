import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { createProviderRegistry } from './providers/registry';
import { createSecrets, readEnvFile } from './providers/secrets';
import type { ProviderRegistry } from './providers/types';
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

export async function startServer(config: ServerConfig, options: { providers?: ProviderRegistry } = {}): Promise<RunningServer> {
  const secrets = createSecrets(process.env, readEnvFile(config.envLocalFile));
  const store = await SceneStore.open(config);
  // FLAT_PROVIDERS empty (default): no provider module is imported.
  const providers = options.providers ?? (await createProviderRegistry({ enabled: config.providers, log: config.log, secrets }));
  const app = createApp(store, config, providers, { redact: secrets.redact });
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
