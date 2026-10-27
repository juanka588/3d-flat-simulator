/**
 * Token bucket for per-session rate limits (M4.6). Pure: time comes from the injected clock, so
 * tests drive it with a fake. Capacity equals the per-minute allowance (a burst of one minute),
 * refilled continuously at `perMinute / 60 s`.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  /** Takes one token, or says how long to wait until one is available. */
  take(): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.last = t;
    this.tokens = Math.min(this.perMinute, this.tokens + (elapsed * this.perMinute) / 60_000);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute)) };
  }
}
