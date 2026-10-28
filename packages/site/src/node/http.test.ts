import { describe, expect, it, vi } from 'vitest';
import { getJson } from './http';

describe('getJson retries', () => {
  const response = (status: number, body = '{"ok":true}') => ({ ok: status < 400, status, text: async () => body });
  it('does not retry 4xx responses', async () => {
    const fetchImpl = vi.fn(async () => response(404, 'nope'));
    await expect(getJson('u', 'x', { fetchImpl, sleep: async () => {} })).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('retries 5xx and network errors, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('reset'))
      .mockResolvedValueOnce(response(503, 'busy'))
      .mockResolvedValueOnce(response(200));
    await expect(getJson('u', 'x', { fetchImpl, sleep: async () => {} })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('gives up after the configured attempts', async () => {
    const fetchImpl = vi.fn(async () => response(500, 'boom'));
    await expect(getJson('u', 'x', { fetchImpl, attempts: 2, sleep: async () => {} })).rejects.toThrow(/x failed: HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
