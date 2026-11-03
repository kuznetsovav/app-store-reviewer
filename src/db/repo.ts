import type { AppRow } from "../lookup/parse.js";
import type { Db } from "./index.js";

export type RunStatus = "running" | "done" | "aborted" | "budget";
export type Phase = "extend" | "rescan";

export interface FailedRange {
  phase: Phase;
  first: number;
  last: number;
}

export interface RunRow {
  id: number;
  run_date: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  phase: Phase;
  range_from: number;
  range_to: number;
  next_id: number;
  extend_max_hit: number;
  /** Last ID looked up in the extend phase; null until the phase ends (and for runs before migration 2). */
  extend_end: number | null;
  /** JSON array of strings shown at the top of the report's coverage section. */
  warnings: string;
  empty_streak: number;
  failed_ranges: string;
  calls: number;
  hits: number;
  new_releases: number;
  error: string | null;
}

/** The mutable part of a run, written back after every batch. */
export type RunProgress = Pick<
  RunRow,
  "status" | "phase" | "next_id" | "extend_max_hit" | "empty_streak" | "calls" | "hits" | "new_releases" | "error"
> & { failed: FailedRange[] };

export interface FrontierRow {
  observed_at: string;
  max_hit_id: number;
}

export function lastFrontier(db: Db): FrontierRow | undefined {
  return db.prepare("SELECT observed_at, max_hit_id FROM frontier ORDER BY rowid DESC LIMIT 1").get() as FrontierRow | undefined;
}

export function insertFrontier(db: Db, maxHitId: number, observedAt: string): void {
  db.prepare("INSERT INTO frontier (observed_at, max_hit_id) VALUES (?, ?)").run(observedAt, maxHitId);
}

export function latestRunForDate(db: Db, runDate: string): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE run_date = ? ORDER BY id DESC LIMIT 1").get(runDate) as RunRow | undefined;
}

export function getRun(db: Db, id: number): RunRow {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow;
}

export function createRun(
  db: Db,
  r: Pick<RunRow, "run_date" | "started_at" | "range_from" | "range_to" | "next_id" | "extend_max_hit">,
): RunRow {
  const info = db
    .prepare(
      `INSERT INTO runs (run_date, started_at, status, phase, range_from, range_to, next_id, extend_max_hit)
       VALUES (@run_date, @started_at, 'running', 'extend', @range_from, @range_to, @next_id, @extend_max_hit)`,
    )
    .run(r);
  return getRun(db, Number(info.lastInsertRowid));
}

export function saveProgress(db: Db, runId: number, p: RunProgress): void {
  db.prepare(
    `UPDATE runs SET status = @status, phase = @phase, next_id = @next_id, extend_max_hit = @extend_max_hit,
       empty_streak = @empty_streak, calls = @calls, hits = @hits, new_releases = @new_releases,
       error = @error, failed_ranges = @failed_ranges
     WHERE id = @id`,
  ).run({ ...p, failed_ranges: JSON.stringify(p.failed), id: runId });
}

export function finishRun(db: Db, runId: number, p: RunProgress, finishedAt: string): void {
  db.transaction(() => {
    saveProgress(db, runId, p);
    db.prepare("UPDATE runs SET finished_at = ? WHERE id = ?").run(finishedAt, runId);
  })();
}

/** Track IDs already stored between lo and hi (inclusive). They are released, so rescans skip them. */
export function knownIdsBetween(db: Db, lo: number, hi: number): Set<number> {
  const rows = db.prepare("SELECT track_id FROM apps WHERE track_id BETWEEN ? AND ?").pluck().all(lo, hi) as number[];
  return new Set(rows);
}

/**
 * Inserts new apps and refreshes known ones, merging storefronts.
 * Returns the apps that were inserted (not seen before).
 */
export function upsertApps(db: Db, apps: { row: AppRow; storefronts: string[] }[], nowIso: string): AppRow[] {
  const select = db.prepare("SELECT storefronts FROM apps WHERE track_id = ?").pluck();
  const insert = db.prepare(
    `INSERT INTO apps (track_id, bundle_id, name, seller_name, artist_id, primary_genre, genres, price, currency,
       release_date, current_version_release_date, version, track_view_url, storefronts, first_seen_at, last_seen_at, raw)
     VALUES (@trackId, @bundleId, @name, @sellerName, @artistId, @primaryGenre, @genres, @price, @currency,
       @releaseDate, @currentVersionReleaseDate, @version, @trackViewUrl, @storefronts, @now, @now, @raw)`,
  );
  const update = db.prepare(
    `UPDATE apps SET bundle_id = @bundleId, name = @name, seller_name = @sellerName, artist_id = @artistId,
       primary_genre = @primaryGenre, genres = @genres, price = @price, currency = @currency,
       release_date = @releaseDate, current_version_release_date = @currentVersionReleaseDate,
       version = @version, track_view_url = @trackViewUrl, storefronts = @storefronts, last_seen_at = @now
     WHERE track_id = @trackId`,
  );
  const inserted: AppRow[] = [];
  for (const { row, storefronts } of apps) {
    const existing = select.get(row.trackId) as string | undefined;
    const merged = [...new Set([...(existing ? (JSON.parse(existing) as string[]) : []), ...storefronts])].sort();
    const params = { ...row, genres: JSON.stringify(row.genres), storefronts: JSON.stringify(merged), now: nowIso, raw: JSON.stringify(row.raw) };
    if (existing === undefined) {
      insert.run(params);
      inserted.push(row);
    } else {
      update.run(params);
    }
  }
  return inserted;
}

export function addWarning(db: Db, runId: number, text: string): void {
  const current = JSON.parse((db.prepare("SELECT warnings FROM runs WHERE id = ?").pluck().get(runId) as string) ?? "[]") as string[];
  db.prepare("UPDATE runs SET warnings = ? WHERE id = ?").run(JSON.stringify([...current, text]), runId);
}

export function setExtendEnd(db: Db, runId: number, lastId: number): void {
  db.prepare("UPDATE runs SET extend_end = ? WHERE id = ?").run(lastId, runId);
}

/** An `apps` row as stored (JSON columns still strings). */
export interface AppDbRow {
  track_id: number;
  bundle_id: string | null;
  name: string | null;
  seller_name: string | null;
  artist_id: number | null;
  primary_genre: string | null;
  genres: string;
  price: number | null;
  currency: string | null;
  release_date: string | null;
  current_version_release_date: string | null;
  version: string | null;
  track_view_url: string | null;
  storefronts: string;
  first_seen_at: string;
  last_seen_at: string;
  raw: string;
}

/** Apps with release_date at or after `isoLower` (string compare on ISO timestamps). */
export function appsReleasedSince(db: Db, isoLower: string): AppDbRow[] {
  return db.prepare("SELECT * FROM apps WHERE release_date >= ?").all(isoLower) as AppDbRow[];
}

export function recentRuns(db: Db, n: number): RunRow[] {
  return db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(n) as RunRow[];
}

export function countApps(db: Db): number {
  return db.prepare("SELECT COUNT(*) FROM apps").pluck().get() as number;
}
