/**
 * Token bucket with capacity 1: calls are spaced evenly at 60000/ratePerMin ms.
 * Capacity 1 means no bursts, so any 60 s window holds at most ratePerMin calls.
 */
export class RateLimiter {
  private nextAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerMin: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!(ratePerMin > 0)) throw new Error("ratePerMin must be > 0");
  }

  get intervalMs(): number {
    return 60_000 / this.ratePerMin;
  }

  /** Resolves when the caller may make one call. Serialised, so concurrent callers queue. */
  acquire(): Promise<void> {
    const run = async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = Math.max(this.now(), this.nextAt) + this.intervalMs;
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}
