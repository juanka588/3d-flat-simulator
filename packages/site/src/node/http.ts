import { setTimeout } from 'node:timers';

export interface GetJsonOptions {
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * GET JSON with retries on network errors, timeouts and 5xx/408/429 responses. Other 4xx
 * responses are permanent (bad request, not found...) and fail immediately.
 */
export async function getJson(
  url: string,
  label: string,
  { fetchImpl = globalThis.fetch, attempts = 4, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), log = () => {} }: GetJsonOptions = {},
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let retryable = true;
    try {
      const res = await fetchImpl(url, { signal: globalThis.AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok) {
        retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(text);
    } catch (e) {
      lastError = e;
      log(`  ${label}: attempt ${attempt} failed (${(e as Error).message})`);
      if (!retryable) break;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw new Error(`${label} failed: ${(lastError as Error | undefined)?.message}`);
}
