import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientMsg, type ServerMsg } from '@flat/scene';
import { hostAllowed, originAllowed } from './app';
import type { ServerConfig } from './config';
import type { SceneStore } from './store';

const MAX_BUFFERED = 8 * 1024 * 1024;

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Serves `/ws`: `hello` on connect, `applied` / `reset` broadcasts, `ping` -> `pong`. */
export function attachWebSocket(server: Server, store: SceneStore, config: ServerConfig): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const send = (ws: WebSocket, msg: ServerMsg) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return void ws.terminate(); // too slow; it will reconnect and resync
    ws.send(JSON.stringify(msg));
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return reject(socket, '404 Not Found');
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin, config.allowedOrigins)) return reject(socket, '403 Forbidden');
    if (wss.clients.size >= config.maxWsClients) return reject(socket, '503 Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    send(ws, store.helloMessage());
    ws.on('message', (data) => {
      try {
        const msg = ClientMsg.safeParse(JSON.parse(data.toString()));
        if (msg.success) send(ws, { type: 'pong' });
      } catch {
        /* ignore malformed client messages */
      }
    });
    ws.on('error', () => ws.terminate());
  });

  const unsubscribe = store.subscribe((msg) => {
    for (const ws of wss.clients) send(ws, msg);
  });

  return {
    close() {
      unsubscribe();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
