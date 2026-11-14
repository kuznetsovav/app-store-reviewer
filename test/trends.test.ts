import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { Db } from "../src/db/index.js";
import { LookupClient, type LookupResult } from "../src/lookup/client.js";
import { chartSpecs, chartUrl, parseChartFeed, type ChartEntry } from "../src/trends/charts.js";
import { collectTrends, importNewApps, saveChart, saveRatings, watchList } from "../src/trends/collect.js";
import { openTrendsDb } from "../src/trends/db.js";
import { ageDays, baseDate, loadTrendsReport } from "../src/trends/query.js";
import { toHtml, toMarkdown, writeTrendsReport } from "../src/trends/report.js";
import { fakeClock, fixture, testConfig } from "./helpers.js";

const chartFixture = () => JSON.parse(readFileSync(new URL("./fixtures/rss-chart.json", import.meta.url), "utf8"));
const app = fixture("lookup-mixed.json").results.find((r) => r.kind === "software")!;
const NOW = "2026-11-14T20:40:00Z";
const quiet = () => {};

function cfgWith(trends: Config["trends"] = {}): Config {
  return testConfig({ trends: { charts: ["topfree"], genreIds: [0, 6014], minRatings: 20, minRankGain: 10, ...trends } });
}

function entry(trackId: number, o: Partial<ChartEntry> = {}): ChartEntry {
  return {
    rank: 1,
    trackId,
    name: `App ${trackId}`,
    seller: "Seller",
    genre: "Games",
    genreId: 6014,
    releaseDate: "2026-01-01T08:00:00Z",
    price: 0,
    currency: "USD",
    url: `https://apps.apple.com/us/app/id${trackId}`,
    artwork: null,
    ...o,
  };
}

/** Ranks follow list order. */
const chart = (entries: ChartEntry[]) => entries.map((e, i) => ({ ...e, rank: i + 1 }));

describe("parseChartFeed", () => {
  it("reads the recorded legacy feed", () => {
    const e = parseChartFeed(chartFixture())!;
    expect(e).toHaveLength(3);
    expect(e[0]).toMatchObject({ rank: 1, trackId: 6761760135, name: "Meowdoku!", genre: "Games", genreId: 6014, price: 0, currency: "USD" });
    // Pacific midnight ("-07:00") becomes the UTC instant, like Lookup's day-level dates.
    expect(e[0]!.releaseDate).toBe("2026-05-19T07:00:00Z");
    expect(e[0]!.artwork).toMatch(/100x100bb\.png$/);
    expect(e.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it("handles one entry, no entries and non-feed bodies", () => {
    const one = chartFixture();
    one.feed.entry = one.feed.entry[0];
    expect(parseChartFeed(one)).toHaveLength(1);
    const none = chartFixture();
    delete none.feed.entry;
    expect(parseChartFeed(none)).toEqual([]);
    expect(parseChartFeed(null)).toBeNull();
    expect(parseChartFeed({ results: [] })).toBeNull();
  });

  it("builds feed URLs", () => {
    expect(chartUrl({ country: "us", chart: "topfree", genreId: 0 })).toBe("https://itunes.apple.com/us/rss/topfreeapplications/limit=100/json");
    expect(chartUrl({ country: "us", chart: "topgrossing", genreId: 7012 })).toBe("https://itunes.apple.com/us/rss/topgrossingapplications/limit=100/genre=7012/json");
    expect(() => chartUrl({ country: "us", chart: "nope", genreId: 0 })).toThrow(/Unknown chart/);
    expect(chartSpecs(["us"], ["topfree", "toppaid"], [0, 6014])).toHaveLength(4);
  });
});

/** Fake Apple: chart feeds from the fixture, Lookup answering with rating counts. */
function fakeApple(o: { failChart?: (url: string) => number | undefined; lookupEmpty?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/rss/")) {
      const code = o.failChart?.(url);
      if (code) return new Response("nope", { status: code });
      return new Response(JSON.stringify(chartFixture()), { status: 200 });
    }
    const ids = new URL(url).searchParams.get("id")!.split(",").map(Number);
    const results: LookupResult[] = o.lookupEmpty ? [] : ids.map((id) => ({ ...app, trackId: id, userRatingCount: 50, averageUserRating: 4.5 }));
    return new Response(JSON.stringify({ resultCount: results.length, results }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(cfg: Config, fetchImpl: typeof fetch, maxLookupCalls?: number) {
  const clock = fakeClock(NOW);
  return { clock, client: new LookupClient(cfg, { fetchImpl, limiter: clock.limiter(), sleep: clock.sleep, now: clock.now, maxLookupCalls }) };
}

const count = (db: Db, sql: string) => db.prepare(sql).pluck().get() as number;

/** 60 apps in 60 one-entry charts, so the watch list needs several Lookup batches. */
function sixtyCharted(db: Db) {
  for (let i = 0; i < 60; i++) saveChart(db, "2026-11-14", { country: "us", chart: "toppaid", genreId: 6000 + i }, [entry(1000 + i)], NOW);
}

describe("collectTrends", () => {
  it("snapshots charts and ratings, then resumes without repeating work", async () => {
    const cfg = cfgWith();
    const db = openTrendsDb(":memory:");
    const apple = fakeApple();
    const { clock, client } = makeClient(cfg, apple.fetchImpl);
    const run = await collectTrends(db, client, cfg, { reportsDir: "/nonexistent", now: clock.now, log: quiet });
    expect(run).toMatchObject({ snap_date: "2026-11-14", status: "done", charts_ok: 2, charts_failed: 0, apps_tracked: 3, lookup_calls: 1 });
    expect(count(db, "SELECT COUNT(*) FROM chart_entries")).toBe(6);
    expect(count(db, "SELECT COUNT(*) FROM rating_snapshots WHERE rating_count = 50")).toBe(3);
    expect(db.prepare("SELECT first_charted, last_charted FROM apps WHERE track_id = 6761760135").get()).toEqual({ first_charted: "2026-11-14", last_charted: "2026-11-14" });

    const before = apple.calls.length;
    const again = await collectTrends(db, client, cfg, { reportsDir: "/nonexistent", now: clock.now, log: quiet });
    expect(again).toMatchObject({ status: "done", chart_calls: 0, lookup_calls: 0 });
    expect(apple.calls.length).toBe(before);
  });

  it("retries a failed chart on the next run", async () => {
    const cfg = cfgWith();
    const db = openTrendsDb(":memory:");
    let fail = true;
    const { clock, client } = makeClient(cfg, fakeApple({ failChart: (u) => (fail && u.includes("genre=6014") ? 404 : undefined) }).fetchImpl);
    const first = await collectTrends(db, client, cfg, { reportsDir: "/x", now: clock.now, log: quiet });
    expect(first).toMatchObject({ status: "done", charts_ok: 1, charts_failed: 1 });
    fail = false;
    const second = await collectTrends(db, client, cfg, { reportsDir: "/x", now: clock.now, log: quiet });
    expect(second).toMatchObject({ charts_ok: 1, chart_calls: 1 });
    expect(count(db, "SELECT COUNT(*) FROM chart_snapshots")).toBe(2);
  });

  it("treats an empty overall chart as a failure", async () => {
    const cfg = cfgWith({ genreIds: [0] });
    const db = openTrendsDb(":memory:");
    const empty = (async () => new Response(JSON.stringify({ feed: { title: { label: "x" } } }), { status: 200 })) as unknown as typeof fetch;
    const { clock, client } = makeClient(cfg, empty);
    const run = await collectTrends(db, client, cfg, { reportsDir: "/x", now: clock.now, log: quiet });
    expect(run).toMatchObject({ charts_ok: 0, charts_failed: 1 });
    expect(count(db, "SELECT COUNT(*) FROM chart_snapshots")).toBe(0);
  });

  it("aborts when Lookup returns nothing for known apps, and saves no ratings", async () => {
    const cfg = { ...cfgWith(), maxConsecutiveFailures: 2, batchSize: 20 };
    const db = openTrendsDb(":memory:");
    sixtyCharted(db);
    const { clock, client } = makeClient(cfg, fakeApple({ lookupEmpty: true }).fetchImpl);
    const run = await collectTrends(db, client, cfg, { reportsDir: "/x", now: clock.now, log: quiet });
    expect(run.status).toBe("aborted");
    expect(run.error).toMatch(/2 failed requests in a row/);
    expect(count(db, "SELECT COUNT(*) FROM rating_snapshots")).toBe(0);
  });

  it("stops at the call budget with status budget", async () => {
    const cfg = { ...cfgWith(), batchSize: 20 };
    const db = openTrendsDb(":memory:");
    sixtyCharted(db);
    const { clock, client } = makeClient(cfg, fakeApple().fetchImpl, 2);
    const run = await collectTrends(db, client, cfg, { reportsDir: "/x", now: clock.now, log: quiet });
    expect(run).toMatchObject({ status: "budget", lookup_calls: 2 });
    expect(count(db, "SELECT COUNT(*) FROM rating_snapshots")).toBe(40);
  });
});

describe("watch list", () => {
  it("imports apps from recent new-apps reports and ranks charted apps first", () => {
    const dir = mkdtempSync(join(tmpdir(), "trends-"));
    writeFileSync(join(dir, "2026-11-10.json"), JSON.stringify([{ track_id: 111, name: "Fresh", release_date: "2026-11-10T09:00:00Z" }, { track_id: "bad" }]));
    writeFileSync(join(dir, "2026-09-01.json"), JSON.stringify([{ track_id: 222, name: "Old" }]));
    writeFileSync(join(dir, "latest.json"), "not json");
    const db = openTrendsDb(":memory:");
    expect(importNewApps(db, dir, "2026-11-14", 30, NOW)).toBe(1);
    saveChart(db, "2026-11-14", { country: "us", chart: "topfree", genreId: 0 }, [entry(333)], NOW);
    saveChart(db, "2026-08-01", { country: "us", chart: "topfree", genreId: 0 }, [entry(444)], NOW);
    expect(watchList(db, "2026-11-14", 60, 30, 10)).toEqual([333, 111]);
    expect(watchList(db, "2026-11-14", 60, 30, 1)).toEqual([333]);
    // Importing again keeps the first discovery date.
    importNewApps(db, dir, "2026-11-20", 30, NOW);
    expect(db.prepare("SELECT discovered_on FROM apps WHERE track_id = 111").pluck().get()).toBe("2026-11-10");
  });

  it("keeps the latest chart date when an older snapshot is saved later", () => {
    const db = openTrendsDb(":memory:");
    saveChart(db, "2026-11-14", { country: "us", chart: "topfree", genreId: 0 }, [entry(1)], NOW);
    saveChart(db, "2026-11-10", { country: "us", chart: "toppaid", genreId: 0 }, [entry(1)], NOW);
    expect(db.prepare("SELECT first_charted, last_charted FROM apps WHERE track_id = 1").get()).toEqual({ first_charted: "2026-11-14", last_charted: "2026-11-14" });
  });
});

describe("loadTrendsReport", () => {
  const ALL = { country: "us", chart: "topfree", genreId: 0 };
  const GAMES = { country: "us", chart: "topfree", genreId: 6014 };
  const PAID = { country: "us", chart: "toppaid", genreId: 0 };
  const FRESH = "2026-11-04T08:00:00Z"; // 10 days before the report date

  function seed() {
    const db = openTrendsDb(":memory:");
    // 2026-11-07, the 7-day base. Overall: 1, 2, thirty fillers, then 3 at #33. Games: 9.
    saveChart(db, "2026-11-07", ALL, chart([entry(1), entry(2), ...Array.from({ length: 30 }, (_, i) => entry(500 + i)), entry(3)]), NOW);
    saveChart(db, "2026-11-07", GAMES, chart([entry(9)]), NOW);
    // 2026-11-14: 3 climbs #33 → #1; 4 (fresh) enters at #2; 2 and 1 slip; 5 (fresh) enters Games at #1.
    saveChart(db, "2026-11-14", ALL, chart([entry(3), entry(4, { releaseDate: FRESH }), entry(2), entry(1)]), NOW);
    saveChart(db, "2026-11-14", GAMES, chart([entry(5, { releaseDate: FRESH }), entry(9)]), NOW);
    // Top Paid has no snapshot on the base day, so its entries can't count as "new".
    saveChart(db, "2026-11-14", PAID, chart([entry(6)]), NOW);
    const r = (id: number, n: number) => ({ ...app, trackId: id, userRatingCount: n, averageUserRating: 4 });
    saveRatings(db, "2026-11-07", "us", [1, 2, 3], [r(1, 10_000), r(2, 50), r(3, 200)], NOW);
    saveRatings(db, "2026-11-14", "us", [1, 2, 3, 4, 5, 7, 8], [r(1, 10_500), r(2, 60), r(3, 900), r(4, 300), r(5, 40), r(7, 400), r(8, 999)], NOW);
    // saveRatings takes release dates from the Lookup fixture; set the ones the cases need.
    db.prepare("UPDATE apps SET release_date = ? WHERE track_id IN (4, 5)").run(FRESH);
    db.prepare("UPDATE apps SET release_date = '2026-11-12T10:00:00Z' WHERE track_id = 7").run();
    db.prepare("UPDATE apps SET release_date = '2025-01-01T00:00:00Z' WHERE track_id IN (1, 2, 3, 8)").run();
    return db;
  }

  it("finds breakouts, climbers, rating risers and fast starters", () => {
    const db = seed();
    const cfg = testConfig({ trends: { minRatings: 20, minRankGain: 10, newAppMaxAgeDays: 30 } });
    const r = loadTrendsReport(db, cfg, "2026-11-14");

    // Fresh apps in a chart; an overall-chart position ranks above a genre-chart one.
    expect(r.breakouts.map((b) => [b.app.trackId, b.best.genreId, b.best.rank, b.ageDays])).toEqual([
      [4, 0, 2, 10],
      [5, 6014, 1, 10],
    ]);

    // New entries count from #101. No move for 2, 9; drops for 1; 6 is in a chart the base lacks.
    expect(r.climbers[0]).toMatchObject({ days: 7, baseDate: "2026-11-07", partial: false });
    expect(r.climbers[0]!.rows.map((c) => [c.app.trackId, c.move.prev, c.move.rank, c.move.gain])).toEqual([
      [5, null, 1, 100],
      [4, null, 2, 99],
      [3, 33, 1, 32],
    ]);

    // Growth = gain / max(base, 100). 7 was released after the base day, so it started at 0.
    // 4, 5 and 8 weren't tracked on the base day and are older than it: skipped. 2 gained only 10.
    expect(r.ratings[0]!.rows.map((g) => [g.app.trackId, g.base, g.delta])).toEqual([
      [7, 0, 400],
      [3, 200, 700],
      [1, 10_000, 500],
    ]);

    // Ratings per day since release: 7 has 400 in 2 days.
    expect(r.fastStarters.map((f) => [f.app.trackId, f.perDay])).toEqual([
      [7, 200],
      [4, 30],
      [5, 4],
    ]);

    // No snapshot is 30 days old: the oldest one is used and marked partial.
    expect(r.climbers[1]).toMatchObject({ days: 30, baseDate: "2026-11-07", partial: true });
    expect(toMarkdown(r, cfg)).toContain("Only 7 days of chart snapshots so far: compared with 2026-11-07, not 30 days back.");
  });

  it("says when there is no history yet", () => {
    const db = openTrendsDb(":memory:");
    saveChart(db, "2026-11-14", ALL, [entry(1)], NOW);
    const r = loadTrendsReport(db, testConfig(), "2026-11-14");
    expect(r.climbers[0]).toMatchObject({ baseDate: null, rows: [] });
    expect(toMarkdown(r, testConfig())).toContain("Needs a second day of chart snapshots; the first one is 2026-11-14.");
  });

  it("escapes names and drops non-http links in md and html", () => {
    const db = openTrendsDb(":memory:");
    saveChart(db, "2026-11-14", ALL, [entry(1, { name: "<script>x</script> | [y]", url: "javascript:alert(1)", releaseDate: "2026-11-13T00:00:00Z" })], NOW);
    const cfg = testConfig();
    const r = loadTrendsReport(db, cfg, "2026-11-14");
    expect(r.breakouts).toHaveLength(1);
    const html = toHtml(r, cfg);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("javascript:");
    const md = toMarkdown(r, cfg);
    expect(md).toContain("\\| \\[y\\]");
    expect(md).not.toContain("javascript:");
  });

  it("writes identical files when run twice on the same data", () => {
    const db = seed();
    const cfg = testConfig();
    const dir = mkdtempSync(join(tmpdir(), "viral-"));
    const files = writeTrendsReport(dir, loadTrendsReport(db, cfg, "2026-11-14"), cfg);
    const first = files.map((f) => readFileSync(f, "utf8"));
    writeTrendsReport(dir, loadTrendsReport(db, cfg, "2026-11-14"), cfg);
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(first);
    expect(files.map((f) => f.split("/").at(-1))).toEqual(["viral.md", "viral.html", "viral.json"]);
  });
});

describe("helpers", () => {
  it("picks the base snapshot", () => {
    const dates = ["2026-11-01", "2026-11-05", "2026-11-07", "2026-11-14"];
    expect(baseDate(dates, "2026-11-14", 7)).toEqual({ baseDate: "2026-11-07", partial: false });
    expect(baseDate(dates, "2026-11-14", 30)).toEqual({ baseDate: "2026-11-01", partial: true });
    expect(baseDate(["2026-11-14"], "2026-11-14", 7)).toEqual({ baseDate: null, partial: false });
  });

  it("counts whole days since release", () => {
    expect(ageDays("2026-11-14T07:00:00Z", "2026-11-14")).toBe(0);
    expect(ageDays("2026-11-04T08:00:00Z", "2026-11-14")).toBe(10);
    expect(ageDays(null, "2026-11-14")).toBeNull();
  });
});
