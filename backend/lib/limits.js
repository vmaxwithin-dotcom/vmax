/**
 * In-memory quota guard.
 *
 * Cloud Run is deployed with --max-instances=1 --concurrency=1 so a single
 * process owns the counters. A restart resets them; that is acceptable for a
 * personal tool and is documented in the README.
 */
export class RequestLimiter {
  constructor({ dailyLimit, minIntervalMs }, now = Date.now) {
    this.dailyLimit = dailyLimit;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.day = this.dayKey(this.now());
    this.count = 0;
    this.lastRequestAt = 0;
  }

  dayKey(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  take() {
    const now = this.now();
    const day = this.dayKey(now);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
      this.lastRequestAt = 0;
    }

    if (this.count >= this.dailyLimit) {
      return { ok: false, reason: 'daily_limit', remaining: 0 };
    }

    const waitMs = this.lastRequestAt + this.minIntervalMs - now;
    if (waitMs > 0) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: waitMs, remaining: this.dailyLimit - this.count };
    }

    this.count += 1;
    this.lastRequestAt = now;
    return { ok: true, remaining: this.dailyLimit - this.count };
  }

  snapshot() {
    return { day: this.day, count: this.count, dailyLimit: this.dailyLimit };
  }
}
