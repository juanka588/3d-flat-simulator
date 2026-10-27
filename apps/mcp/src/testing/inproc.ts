import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import catalog from '../../../web/public/materials/catalog.json';
import { loadConfig } from '../config';
import { createFlatMcpServer, type ServerDeps } from '../server';
import { MockFlatApi } from './mockFlatApi';

/** The real material library catalog served by `GET /api/materials`. */
export const realCatalog: unknown = catalog;

/** Deterministic clock and ULID-like ids; `advance` moves time (rate-limit tests). */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  let n = 0;
  return {
    now: () => t,
    newId: () => `01TEST${String(++n).padStart(20, '0')}`,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** In-process client <-> server over linked transports, with the in-memory FlatApi (no network). */
export async function connect(over: Parameters<typeof loadConfig>[1] = {}, flat = new MockFlatApi({ materials: realCatalog }), extra: Partial<ServerDeps> = {}, clientName = 'unit-client') {
  const clock = fakeClock();
  const config = loadConfig({}, { log: () => {}, ...over });
  const server = createFlatMcpServer({ config, flat, clock, ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, flat, server, clock };
}

/** The JSON text of the first content item of a tool result. */
export const json = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0]!.text);
/** Length of all text content of a result (the char proxy for tokens: ~4 chars per token). */
export const textChars = (r: { content: unknown }) => (r.content as { type: string; text?: string }[]).reduce((n, c) => n + (c.type === 'text' ? (c.text?.length ?? 0) : 0), 0);
