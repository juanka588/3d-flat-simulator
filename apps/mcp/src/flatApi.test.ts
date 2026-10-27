import { makeEnvelope, type Command } from '@flat/scene';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { apiFailure } from './errors';
import { HttpFlatApi } from './flatApi';
import { startRealServer, type RealServer } from './testing/harness';

/** A fetch that performs the request (so the server COMMITS it) but loses the answer on the first `n` matching calls. */
function lossyFetch(match: (url: string) => boolean, losses: number, how: 'timeout' | 'reset' = 'timeout') {
  const state = { lost: 0, calls: 0 };
  const impl: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (match(String(input))) {
      state.calls += 1;
      if (state.lost < losses) {
        state.lost += 1;
        await res.arrayBuffer();
        if (how === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      }
    }
    return res;
  };
  return { impl, state };
}

let real: RealServer | undefined;
afterEach(async () => {
  await real?.close();
  real = undefined;
});

const floor = (materialId: string): Command => ({ type: 'room.setFloor', roomId: 'sejour', materialId });
const envelope = (id: string, cmd: Command) => makeEnvelope(cmd, { id, ts: 1, author: { kind: 'llm', name: 'retry-test' } });

async function api(over: Parameters<typeof lossyFetch>) {
  real = await startRealServer();
  const lossy = lossyFetch(...over);
  const config = loadConfig({}, { serverUrl: real.url, log: () => {}, requestTimeoutMs: 5000 });
  return { flat: new HttpFlatApi(config, lossy.impl, { retryDelayMs: 0 }), lossy };
}

describe('idempotent retry in HttpFlatApi', () => {
  it('postCommand: commits, loses the answer, retries with the same id: applied once', async () => {
    const { flat, lossy } = await api([(u) => u.endsWith('/api/commands'), 1]);
    const r = await flat.postCommand(envelope('01RETRY0000000000000000001', floor('floor-oak')));
    expect(r.ok).toBe(true);
    expect(lossy.state.calls).toBe(2);
    const h = await flat.history();
    expect(h.ok && h.data.past).toHaveLength(1);
    expect(h.ok && h.data.rev).toBe(1);
  });

  it('undo and redo: lost answers retried, each applied once (even without a caller id)', async () => {
    real = await startRealServer();
    const undoLoss = lossyFetch((u) => u.endsWith('/api/undo'), 1, 'reset');
    const redoLoss = lossyFetch((u) => u.endsWith('/api/redo'), 1);
    const config = loadConfig({}, { serverUrl: real.url, log: () => {}, requestTimeoutMs: 5000 });
    const plain = new HttpFlatApi(config, fetch, { retryDelayMs: 0 });
    await plain.postCommand(envelope('01RETRY0000000000000000002', floor('floor-oak')));
    await plain.postCommand(envelope('01RETRY0000000000000000003', floor('floor-deck')));

    const u = await new HttpFlatApi(config, undoLoss.impl, { retryDelayMs: 0 }).undo();
    expect(u.ok).toBe(true);
    expect(undoLoss.state.calls).toBe(2);
    let h = await plain.history();
    expect(h.ok && [h.data.past.length, h.data.future.length]).toEqual([1, 1]);

    const r = await new HttpFlatApi(config, redoLoss.impl, { retryDelayMs: 0 }).redo({ id: 'redo-1' });
    expect(r.ok).toBe(true);
    h = await plain.history();
    expect(h.ok && [h.data.past.length, h.data.future.length]).toEqual([2, 0]);
  });

  it('undoTo: lost answer retried, steps applied once', async () => {
    real = await startRealServer();
    const loss = lossyFetch((u) => u.endsWith('/api/undo-to'), 1);
    const config = loadConfig({}, { serverUrl: real.url, log: () => {}, requestTimeoutMs: 5000 });
    const plain = new HttpFlatApi(config, fetch, { retryDelayMs: 0 });
    await plain.checkpoint({ name: 'start' });
    await plain.postCommand(envelope('01RETRY0000000000000000004', floor('floor-oak')));
    await plain.postCommand(envelope('01RETRY0000000000000000005', floor('floor-deck')));
    const r = await new HttpFlatApi(config, loss.impl, { retryDelayMs: 0 }).undoTo({ checkpoint: 'start' });
    expect(r.ok && r.data.steps).toBe(2);
    const h = await plain.history();
    expect(h.ok && [h.data.past.length, h.data.future.length]).toEqual([0, 2]);
  });

  it('a second loss reports "may have been applied - call list_history before retrying"', async () => {
    const { flat, lossy } = await api([(u) => u.endsWith('/api/commands'), 2]);
    const r = await flat.postCommand(envelope('01RETRY0000000000000000006', floor('floor-oak')));
    expect(lossy.state.calls).toBe(2);
    expect(r).toMatchObject({ ok: false, kind: 'unreachable', timedOut: true, mayHaveApplied: true });
    const e = apiFailure(r as Extract<typeof r, { ok: false }>);
    const body = e.structuredContent as { code: string; message: string; hint: string };
    expect(body.code).toBe('server_unreachable');
    expect(body.message).toMatch(/may have been applied/);
    expect(body.hint).toMatch(/list_history/);
  });

  it('a refused connection is not "may have been applied"; reads are not retried', async () => {
    const dead = await startRealServer();
    const url = dead.url;
    await dead.close(); // nothing listens there any more: ECONNREFUSED
    const config = loadConfig({}, { serverUrl: url, log: () => {}, requestTimeoutMs: 500 });
    let calls = 0;
    const counting: typeof fetch = (i, o) => (calls++, fetch(i, o));
    const flat = new HttpFlatApi(config, counting, { retryDelayMs: 0 });
    const w = await flat.postCommand(envelope('01RETRY0000000000000000007', floor('floor-oak')));
    expect(w).toMatchObject({ ok: false, kind: 'unreachable', mayHaveApplied: false });
    expect(calls).toBe(2);
    calls = 0;
    await flat.getScene();
    expect(calls).toBe(1);
  });
});
