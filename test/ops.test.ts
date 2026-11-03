import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { pruneRaw } from "../src/db/prune.js";
import { getRun, insertFrontier, upsertApps } from "../src/db/repo.js";
import { parseApp } from "../src/lookup/parse.js";
import { notificationText, sendNotification } from "../src/notify.js";
import { buildReport } from "../src/report/build.js";
import { loadReportData } from "../src/report/query.js";
import { runScan } from "../src/scan/run.js";
import { buildState, readState, seedFromState, writeState } from "../src/state.js";
import { fakeClock, fakeLookup, fixture, testConfig } from "./helpers.js";

const base = parseApp(fixture("lookup-mixed.json").results.find((r) => r.kind === "software")!)!;

describe("state.json", () => {
  it("round-trips the frontier and the last run, and seeds from it", async () => {
    const db = openDb(":memory:");
    const clock = fakeClock("2026-11-04T00:00:00Z");
    const lookup = fakeLookup({ frontier: 1055, songEvery: 5, apps: { us: new Set([1003]) } });
    const cfg = testConfig({ batchSize: 10, lookbackIds: 100, emptyBatchesToStop: 3 });
    const res = await runScan({
      db,
      cfg,
      seed: { id: 1000, observedAt: "2026-11-03T00:00:00Z", source: "data/spike/frontier.json" },
      now: clock.now,
      log: () => {},
      clientOptions: { fetchImpl: lookup.fetchImpl, limiter: clock.limiter(), sleep: clock.sleep },
    });

    const path = join(mkdtempSync(join(tmpdir(), "state-")), "state", "state.json");
    writeState(path, buildState(db, getRun(db, res.run.id), "2026-11-04", 1, clock.now()));
    const s = readState(path)!;
    expect(s.frontier?.max_hit_id).toBe(1055);
    expect(s.lastRun).toMatchObject({ id: 1, status: "done", run_date: "2026-11-04" });
    expect(s).toMatchObject({ reportDate: "2026-11-04", newApps: 1 });
    expect(seedFromState(path)).toEqual({ id: 1055, observedAt: s.frontier!.observed_at, source: path });
    expect(seedFromState(join(tmpdir(), "does-not-exist.json"))).toBeUndefined();
  });

  it("records a warning when the run starts from an empty database, and the report shows it", async () => {
    const db = openDb(":memory:");
    const clock = fakeClock("2026-11-04T00:00:00Z");
    const lookup = fakeLookup({ frontier: 1055, songEvery: 5, apps: {} });
    const cfg = testConfig({ batchSize: 10, lookbackIds: 100, emptyBatchesToStop: 3 });
    const res = await runScan({
      db,
      cfg,
      seed: { id: 1000, observedAt: "2026-11-03T05:30:00Z", source: "state/state.json" },
      now: clock.now,
      log: () => {},
      maxCalls: 2,
      clientOptions: { fetchImpl: lookup.fetchImpl, limiter: clock.limiter(), sleep: clock.sleep },
    });
    expect(JSON.parse(res.run.warnings)).toEqual([expect.stringContaining("The database was empty, so this run started from state/state.json")]);
    const md = buildReport(loadReportData(db, "2026-11-04", cfg, clock.now()), cfg).md;
    expect(md).toContain("- **Warning:** The database was empty");

    // A second run on a DB that has a frontier gets no warning.
    clock.advance(86_400_000);
    const next = await runScan({ db, cfg, now: clock.now, log: () => {}, maxCalls: 1, clientOptions: { fetchImpl: lookup.fetchImpl, limiter: clock.limiter(), sleep: clock.sleep } });
    expect(next.run.warnings).toBe("[]");
  });
});

describe("pruneRaw", () => {
  it("clears raw JSON only for old apps below the lookback window", () => {
    const db = openDb(":memory:");
    insertFrontier(db, 10_000, "2026-11-04T00:00:00Z");
    const add = (trackId: number, releaseDate: string) => upsertApps(db, [{ row: { ...base, trackId, releaseDate }, storefronts: ["us"] }], "2026-11-04T00:00:00Z");
    add(100, "2026-10-01T07:00:00Z"); // old and below 9,900 → pruned
    add(9_950, "2026-10-01T07:00:00Z"); // inside the lookback → kept
    add(50, "2026-11-03T18:00:00Z"); // below, but released recently → kept
    const r = pruneRaw(db, 100, Date.parse("2026-11-04T12:00:00Z"));
    expect(r).toEqual({ pruned: 1, belowId: 9_900 });
    const raw = Object.fromEntries((db.prepare("SELECT track_id, raw FROM apps").all() as { track_id: number; raw: string }[]).map((x) => [x.track_id, x.raw]));
    expect(raw[100]).toBe("{}");
    expect(raw[9_950]).not.toBe("{}");
    expect(raw[50]).not.toBe("{}");
    expect(pruneRaw(db, 100, Date.parse("2026-11-04T12:00:00Z")).pruned).toBe(0); // idempotent
  });

  it("does nothing without a frontier", () => {
    expect(pruneRaw(openDb(":memory:"), 100)).toEqual({ pruned: 0, belowId: null });
  });
});

describe("notify", () => {
  const md = [
    "# 2 new apps — 2026-11-04",
    "",
    "Window: …",
    "",
    "## Coverage",
    "",
    "- Run #1: **done**",
    "",
    "## Watchlist",
    "",
    'Terms: "gift".',
    "",
    "| App | Matched |",
    "| --- | --- |",
    '| [Gift Planner](<https://apps.apple.com/x>) | keyword "gift" |',
    "",
    "## Counts",
    "",
    "| Genre | Apps |",
  ].join("\n");

  it("builds the text from the headline and the watchlist section only", () => {
    const text = notificationText(md);
    expect(text.startsWith("2 new apps — 2026-11-04\n\nWatchlist\n")).toBe(true);
    expect(text).toContain("Gift Planner");
    expect(text).not.toContain("Coverage");
    expect(text).not.toContain("Genre");
  });

  async function listener(status: number) {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        bodies.push(body);
        res.statusCode = status;
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/hooks/SECRET-TOKEN-123`,
      bodies,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("POSTs {text} and never logs the URL", async () => {
    const l = await listener(200);
    const logs: string[] = [];
    expect(await sendNotification({ url: l.url, text: notificationText(md), log: (m) => logs.push(m) })).toBe("sent");
    await l.close();
    expect(JSON.parse(l.bodies[0]!)).toEqual({ text: notificationText(md) });
    expect(logs.join("\n")).not.toContain("SECRET-TOKEN");
  });

  it("reports HTTP errors and unreachable hosts without the URL", async () => {
    const l = await listener(500);
    const logs: string[] = [];
    expect(await sendNotification({ url: l.url, text: "x", log: (m) => logs.push(m) })).toBe("failed");
    await l.close();
    expect(await sendNotification({ url: l.url, text: "x", log: (m) => logs.push(m), timeoutMs: 2_000 })).toBe("failed");
    expect(logs[0]).toBe("Notification failed: HTTP 500.");
    expect(logs.join("\n")).not.toContain("SECRET-TOKEN");
    expect(logs.join("\n")).not.toContain("127.0.0.1");
  });

  it("skips silently when no URL is set", async () => {
    const logs: string[] = [];
    expect(await sendNotification({ url: undefined, text: "x", log: (m) => logs.push(m) })).toBe("skipped");
    expect(await sendNotification({ url: "  ", text: "x", log: (m) => logs.push(m) })).toBe("skipped");
    expect(logs).toEqual([]);
  });
});
