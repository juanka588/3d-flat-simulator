import { loadConfig } from './config';
import { startServer } from './server';

const config = loadConfig();
const running = await startServer(config);
config.log('info', `listening on ${running.url} (data: ${config.dataDir}, rev ${running.store.rev})`);
if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  config.log('warn', `bound to ${config.host}: the API is reachable from other machines; set FLAT_TOKEN`);
  if (config.allowedHosts.length === 0) {
    config.log('warn', 'ALLOWED_HOSTS is empty: only loopback Host headers are accepted, so LAN clients get 403. Set ALLOWED_HOSTS=<lan-ip-or-name>[,...] (and ALLOWED_ORIGINS for the web app) to opt in');
  }
}
if (config.token) config.log('info', 'writes require FLAT_TOKEN bearer auth');

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void running.close().finally(() => process.exit(0));
  });
}
