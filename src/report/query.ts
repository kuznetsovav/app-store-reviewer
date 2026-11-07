import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import {
  appsReleasedSince,
  earlierRunsForDate,
  lastFrontier,
  latestRunForDate,
  previousFinishedRun,
  type AppDbRow,
  type FrontierRow,
  type RunRow,
} from "../db/repo.js";
import { inRange, type WindowMode } from "../scan/dates.js";

const DAY_MS = 86_400_000;

export interface ReportHistory {
  date: string;
  count: number;
  /** Apps per theme id (see themes.ts). */
  themes?: Record<string, number>;
}

export interface ReportData {
  /** YYYY-MM-DD (UTC), same convention as runs.run_date. */
  date: string;
  run: RunRow | null;
  /** The end of the last finished run of an earlier date (or windowEnd − 24h when there is none). */
  windowStart: number;
  /** This run's finish time (or now / end of day when there is none). */
  windowEnd: number;
  previousRun: RunRow | null;
  /** Earlier runs of the same date; their apps are in this report too. */
  earlierRuns: RunRow[];
  /** Apps selected for this report (see selectForReport). */
  apps: AppDbRow[];
  frontier: FrontierRow | undefined;
  /** New-app and theme counts of earlier reports, newest first (anomaly line, themes). */
  history: ReportHistory[];
}

/**
 * Consecutive reports must neither lose nor repeat apps. An ID is looked up once per run,
 * somewhere in a ~5-hour scan, so a fixed "24 h before finish" window loses apps that went
 * live after their ID was scanned. Instead, with start = previous run's finish and end =
 * this run's finish, an app is listed when either:
 *  - fresh: first stored in (start, end] and released on or after start − 24 h, or
 *  - matured: stored earlier (e.g. a pre-order) and its release date arrived in (start, end].
 * Each app therefore lands in exactly one report. A date with several runs gets one report
 * (named after the date) whose window spans all of them, from the previous date's last run.
 */
export function selectForReport(a: Pick<AppDbRow, "first_seen_at" | "release_date">, start: number, end: number, mode: WindowMode, tz: string): boolean {
  const seen = Date.parse(a.first_seen_at);
  if (seen > start && seen <= end) return inRange(a.release_date, start - DAY_MS, end, mode, tz, true);
  if (seen <= start) return inRange(a.release_date, start, end, mode, tz, false);
  return false; // first seen after this report's end
}

export function loadReportData(db: Db, date: string, cfg: Config, now = Date.now(), history: ReportHistory[] = []): ReportData {
  const run = latestRunForDate(db, date) ?? null;
  const endOfDay = Date.parse(`${date}T00:00:00Z`) + DAY_MS;
  const windowEnd = run ? (run.finished_at ? Date.parse(run.finished_at) : now) : Math.min(endOfDay, now);
  const previousRun = previousFinishedRun(db, date, run?.id ?? null, new Date(windowEnd).toISOString()) ?? null;
  const earlierRuns = run ? earlierRunsForDate(db, date, run.id) : [];
  const windowStart = Math.min(windowEnd, previousRun?.finished_at ? Date.parse(previousRun.finished_at) : windowEnd - DAY_MS);
  // Pre-filter in SQL (index on release_date); 2 extra days cover date-only values in any zone.
  const lower = new Date(windowStart - 3 * DAY_MS).toISOString();
  const apps = appsReleasedSince(db, lower).filter((a) => selectForReport(a, windowStart, windowEnd, cfg.windowMode, cfg.windowTimeZone));
  return { date, run, windowStart, windowEnd, previousRun, earlierRuns, apps, frontier: lastFrontier(db), history: history.filter((h) => h.date < date) };
}
