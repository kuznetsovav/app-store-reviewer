import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { countApps, getRun, lastFrontier, upsertApps } from "../src/db/repo.js";
import type { CallLog } from "../src/lookup/client.js";
import { parseApp } from "../src/lookup/parse.js";
import { checkRateLog, maxInWindow } from "../src/lookup/ratecheck.js";
import { anomalyLine, buildReport } from "../src/report/build.js";
import { loadReportData } from "../src/report/query.js";
import { readHistory, writeReports } from "../src/report/write.js";
import { formatTimes } from "../src/scan/dates.js";
import { runScan, type ScanOptions } from "../src/scan/run.js";
import { buildState, writeState } from "../src/state.js";
import { fakeClock, fakeLookup, fixture, testConfig, type World } from "./helpers.js";

const SEED = { id: 1000, observedAt: "2026-11-03T00:00:00Z" };
const world = (o: Partial<World> = {}): World => ({ frontier: 1055, songEvery: 5, apps: { us: new Set([1003, 950]) }, ...o });

function setup(opts: { world?: World; cfg?: Partial<Config>; start?: string } = {}) {
  const db = openDb(":memory:");
  const clock = fakeClock(opts.start);
  const w = opts.world ?? world();
  const lookup = fakeLookup(w);
  const cfg = testConfig({ batchSize: 10, lookbackIds: 100, emptyBatchesToStop: 3, ...opts.cfg });
  const lines: Record<string, unknown>[] = [];
  const calls: CallLog[] = [];
  const base = (): ScanOptions => ({
    db,
    cfg,
    seed: SEED,
    now: clock.now,
    log: (l) => void lines.push(l),
    callLog: (l) => void calls.push(l),
    clientOptions: { fetchImpl: lookup.fetchImpl, limiter: clock.limiter(), sleep: clock.sleep },
  });
  return { db, clock, lookup, cfg, lines, calls, base, w };
}

describe("guard 1: canary", () => {
  it("passes when enough known apps come back", async () => {
    const s = setup({ world: world({ apps: { us: new Set([1, 2, 3, 4, 5, 1003]) } }), cfg: { canaryIds: [1, 2, 3, 4, 5], canaryMinFound: 4 } });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("done");
    expect(s.lines.find((l) => l.event === "canary")).toMatchObject({ found: 5, of: 5 });
    expect(countApps(s.db)).toBe(1); // canary hits are not stored
  });

  it("aborts with 'canary failed' when Apple answers 200 but empty", async () => {
    const s = setup({ world: world({ apps: { us: new Set([1, 2]) } }), cfg: { canaryIds: [1, 2, 3, 4, 5], canaryMinFound: 4 } });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("aborted");
    expect(res.run.error).toMatch(/^canary failed: 2\/5 known apps returned \(need 4\)/);
    expect(res.run.calls).toBe(1);
    expect(s.lines.filter((l) => l.phase)).toHaveLength(0);
  });

  it("aborts when the canary request itself fails", async () => {
    const s = setup({ world: world({ fail: () => 503 }), cfg: { canaryIds: [1, 2, 3], canaryMinFound: 3 } });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("aborted");
    expect(res.run.error).toMatch(/canary failed: 0\/3.*status 503/);
  });
});

describe("guard 1: empty answers in ranges that used to be dense", () => {
  it("aborts after N consecutive empty batches where earlier runs found plenty", async () => {
    let blocked = false;
    const s = setup({
      world: world({ rawBody: () => (blocked ? '{"resultCount":0,"results":[]}' : undefined) }),
      cfg: { batchSize: 50, lookbackIds: 950, denseEmptyBatchesToAbort: 3, denseMinHitsPer1000: 20 },
    });
    const day1 = await runScan(s.base());
    expect(day1.run.status).toBe("done");

    blocked = true;
    s.clock.advance(86_400_000);
    const day2 = await runScan(s.base());
    expect(day2.run.status).toBe("aborted");
    expect(day2.run.error).toMatch(/silent blocking suspected: 3 consecutive empty batches/);
  });
});

describe("guard 2: response drift", () => {
  it("aborts when more than 5% of results fail validation", async () => {
    const s = setup({
      world: world({ songEvery: 1, transform: (r) => (r.kind === "song" ? { ...r, trackId: "not-a-number" as unknown as number } : r) }),
      cfg: { batchSize: 50, lookbackIds: 950 }, // enough results for the 200-result minimum sample
    });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("aborted");
    expect(res.run.error).toMatch(/^response drift: \d+\.\d% of \d+ results failed validation/);
  });

  it("logs unknown and missing fields without failing the run", async () => {
    const s = setup({
      world: world({
        transform: (r) => {
          if (r.kind !== "software") return r;
          const { description: _drop, ...rest } = r as Record<string, unknown>;
          return { ...rest, shinyNewField: 1 } as typeof r;
        },
      }),
    });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("done");
    const schema = s.lines.find((l) => l.event === "schema")!;
    expect(schema.unknownFields).toEqual({ shinyNewField: 2 });
    expect(schema.missingFields).toEqual({ description: 2 });
    expect(JSON.parse(res.run.warnings)).toContainEqual(expect.stringMatching(/new fields shinyNewField; missing fields description/));
    expect(countApps(s.db)).toBe(0); // apps missing a required field are not stored
  });

  it("treats a 200 with a non-JSON body as a failure, not as an empty batch", async () => {
    const s = setup({ world: world({ rawBody: () => "<html>Service Unavailable</html>" }) });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("aborted");
    expect(res.run.error).toMatch(/10 consecutive failed batches \(last: Request failed with status 200/);
    expect(res.run.empty_streak).toBe(0); // the frontier search was not fooled
    expect(s.calls.every((c) => c.badBody)).toBe(true);
  });
});

describe("guard 3: rate limit proof", () => {
  it("a replayed run log with 429 retries never exceeds rateLimitPerMin in any 60 s window", async () => {
    let n = 0;
    const s = setup({ world: world({ fail: () => (++n % 4 === 0 ? 429 : false) }), cfg: { maxRetries: 3 } });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("done");
    const log = s.calls.map((c) => JSON.stringify(c)).join("\n");
    const check = checkRateLog(log, s.cfg.rateLimitPerMin);
    expect(check.calls).toBe(s.calls.length);
    expect(check.calls).toBeGreaterThan(19);
    expect(s.calls.some((c) => c.status === 429)).toBe(true); // retries are in the log too
    expect(check.ok).toBe(true);
    expect(check.max).toBeLessThanOrEqual(18);
  });

  it("runs right at the limit, never above, when nothing fails", async () => {
    const s = setup();
    await runScan(s.base());
    const check = checkRateLog(s.calls.map((c) => JSON.stringify(c)).join("\n"), 18);
    expect(check.calls).toBe(20);
    expect(check.max).toBe(18);
    expect(check.ok).toBe(true);
  });

  it("flags a log that breaks the limit", () => {
    const starts = Array.from({ length: 19 }, (_, i) => new Date(Date.parse("2026-11-04T00:00:00Z") + i * 3_000).toISOString());
    const log = starts.map((start) => JSON.stringify({ kind: "lookup", start, status: 200 })).join("\n");
    expect(checkRateLog(log, 18)).toMatchObject({ calls: 19, max: 19, ok: false });
    expect(maxInWindow([0, 59_999, 60_000]).max).toBe(2);
  });
});

describe("guard 4: idempotency", () => {
  it("running `run` twice on the same day changes nothing the second time", async () => {
    const s = setup();
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    const statePath = join(dir, "state", "state.json");
    const cycle = async () => {
      const res = await runScan(s.base());
      const date = res.run.run_date;
      const out = buildReport(loadReportData(s.db, date, s.cfg, s.clock.now(), readHistory(dir, date)), s.cfg);
      writeReports(dir, date, out);
      writeState(statePath, buildState(s.db, getRun(s.db, res.run.id), date, out.count, s.clock.now()));
      const files = ["2026-11-04.csv", "2026-11-04.json", "2026-11-04.md", "latest.md"].map((f) => readFileSync(join(dir, f), "utf8"));
      return { res, files: [...files, readFileSync(statePath, "utf8")] };
    };
    const first = await cycle();
    const appsBefore = countApps(s.db);
    s.clock.advance(60_000);
    const second = await cycle();
    expect(second.res.skipped).toMatch(/already finished \(done\)/);
    expect(second.files).toEqual(first.files); // byte-identical → no second commit in CI
    expect(countApps(s.db)).toBe(appsBefore);
    expect(s.db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(1);
  });

  it("a scheduled-style --restart-finished run resumes an interrupted run instead of restarting", async () => {
    const s = setup();
    let batches = 0;
    const first = await runScan({ ...s.base(), shouldStop: () => batches >= 3, log: (l) => void (l.phase && batches++) });
    expect(first.run.status).toBe("aborted");
    const again = await runScan({ ...s.base(), restartFinished: true });
    expect(again.resumed).toBe(true);
    expect(again.run.id).toBe(first.run.id);
    const third = await runScan({ ...s.base(), restartFinished: true });
    expect(third.run.id).not.toBe(first.run.id); // finished → a fresh run
  });
});

describe("guard 5: time zones", () => {
  it("stores every time as a UTC ISO string", async () => {
    const s = setup();
    await runScan(s.base());
    const values = [
      ...(s.db.prepare("SELECT started_at, finished_at FROM runs").raw().all() as string[][]).flat(),
      ...(s.db.prepare("SELECT first_seen_at, last_seen_at, release_date, current_version_release_date FROM apps").raw().all() as string[][]).flat(),
      ...(s.db.prepare("SELECT observed_at FROM frontier").pluck().all() as string[]),
      ...(s.db.prepare("SELECT updated_at FROM density").pluck().all() as string[]),
    ];
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  });

  it("shows UTC and Europe/Warsaw in reports", async () => {
    expect(formatTimes(Date.parse("2026-11-04T06:12:00Z"), "Europe/Warsaw")).toBe("2026-11-04 06:12 UTC (07:12 Europe/Warsaw)");
    expect(formatTimes(Date.parse("2026-11-03T23:30:00Z"), "Europe/Warsaw")).toBe("2026-11-03 23:30 UTC (2026-11-04 00:30 Europe/Warsaw)");
    expect(formatTimes(Date.parse("2026-07-15T12:00:00Z"), "Europe/Warsaw")).toBe("2026-07-15 12:00 UTC (14:00 Europe/Warsaw)");
    const s = setup();
    await runScan(s.base());
    const md = buildReport(loadReportData(s.db, "2026-11-04", s.cfg, s.clock.now()), s.cfg).md;
    expect(md).toMatch(/Run #1: \*\*done\*\*, \d+ calls, finished 2026-11-04 \d\d:\d\d UTC \(\d\d:\d\d Europe\/Warsaw\)/);
  });
});

describe("guard 7: anomaly line", () => {
  it("fires under 50% or over 200% of the median of earlier reports", () => {
    const h = [{ count: 20 }, { count: 22 }, { count: 18 }];
    expect(anomalyLine(10, h)).toBeNull(); // exactly 50%
    expect(anomalyLine(9, h)).toMatch(/^\*\*Anomaly:\*\* 9 new apps is 45% of the median of the last 3 reports \(20\)/);
    expect(anomalyLine(41, h)).toMatch(/205%/);
    expect(anomalyLine(40, h)).toBeNull();
    expect(anomalyLine(1, h.slice(0, 2))).toBeNull(); // not enough history
    expect(anomalyLine(5, [{ count: 0 }, { count: 0 }, { count: 0 }])).toBeNull();
  });

  it("reads history from earlier JSON reports and puts the line at the top", () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const rows = (n: number) => ({ csv: "", md: "", json: JSON.stringify(Array.from({ length: n }, () => ({}))) });
    writeReports(dir, "2026-11-01", rows(20));
    writeReports(dir, "2026-11-02", rows(30));
    writeReports(dir, "2026-11-03", rows(25));
    writeReports(dir, "2026-11-05", rows(99)); // after the report date: ignored
    expect(readHistory(dir, "2026-11-04")).toEqual([
      { date: "2026-11-03", count: 25 },
      { date: "2026-11-02", count: 30 },
      { date: "2026-11-01", count: 20 },
    ]);
    const cfg = testConfig();
    const md = buildReport(loadReportData(openDb(":memory:"), "2026-11-04", cfg, Date.parse("2026-11-04T12:00:00Z"), readHistory(dir, "2026-11-04")), cfg).md;
    expect(md.split("\n")[2]).toMatch(/^\*\*Anomaly:\*\* 0 new apps is 0% of the median of the last 3 reports \(25\)/);
  });
});

describe("reviewer findings", () => {
  const base = parseApp(fixture("lookup-mixed.json").results.find((r) => r.kind === "software")!)!;
  const addApp = (db: Db, trackId: number, name: string, releaseDate: string, seenAt: string) =>
    upsertApps(db, [{ row: { ...base, trackId, name, releaseDate }, storefronts: ["us"] }], seenAt);
  const addRun = (db: Db, date: string, started: string, finished: string) =>
    db
      .prepare(
        `INSERT INTO runs (run_date, started_at, finished_at, status, phase, range_from, range_to, next_id, extend_max_hit)
         VALUES (?, ?, ?, 'done', 'rescan', 0, 0, -1, 0)`,
      )
      .run(date, started, finished);

  it("consecutive reports neither lose apps found late nor repeat date-only apps (findings 1 and 6)", () => {
    const db = openDb(":memory:");
    const cfg = testConfig();
    addRun(db, "2026-11-04", "2026-11-04T05:20:00Z", "2026-11-04T11:00:00Z");
    addRun(db, "2026-11-05", "2026-11-05T05:20:00Z", "2026-11-05T11:00:00Z");
    addApp(db, 1, "A: live 09:00 after its ID was scanned, found next day", "2026-11-04T09:00:00Z", "2026-11-05T07:00:00Z");
    addApp(db, 2, "B: found the same morning", "2026-11-04T06:00:00Z", "2026-11-04T06:30:00Z");
    addApp(db, 3, "C: date-only Nov 4", "2026-11-04T08:00:00Z", "2026-11-04T09:00:00Z");
    addApp(db, 4, "D: pre-order seen Nov 3, out Nov 5", "2026-11-05T08:00:00Z", "2026-11-03T10:00:00Z");
    addApp(db, 5, "E: old app found for the first time", "2026-11-01T07:00:00Z", "2026-11-05T07:30:00Z");
    const ids = (date: string) => buildReport(loadReportData(db, date, cfg), cfg).rows.map((r) => r.track_id).sort();
    const d4 = ids("2026-11-04");
    const d5 = ids("2026-11-05");
    expect(d4).toEqual([2, 3]);
    expect(d5).toEqual([1, 4]);
    expect(new Set([...d4, ...d5]).size).toBe(d4.length + d5.length);
  });

  it("resumes correctly when stopped in the rescan phase", async () => {
    const s = setup();
    let batches = 0;
    const first = await runScan({ ...s.base(), shouldStop: () => batches >= 11, log: (l) => void (l.phase && batches++, s.lines.push(l)) });
    expect(first.run).toMatchObject({ status: "aborted", phase: "rescan", next_id: 980 });
    const second = await runScan(s.base());
    expect(second.run.status).toBe("done");
    expect(second.run.calls).toBe(20);
    const firsts = s.lines.filter((l) => l.phase).map((l) => `${l.phase}:${l.first}`);
    expect(new Set(firsts).size).toBe(firsts.length);
    expect(countApps(s.db)).toBe(2);
  });

  it("retries a failed batch even when the run ends on its budget (finding 5)", async () => {
    let failedOnce = false;
    const s = setup({
      world: world({
        fail: (ids) => {
          if (!failedOnce && ids.includes(1003)) return (failedOnce = true);
          return false;
        },
      }),
    });
    const res = await runScan({ ...s.base(), maxCalls: 12 });
    expect(res.run.status).toBe("budget");
    expect(res.run.calls).toBeLessThanOrEqual(12);
    expect(res.run.failed_ranges).toBe("[]");
    expect(s.db.prepare("SELECT track_id FROM apps").pluck().all()).toEqual([1003]);
  });

  it("splits a batch Apple always 500s on, recovering the other IDs (seen in the live 60-call run)", async () => {
    const s = setup({ world: world({ fail: (ids) => (ids.includes(1007) ? 500 : false) }), cfg: { maxRetries: 2 } });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("done");
    expect(s.db.prepare("SELECT track_id FROM apps ORDER BY track_id").pluck().all()).toEqual([950, 1003]); // 1003 shares the poison batch
    const left = JSON.parse(res.run.failed_ranges) as { first: number; last: number }[];
    expect(left).toHaveLength(1);
    expect(left[0]!.first).toBeLessThanOrEqual(1007);
    expect(left[0]!.last).toBeGreaterThanOrEqual(1007);
    expect(left[0]!.last - left[0]!.first + 1).toBeLessThanOrEqual(2);
    // 5xx gets maxServerErrorRetries (1): 2 attempts for the first try, then 1 per piece.
    const poisonCalls = s.calls.filter((c) => c.status === 500).length;
    expect(poisonCalls).toBe(2 + 4);
  });

  it("still retries failed batches when the run ends on time, not on calls (live run 2026-11-04)", async () => {
    const s = setup({ world: world({ fail: (ids) => (ids.includes(1007) ? 500 : false) }), cfg: { maxRetries: 2, maxMinutesPerRun: 1 } });
    const res = await runScan(s.base());
    expect(res.run.status).toBe("budget");
    // 1003 shares the poison batch; only the retry's split brings it back.
    expect(s.db.prepare("SELECT track_id FROM apps").pluck().all()).toContain(1003);
    const left = JSON.parse(res.run.failed_ranges) as { first: number; last: number }[];
    expect(left).toHaveLength(1);
    expect(left[0]!.last - left[0]!.first + 1).toBeLessThanOrEqual(2);
  });

  it("counts results without a trackId (albums, artists) as hits (finding 7)", async () => {
    const s = setup({ world: world({ apps: {}, transform: (r) => (r.kind === "song" ? { wrapperType: "collection", collectionId: r.trackId } : r) }) });
    await runScan(s.base());
    expect(lastFrontier(s.db)?.max_hit_id).toBe(1055);
  });
});
