import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { countApps, lastFrontier } from "../src/db/repo.js";
import { runScan, type ScanOptions } from "../src/scan/run.js";
import { fakeClock, fakeLookup, testConfig, type World } from "./helpers.js";

const SEED = { id: 1000, observedAt: "2026-11-03T00:00:00Z" };

/** Real frontier at 1055; songs every 5 IDs; app 1003 (us) above the seed, app 950 (us + pl) below it. */
function world(overrides: Partial<World> = {}): World {
  return { frontier: 1055, songEvery: 5, apps: { us: new Set([1003, 950]), pl: new Set([950]) }, ...overrides };
}

function setup(opts: { world?: World; cfg?: Parameters<typeof testConfig>[0]; start?: string } = {}) {
  const db = openDb(":memory:");
  const clock = fakeClock(opts.start);
  const lookup = fakeLookup(opts.world ?? world());
  const cfg = testConfig({ batchSize: 10, lookbackIds: 100, emptyBatchesToStop: 3, storefronts: ["us", "pl"], ...opts.cfg });
  const lines: Record<string, unknown>[] = [];
  const base = (): ScanOptions => ({
    db,
    cfg,
    seed: SEED,
    now: clock.now,
    log: (l) => void lines.push(l),
    clientOptions: { fetchImpl: lookup.fetchImpl, limiter: clock.limiter(), sleep: clock.sleep },
  });
  return { db, clock, lookup, cfg, lines, base };
}

describe("runScan", () => {
  it("extends until N empty batches, records the frontier, then rescans down", async () => {
    const { db, base, lines, lookup } = setup();
    const res = await runScan(base());

    expect(res.run.status).toBe("done");
    // Extend: 1001–1090 (6 batches with hits up to 1055, then 3 empty). Rescan: 1000 down to 900 = 11 batches.
    expect(lines.filter((l) => l.phase === "extend")).toHaveLength(9);
    expect(lines.filter((l) => l.phase === "rescan")).toHaveLength(11);
    expect(res.run.calls).toBe(20 * 2); // two storefronts
    expect(lastFrontier(db)?.max_hit_id).toBe(1055);

    // Only software is stored; storefronts are merged.
    expect(countApps(db)).toBe(2);
    const rows = db.prepare("SELECT track_id, storefronts FROM apps ORDER BY track_id").all();
    expect(rows).toEqual([
      { track_id: 950, storefronts: '["pl","us"]' },
      { track_id: 1003, storefronts: '["us"]' },
    ]);
    expect(res.run.hits).toBe(2);
    expect(res.run.new_releases).toBe(2); // fixture app released 2026-11-03T18:06:52Z, now is 2026-11-04T00:00Z
    // Rescan stops at the bottom.
    const rescanned = lookup.requests.filter((r) => r.ids[0]! <= 1000).flatMap((r) => r.ids);
    expect(Math.min(...rescanned)).toBe(900);
  });

  it("resumes today's run from the checkpoint after a stop", async () => {
    const { base, lines, db } = setup();
    let batches = 0;
    const first = await runScan({ ...base(), shouldStop: () => batches >= 4, log: (l) => void (l.phase && batches++, lines.push(l)) });
    expect(first.run.status).toBe("aborted");
    expect(first.run.error).toBe("SIGINT");
    expect(first.run.next_id).toBe(1041);
    expect(first.run.calls).toBe(8);

    const second = await runScan(base());
    expect(second.resumed).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.status).toBe("done");
    expect(second.run.calls).toBe(40); // same as an uninterrupted run
    expect(countApps(db)).toBe(2);
    // No batch was looked up twice.
    const firsts = lines.filter((l) => l.phase).map((l) => `${l.phase}:${l.first}`);
    expect(new Set(firsts).size).toBe(firsts.length);
  });

  it("stops on the call budget and does not restart a finished day", async () => {
    const { base } = setup({ cfg: { storefronts: ["us"] } });
    const res = await runScan({ ...base(), maxCalls: 7 });
    expect(res.run.status).toBe("budget");
    expect(res.run.calls).toBe(7);

    const again = await runScan(base());
    expect(again.skipped).toMatch(/already finished \(budget\)/);

    const fresh = await runScan({ ...base(), forceNew: true, maxCalls: 1 });
    expect(fresh.run.id).not.toBe(res.run.id);
  });

  it("aborts after 10 consecutive failed batches and keeps the failed ranges", async () => {
    const { base } = setup({ world: world({ fail: () => true }), cfg: { storefronts: ["us"] } });
    const res = await runScan(base());
    expect(res.run.status).toBe("aborted");
    expect(res.run.error).toMatch(/10 consecutive failed batches/);
    expect(res.run.calls).toBe(10);
    expect(JSON.parse(res.run.failed_ranges)).toHaveLength(10);
  });

  it("retries a failed batch once at the end of the run", async () => {
    let failedOnce = false;
    const w = world({
      fail: (ids) => {
        if (!failedOnce && ids.includes(950)) return (failedOnce = true);
        return false;
      },
    });
    const { base, db } = setup({ world: w, cfg: { storefronts: ["us"] } });
    const res = await runScan(base());
    expect(res.run.status).toBe("done");
    expect(res.run.failed_ranges).toBe("[]");
    expect(countApps(db)).toBe(2);
  });

  it("skips IDs already stored on the next day's rescan", async () => {
    const { base, clock, lookup } = setup({ cfg: { storefronts: ["us"] } });
    await runScan(base());
    clock.advance(86_400_000);
    const before = lookup.requests.length;
    const next = await runScan(base());
    expect(next.run.range_to).toBe(1055);
    expect(next.run.status).toBe("done");
    const ids = lookup.requests.slice(before).flatMap((r) => r.ids);
    expect(ids).not.toContain(1003);
    expect(ids).toContain(1004);
  });
});
