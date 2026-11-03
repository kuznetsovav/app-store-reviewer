import { describe, expect, it } from "vitest";
import { applyEnv, type Config } from "../src/config.js";
import { backoffMs, isRetryable } from "../src/lookup/backoff.js";
import { BudgetExceededError, LookupClient, RequestFailedError } from "../src/lookup/client.js";
import { RateLimiter } from "../src/lookup/limiter.js";

const cfg: Config = {
  rateLimitPerMin: 18,
  userAgent: "test",
  contactUrl: "https://example.com",
  storefronts: ["us"],
  batchSize: 200,
  lookbackIds: 1_300_000,
  maxRetries: 2,
  maxConsecutiveFailures: 3,
  requestTimeoutMs: 1000,
};

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("RateLimiter", () => {
  it("spaces calls evenly and never allows more than ratePerMin in a minute", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(18, clock.now, clock.sleep);
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      await limiter.acquire();
      times.push(clock.now());
    }
    for (let i = 0; i + 18 < times.length; i++) expect(times[i + 18]! - times[i]!).toBeGreaterThanOrEqual(60_000 - 1); // float tolerance
  });
});

describe("backoff", () => {
  it("retries throttling and server errors only", () => {
    expect([403, 429, 500, 503, 0].every(isRetryable)).toBe(true);
    expect([200, 400, 404, 414].some(isRetryable)).toBe(false);
  });
  it("grows exponentially, is capped, and keeps a floor", () => {
    expect(backoffMs(0, { rand: () => 1 })).toBe(5_000);
    expect(backoffMs(3, { rand: () => 1 })).toBe(40_000);
    expect(backoffMs(10, { rand: () => 1 })).toBe(120_000);
    expect(backoffMs(5, { rand: () => 0 })).toBe(3_500);
  });
});

describe("applyEnv", () => {
  it("overrides from env and rejects rates above Apple's limit", () => {
    expect(applyEnv(cfg, { APPSTORE_RATE_LIMIT_PER_MIN: "12", APPSTORE_STOREFRONTS: "us, pl" })).toMatchObject({
      rateLimitPerMin: 12,
      storefronts: ["us", "pl"],
    });
    expect(() => applyEnv(cfg, { APPSTORE_RATE_LIMIT_PER_MIN: "30" })).toThrow();
  });
});

describe("LookupClient", () => {
  const clock = fakeClock();
  const make = (statuses: number[], budget = 100) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const status = statuses.shift() ?? 200;
      return new Response(JSON.stringify({ resultCount: 1, results: [{ trackId: 1 }] }), { status });
    }) as unknown as typeof fetch;
    const client = new LookupClient(cfg, {
      fetchImpl,
      maxLookupCalls: budget,
      limiter: new RateLimiter(18, clock.now, clock.sleep),
      sleep: clock.sleep,
    });
    return { client, calls };
  };

  it("retries 429 then succeeds", async () => {
    const { client, calls } = make([429, 200]);
    const r = await client.lookup([1, 2], "us");
    expect(r.status).toBe(200);
    expect(r.attempts).toBe(2);
    expect(calls[0]).toContain("id=1,2&country=us");
  });

  it("gives up after maxRetries", async () => {
    const { client } = make([503, 503, 503]);
    await expect(client.lookup([1], "us")).rejects.toBeInstanceOf(RequestFailedError);
  });

  it("enforces the call budget, retries included", async () => {
    const { client } = make([429, 200], 1);
    await expect(client.lookup([1], "us")).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
