/**
 * Fixed-window rate limits per client and bucket, in memory. One API instance enforces them exactly; behind
 * several instances each enforces its own share, so put the platform's edge rate limiting (e.g. Cloudflare)
 * in front for hard global limits.
 */
export class RateLimiter {
  private hits = new Map<string, { until: number; n: number }>();
  private sweepAt = 0;

  /** True when the call is allowed (and counts it). */
  take(bucket: string, client: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const key = `${bucket}:${client}`;
    const h = this.hits.get(key);
    if (!h || now >= h.until) {
      this.hits.set(key, { until: (Math.floor(now / windowMs) + 1) * windowMs, n: 1 });
      this.sweep(now);
      return true;
    }
    if (h.n >= limit) return false;
    h.n++;
    return true;
  }

  private sweep(now: number) {
    if (now < this.sweepAt) return;
    this.sweepAt = now + 60_000;
    for (const [k, v] of this.hits) if (now >= v.until) this.hits.delete(k);
  }
}
