/**
 * Is the local image sidecar generating right now? The headless renderer asks before it starts Chromium or draws: a generation
 * peaks at ~38 GB, and a cold Chromium next to it on a 64 GB Mac swaps (the second real close-the-gap run: references took 30 min
 * instead of 90 s and the browser start timed out). No imports on purpose: `render/` uses this without pulling in the tools.
 *
 * Off (undefined) for hosted/fake providers and with `FLAT_RENDER_WAIT_SIDECAR=0`. A failed probe means "idle".
 */
export function sidecarBusyProbe(env: Record<string, string | undefined> = process.env, f: typeof fetch = fetch): (() => Promise<boolean>) | undefined {
  if ((env['IMAGE_PROVIDER'] ?? 'local').trim().toLowerCase() !== 'local') return undefined;
  if (env['FLAT_RENDER_WAIT_SIDECAR'] === '0') return undefined;
  const url = (env['IMAGEGEN_URL']?.trim() || 'http://127.0.0.1:8790').replace(/\/+$/, '');
  const token = env['IMAGEGEN_TOKEN'];
  return async () => {
    try {
      const res = await f(`${url}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const h = (await res.json()) as { queue?: { queued?: number; running?: string | null } };
      return Boolean(h.queue?.running) || (h.queue?.queued ?? 0) > 0;
    } catch {
      return false;
    }
  };
}
