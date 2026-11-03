import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { upsertApps } from "../src/db/repo.js";
import { parseApp, type AppRow } from "../src/lookup/parse.js";
import { CSV_COLUMNS, buildReport } from "../src/report/build.js";
import { loadReportData } from "../src/report/query.js";
import { writeReports } from "../src/report/write.js";
import { runScan } from "../src/scan/run.js";
import { fakeClock, fakeLookup, fixture, testConfig } from "./helpers.js";

const cfg = testConfig();
const base = parseApp(fixture("lookup-mixed.json").results.find((r) => r.kind === "software")!)!;
const DATE = "2026-11-04";
const NOON = Date.parse("2026-11-04T12:00:00Z");

function addApp(db: Db, o: Partial<AppRow> & { trackId: number }, seenAt = "2026-11-04T01:00:00Z") {
  upsertApps(db, [{ row: { ...base, ...o, raw: { ...base.raw, trackId: o.trackId, trackName: o.name ?? base.name ?? undefined } }, storefronts: ["us"] }], seenAt);
}

/** Minimal RFC 4180 reader, to check the CSV round-trips. */
function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = "");
    else field += c;
  }
  return rows;
}

describe("buildReport", () => {
  it("escapes commas, quotes and newlines in CSV, and guards formulas", () => {
    const db = openDb(":memory:");
    const names = ["Comma, Inc", 'Say "hi"', "Line\nBreak", "=SUM(A1)"];
    names.forEach((name, i) => addApp(db, { trackId: 10 + i, name, releaseDate: `2026-11-04T0${i}:00:00Z` }));
    const out = buildReport(loadReportData(db, DATE, cfg, NOON), cfg);

    const rows = parseCsv(out.csv);
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(5);
    const csvNames = rows.slice(1).map((r) => r[1]);
    expect(csvNames).toEqual(["'=SUM(A1)", "Line\nBreak", 'Say "hi"', "Comma, Inc"]); // newest first
    expect(rows.slice(1).every((r) => r.length === CSV_COLUMNS.length)).toBe(true);
    // JSON keeps the original value.
    expect(JSON.parse(out.json).map((r: { name: string }) => r.name)).toContain("=SUM(A1)");
    // Markdown table cells stay on one line.
    expect(out.md).toContain("Line Break");
    expect(out.md).not.toMatch(/\| Line\n/);
  });

  it("sorts by release date (newest first), then by name", () => {
    const db = openDb(":memory:");
    addApp(db, { trackId: 1, name: "Bravo", releaseDate: "2026-11-04T08:00:00Z" });
    addApp(db, { trackId: 2, name: "Alpha", releaseDate: "2026-11-04T08:00:00Z" });
    addApp(db, { trackId: 3, name: "Zulu", releaseDate: "2026-11-04T10:00:00Z" });
    const out = buildReport(loadReportData(db, DATE, cfg, NOON), cfg);
    expect(out.rows.map((r) => r.name)).toEqual(["Zulu", "Alpha", "Bravo"]);
  });

  it("handles zero apps", () => {
    const db = openDb(":memory:");
    const out = buildReport(loadReportData(db, DATE, cfg, NOON), cfg);
    expect(out.count).toBe(0);
    expect(out.headline).toBe("0 new apps — 2026-11-04");
    expect(out.csv).toBe(CSV_COLUMNS.join(",") + "\n");
    expect(out.json).toBe("[]\n");
    expect(out.md).toContain("No scan ran on 2026-11-04");
    expect(out.md).toContain("_No new apps in this window._");
  });

  it("lists apps stored by earlier runs when their release falls in today's window", () => {
    const db = openDb(":memory:");
    addApp(db, { trackId: 1, name: "Stored yesterday", releaseDate: "2026-11-04T08:00:00Z" }, "2026-11-03T02:00:00Z");
    addApp(db, { trackId: 2, name: "Old app", releaseDate: "2026-10-01T07:00:00Z" }, "2026-11-04T02:00:00Z");
    const out = buildReport(loadReportData(db, DATE, cfg, Date.parse("2026-11-05T00:00:00Z")), cfg);
    expect(out.rows.map((r) => r.name)).toEqual(["Stored yesterday"]);
  });

  it("puts watchlist matches first, with counts and the full table", () => {
    const db = openDb(":memory:");
    addApp(db, { trackId: 1, name: "Gift Planner", primaryGenre: "Shopping", price: 0 });
    addApp(db, { trackId: 2, name: "Calc", primaryGenre: "Utilities", price: 1.99, currency: "USD" });
    const out = buildReport(loadReportData(db, DATE, cfg, NOON), cfg);
    const md = out.md;
    expect(md.indexOf("## Watchlist")).toBeLessThan(md.indexOf("## All new apps"));
    expect(md).toMatch(/\| \[Gift Planner\]\(<https:\/\/apps\.apple\.com\/[^>]+>\) \| keyword "gift" \|/);
    expect(md).toContain("**Free:** 1 · **Paid:** 1");
    expect(md).toContain("1.99 USD");
  });
});

describe("report after a scan", () => {
  function scanned(maxCalls: number) {
    const db = openDb(":memory:");
    const clock = fakeClock("2026-11-04T00:00:00Z");
    const lookup = fakeLookup({ frontier: 1055, songEvery: 5, apps: { us: new Set([1003, 950]) } });
    const c = testConfig({ batchSize: 10, lookbackIds: 100, emptyBatchesToStop: 3 });
    return {
      db,
      clock,
      c,
      run: () =>
        runScan({
          db,
          cfg: c,
          maxCalls,
          seed: { id: 1000, observedAt: "2026-11-03T00:00:00Z" },
          now: clock.now,
          log: () => {},
          clientOptions: { fetchImpl: lookup.fetchImpl, limiter: clock.limiter(), sleep: clock.sleep },
        }),
    };
  }

  it("names the skipped range when the budget ran out during the rescan", async () => {
    const s = scanned(12); // 9 extend batches + 3 rescan batches (1000 → 971)
    const res = await s.run();
    expect(res.run.status).toBe("budget");
    const out = buildReport(loadReportData(s.db, DATE, s.c, s.clock.now()), s.c);
    expect(out.md).toContain("Run #1: **budget**, 12 calls");
    expect(out.md).toContain("Frontier: 1,000 → 1,055 (+55 IDs).");
    expect(out.md).toContain("Extend: IDs 1,001 – 1,090 scanned.");
    expect(out.md).toContain("Rescan: 1,000 down to 971, 30 of 101 lookback IDs.");
    expect(out.md).toContain("**Skipped (budget):** IDs 900 – 970 (71 IDs) were not rescanned.");
    expect(out.rows.map((r) => r.track_id)).toEqual([1003]); // 950 is in the skipped range
    expect(out.md).toContain("created in roughly the last 0.1 hours (IDs 971 – 1,055");
  });

  it("says the rescan was not reached when the budget ran out while extending", async () => {
    const s = scanned(5);
    await s.run();
    const out = buildReport(loadReportData(s.db, DATE, s.c, s.clock.now()), s.c);
    expect(out.md).toContain("the search for the new frontier did not finish");
    expect(out.md).toContain("Rescan: not reached.");
    expect(out.md).toContain("**Skipped (budget):** IDs 900 – 1,000 (101 IDs)");
  });

  it("reports a full run as done with nothing skipped", async () => {
    const s = scanned(1000);
    await s.run();
    const out = buildReport(loadReportData(s.db, DATE, s.c, s.clock.now()), s.c);
    expect(out.md).toContain("**done**");
    expect(out.md).not.toContain("Skipped");
    expect(out.count).toBe(2);
  });
});

describe("writeReports", () => {
  it("writes all four files and keeps latest.md on a backfill", () => {
    const dir = mkdtempSync(join(tmpdir(), "reports-"));
    const today = { csv: "a\n", json: "[]\n", md: "# today\n" };
    const first = writeReports(dir, "2026-11-04", today);
    expect(first.latestUpdated).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["2026-11-04.csv", "2026-11-04.json", "2026-11-04.md", "latest.md"]);

    const backfill = writeReports(dir, "2026-11-02", { csv: "b\n", json: "[]\n", md: "# old\n" });
    expect(backfill.latestUpdated).toBe(false);
    expect(readFileSync(join(dir, "latest.md"), "utf8")).toBe("# today\n");
  });
});
