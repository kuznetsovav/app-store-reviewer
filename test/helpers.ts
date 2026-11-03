import { readFileSync } from "node:fs";
import type { Config } from "../src/config.js";
import type { LookupResult } from "../src/lookup/client.js";
import { RateLimiter } from "../src/lookup/limiter.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    rateLimitPerMin: 18,
    userAgent: "test",
    contactUrl: "",
    storefronts: ["us"],
    batchSize: 200,
    lookbackIds: 1_000,
    emptyBatchesToStop: 3,
    maxCallsPerRun: 1_000,
    maxMinutesPerRun: 340,
    idsPerDayEstimate: 391_000,
    dbPath: ":memory:",
    reportsDir: "reports",
    windowMode: "mixed",
    windowTimeZone: "America/Los_Angeles",
    watchlist: { keywords: ["wishlist", "gift"], genres: [] },
    maxRetries: 0,
    maxConsecutiveFailures: 10,
    requestTimeoutMs: 1_000,
    ...overrides,
  };
}

export function fixture(name: string): { resultCount: number; results: LookupResult[] } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

/** A clock that only moves when something sleeps; shared by limiter, backoff and runScan. */
export function fakeClock(startIso = "2026-11-04T00:00:00Z") {
  let t = Date.parse(startIso);
  const clock = {
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    advance: (ms: number) => void (t += ms),
  };
  return { ...clock, limiter: () => new RateLimiter(18, clock.now, clock.sleep) };
}

export interface World {
  /** Highest ID that returns anything. */
  frontier: number;
  /** IDs at or below the frontier divisible by this return a song. */
  songEvery: number;
  /** App IDs per storefront. */
  apps: Record<string, Set<number>>;
  /** Return true to answer this request with 503. */
  fail?: (ids: number[], country: string) => boolean;
}

/** A fake iTunes Lookup built from recorded fixtures; records every request. */
export function fakeLookup(world: World) {
  const mixed = fixture("lookup-mixed.json").results;
  const song = mixed.find((r) => r.kind === "song")!;
  const app = mixed.find((r) => r.kind === "software")!;
  const requests: { ids: number[]; country: string }[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const ids = url.searchParams.get("id")!.split(",").map(Number);
    const country = url.searchParams.get("country")!;
    requests.push({ ids, country });
    if (world.fail?.(ids, country)) return new Response("unavailable", { status: 503 });
    const results: LookupResult[] = [];
    for (const id of ids) {
      if (world.apps[country]?.has(id)) results.push({ ...app, trackId: id, trackName: `App ${id}` });
      else if (id <= world.frontier && id % world.songEvery === 0) results.push({ ...song, trackId: id });
    }
    return new Response(JSON.stringify({ resultCount: results.length, results }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}
