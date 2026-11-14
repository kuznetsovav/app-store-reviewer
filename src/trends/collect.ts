import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { trendsConfig, type Config } from "../config.js";
import type { Db } from "../db/index.js";
import { BudgetExceededError, RequestFailedError, type LookupClient, type LookupResult } from "../lookup/client.js";
import { chartGenreName, chartSpecs, chartUrl, GENRE_NAMES, parseChartFeed, type ChartEntry, type ChartSpec } from "./charts.js";

const DAY_MS = 86_400_000;
const DATED_JSON = /^(\d{4}-\d{2}-\d{2})\.json$/;

export type TrendRunStatus = "running" | "done" | "budget" | "aborted";

export interface TrendRunRow {
  id: number;
  snap_date: string;
  started_at: string;
  finished_at: string | null;
  status: TrendRunStatus;
  chart_calls: number;
  lookup_calls: number;
  charts_ok: number;
  charts_failed: number;
  apps_tracked: number;
  error: string | null;
}

export interface CollectOptions {
  /** Where the new-apps reports (YYYY-MM-DD.json) are read from. */
  reportsDir: string;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => utcDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);

interface AppMeta {
  trackId: number;
  name: string | null;
  seller: string | null;
  genre: string | null;
  releaseDate: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
  artwork: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** Refreshes metadata, keeping what's known when a source leaves a field out. */
function upsertMeta(db: Db, m: AppMeta, nowIso: string, extra: { charted?: string; discovered?: string } = {}): void {
  db.prepare(
    `INSERT INTO apps (track_id, name, seller, genre, release_date, price, currency, url, artwork, first_charted, last_charted, discovered_on, updated_at)
     VALUES (@trackId, @name, @seller, @genre, @releaseDate, @price, @currency, @url, @artwork, @charted, @charted, @discovered, @now)
     ON CONFLICT (track_id) DO UPDATE SET
       name = COALESCE(excluded.name, name), seller = COALESCE(excluded.seller, seller), genre = COALESCE(excluded.genre, genre),
       release_date = COALESCE(excluded.release_date, release_date), price = COALESCE(excluded.price, price),
       currency = COALESCE(excluded.currency, currency), url = COALESCE(excluded.url, url), artwork = COALESCE(excluded.artwork, artwork),
       first_charted = COALESCE(first_charted, excluded.first_charted),
       last_charted = CASE WHEN excluded.last_charted IS NULL THEN last_charted
                           WHEN last_charted IS NULL OR excluded.last_charted > last_charted THEN excluded.last_charted
                           ELSE last_charted END,
       discovered_on = COALESCE(discovered_on, excluded.discovered_on),
       updated_at = excluded.updated_at`,
  ).run({ ...m, charted: extra.charted ?? null, discovered: extra.discovered ?? null, now: nowIso });
}

/**
 * Adds apps from the new-apps reports of the last `days` days to the rating watch list.
 * The reports are committed to the repo, so this needs neither the scanner's DB nor the API.
 */
export function importNewApps(db: Db, reportsDir: string, snapDate: string, days: number, nowIso: string): number {
  if (!existsSync(reportsDir)) return 0;
  const from = addDays(snapDate, -days);
  let n = 0;
  for (const f of readdirSync(reportsDir).sort()) {
    const m = DATED_JSON.exec(f);
    if (!m || m[1]! < from || m[1]! > snapDate) continue;
    let rows: unknown;
    try {
      rows = JSON.parse(readFileSync(join(reportsDir, f), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    db.transaction(() => {
      for (const r of rows as Record<string, unknown>[]) {
        const trackId = num(r?.track_id);
        if (trackId === null || !Number.isInteger(trackId) || trackId <= 0) continue;
        upsertMeta(
          db,
          {
            trackId,
            name: str(r.name),
            seller: str(r.seller_name),
            genre: str(r.primary_genre),
            releaseDate: str(r.release_date),
            price: num(r.price),
            currency: str(r.currency),
            url: str(r.track_view_url),
            artwork: null,
          },
          nowIso,
          { discovered: m[1]! },
        );
        n++;
      }
    })();
  }
  return n;
}

function metaFromChart(e: ChartEntry): AppMeta {
  return { trackId: e.trackId, name: e.name, seller: e.seller, genre: e.genre, releaseDate: e.releaseDate, price: e.price, currency: e.currency, url: e.url, artwork: e.artwork };
}

function metaFromLookup(r: LookupResult): AppMeta {
  return {
    trackId: r.trackId!,
    name: str(r.trackName),
    seller: str(r.sellerName),
    genre: str(r.primaryGenreName),
    releaseDate: str(r.releaseDate),
    price: num(r.price),
    currency: str(r.currency),
    url: str(r.trackViewUrl),
    artwork: str(r.artworkUrl100) ?? str(r.artworkUrl60),
  };
}

export function saveChart(db: Db, snapDate: string, spec: ChartSpec, entries: ChartEntry[], nowIso: string): void {
  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO chart_snapshots (snap_date, country, chart, genre_id, genre_name, fetched_at, entries) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(snapDate, spec.country, spec.chart, spec.genreId, GENRE_NAMES[spec.genreId] ?? chartGenreName(spec.genreId, entries), nowIso, entries.length);
    db.prepare("DELETE FROM chart_entries WHERE snap_date = ? AND country = ? AND chart = ? AND genre_id = ?").run(snapDate, spec.country, spec.chart, spec.genreId);
    const ins = db.prepare("INSERT INTO chart_entries (snap_date, country, chart, genre_id, rank, track_id) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of entries) {
      ins.run(snapDate, spec.country, spec.chart, spec.genreId, e.rank, e.trackId);
      upsertMeta(db, metaFromChart(e), nowIso, { charted: snapDate });
    }
  })();
}

/**
 * Apps whose rating counts are tracked, best first: charted most recently, then newest
 * discoveries. Capped at maxApps so a growing list can't outrun the call budget.
 */
export function watchList(db: Db, snapDate: string, chartWatchDays: number, newAppWatchDays: number, maxApps: number): number[] {
  return db
    .prepare(
      `SELECT track_id FROM apps
       WHERE last_charted >= ? OR discovered_on >= ?
       ORDER BY COALESCE(last_charted, '') DESC, COALESCE(discovered_on, '') DESC, track_id DESC
       LIMIT ?`,
    )
    .pluck()
    .all(addDays(snapDate, -chartWatchDays), addDays(snapDate, -newAppWatchDays), maxApps) as number[];
}

/** One row per looked-up ID: the counts when Apple returned the app, NULLs when it didn't. */
export function saveRatings(db: Db, snapDate: string, country: string, ids: number[], results: LookupResult[], nowIso: string): number {
  const byId = new Map<number, LookupResult>();
  for (const r of results) if (r.kind === "software" && typeof r.trackId === "number") byId.set(r.trackId, r);
  const ins = db.prepare("INSERT OR REPLACE INTO rating_snapshots (snap_date, country, track_id, rating_count, avg_rating) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const id of ids) {
      const r = byId.get(id);
      ins.run(snapDate, country, id, r ? (num(r.userRatingCount) ?? 0) : null, r ? num(r.averageUserRating) : null);
      if (r) upsertMeta(db, metaFromLookup(r), nowIso);
    }
  })();
  return byId.size;
}

export function pruneSnapshots(db: Db, snapDate: string, keepDays: number): void {
  const before = addDays(snapDate, -keepDays);
  db.transaction(() => {
    for (const t of ["chart_entries", "chart_snapshots", "rating_snapshots"]) db.prepare(`DELETE FROM ${t} WHERE snap_date < ?`).run(before);
  })();
}

export function latestTrendRun(db: Db, snapDate?: string): TrendRunRow | undefined {
  return (
    snapDate
      ? db.prepare("SELECT * FROM trend_runs WHERE snap_date = ? ORDER BY id DESC LIMIT 1").get(snapDate)
      : db.prepare("SELECT * FROM trend_runs ORDER BY id DESC LIMIT 1").get()
  ) as TrendRunRow | undefined;
}

/**
 * One day's snapshot: every configured chart, then rating counts of the watch list.
 * Resumable: charts and apps already stored for today are skipped, and every chart and
 * batch is its own transaction, so a re-run picks up where the last one stopped.
 */
export async function collectTrends(db: Db, client: LookupClient, cfg: Config, o: CollectOptions): Promise<TrendRunRow> {
  const tc = trendsConfig(cfg);
  const now = o.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const log = o.log ?? ((line) => console.log(JSON.stringify(line)));
  const started = now();
  const deadline = started + tc.maxMinutes * 60_000;
  const snapDate = utcDate(started);
  const runId = Number(db.prepare("INSERT INTO trend_runs (snap_date, started_at, status) VALUES (?, ?, 'running')").run(snapDate, iso()).lastInsertRowid);
  const p = { status: "running" as TrendRunStatus, chart_calls: 0, lookup_calls: 0, charts_ok: 0, charts_failed: 0, apps_tracked: 0, error: null as string | null };
  const save = () =>
    db
      .prepare(
        `UPDATE trend_runs SET status = @status, chart_calls = @chart_calls, lookup_calls = @lookup_calls, charts_ok = @charts_ok,
           charts_failed = @charts_failed, apps_tracked = @apps_tracked, error = @error WHERE id = @id`,
      )
      .run({ ...p, id: runId });
  const stop = (status: TrendRunStatus, error: string) => {
    p.status = status;
    p.error = error;
  };
  let failStreak = 0;
  const failed = (what: Record<string, unknown>) => {
    failStreak++;
    log({ ts: iso(), trendRun: runId, event: "failed", streak: failStreak, ...what });
    if (failStreak >= cfg.maxConsecutiveFailures) stop("aborted", `${failStreak} failed requests in a row (last: ${JSON.stringify(what)})`);
  };

  const imported = importNewApps(db, o.reportsDir, snapDate, tc.newAppWatchDays, iso());
  log({ ts: iso(), trendRun: runId, event: "start", snapDate, newAppsImported: imported });

  // 1. Charts.
  const done = new Set(db.prepare("SELECT country || '/' || chart || '/' || genre_id FROM chart_snapshots WHERE snap_date = ?").pluck().all(snapDate) as string[]);
  for (const spec of chartSpecs(tc.countries, tc.charts, tc.genreIds)) {
    if (p.status !== "running") break;
    if (done.has(`${spec.country}/${spec.chart}/${spec.genreId}`)) continue;
    if (now() >= deadline) {
      stop("budget", `time limit of ${tc.maxMinutes} min reached while fetching charts`);
      break;
    }
    p.chart_calls++;
    let entries: ChartEntry[] | null = null;
    let status = 0;
    try {
      const r = await client.getJson(chartUrl(spec));
      status = r.status;
      entries = r.status === 200 ? parseChartFeed(r.body) : null;
    } catch (e) {
      if (!(e instanceof RequestFailedError)) throw e;
      status = e.status;
    }
    // An empty all-apps chart can't be real: Apple is serving something else.
    if (entries === null || (spec.genreId === 0 && entries.length === 0)) {
      p.charts_failed++;
      failed({ ...spec, status, reason: entries === null ? "not a chart feed" : "empty overall chart" });
    } else {
      saveChart(db, snapDate, spec, entries, iso());
      p.charts_ok++;
      failStreak = 0;
    }
    save();
  }

  // 2. Rating counts of the watch list, per country.
  for (const country of tc.countries) {
    if (p.status !== "running") break;
    const all = watchList(db, snapDate, tc.chartWatchDays, tc.newAppWatchDays, tc.maxApps);
    const have = new Set(db.prepare("SELECT track_id FROM rating_snapshots WHERE snap_date = ? AND country = ?").pluck().all(snapDate, country) as number[]);
    const todo = all.filter((id) => !have.has(id));
    log({ ts: iso(), trendRun: runId, event: "watchlist", country, apps: all.length, todo: todo.length });
    for (let i = 0; i < todo.length && p.status === "running"; i += cfg.batchSize) {
      if (now() >= deadline) {
        stop("budget", `time limit of ${tc.maxMinutes} min reached with ${todo.length - i} apps left in ${country}`);
        break;
      }
      const ids = todo.slice(i, i + cfg.batchSize);
      const before = client.lookupCalls;
      try {
        const r = await client.lookup(ids, country);
        const apps = r.results.filter((x) => x.kind === "software").length;
        // Known, mostly charting apps: a large batch with none back means blocking, not delistings.
        if (ids.length >= 20 && apps === 0) failed({ country, ids: ids.length, reason: "no apps returned" });
        else {
          saveRatings(db, snapDate, country, ids, r.results, iso());
          p.apps_tracked += ids.length;
          failStreak = 0;
        }
      } catch (e) {
        if (e instanceof BudgetExceededError) stop("budget", `lookup budget of ${tc.maxCalls} calls used with ${todo.length - i} apps left in ${country}`);
        else if (e instanceof RequestFailedError) failed({ country, ids: ids.length, status: e.status });
        else throw e;
      } finally {
        p.lookup_calls += client.lookupCalls - before;
        save();
      }
    }
  }

  if (p.status === "running") p.status = "done";
  pruneSnapshots(db, snapDate, tc.keepDays);
  db.prepare("UPDATE trend_runs SET finished_at = ? WHERE id = ?").run(iso(), runId);
  save();
  const row = db.prepare("SELECT * FROM trend_runs WHERE id = ?").get(runId) as TrendRunRow;
  log({ ts: iso(), trendRun: runId, event: "finish", ...row });
  return row;
}
