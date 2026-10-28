import { assertGeneratorsRegistered } from '@flat/assets';
import { loadConfig } from './config';
import { readEnvFile } from './providers/secrets';
import { startServer } from './server';

// Importing @flat/assets registers the generators in scene's registry; fail at start-up if that ever stops being true.
assertGeneratorsRegistered();

// apps/server/.env.local (gitignored) may set FLAT_PROVIDERS and provider credentials; the process environment wins.
const config = loadConfig({ ...readEnvFile(loadConfig().envLocalFile), ...process.env });
const running = await startServer(config);
config.log('info', `listening on ${running.url} (data: ${config.dataDir}, rev ${running.store.rev})`);
if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  config.log('warn', `bound to ${config.host}: the API is reachable from other machines; set FLAT_TOKEN`);
  if (config.allowedHosts.length === 0) {
    config.log('warn', 'ALLOWED_HOSTS is empty: only loopback Host headers are accepted, so LAN clients get 403. Set ALLOWED_HOSTS=<lan-ip-or-name>[,...] (and ALLOWED_ORIGINS for the web app) to opt in');
  }
}
if (config.token) config.log('info', 'writes require FLAT_TOKEN bearer auth');
if (config.providers.length > 0) config.log('info', `product providers: ${config.providers.join(', ')}`);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void running.close().finally(() => process.exit(0));
  });
}
