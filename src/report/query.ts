import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { appsReleasedSince, lastFrontier, latestRunForDate, type AppDbRow, type FrontierRow, type RunRow } from "../db/repo.js";
import { inWindow } from "../scan/dates.js";

const DAY_MS = 86_400_000;

export interface ReportData {
  /** YYYY-MM-DD (UTC), same convention as runs.run_date. */
  date: string;
  run: RunRow | null;
  /** The window ends at the run's finish time (or now / end of day when there is none). */
  windowEnd: number;
  /** Apps whose release_date is in the window, from the whole apps table. */
  apps: AppDbRow[];
  frontier: FrontierRow | undefined;
}

export function loadReportData(db: Db, date: string, cfg: Config, now = Date.now()): ReportData {
  const run = latestRunForDate(db, date) ?? null;
  const endOfDay = Date.parse(`${date}T00:00:00Z`) + DAY_MS;
  const windowEnd = run ? (run.finished_at ? Date.parse(run.finished_at) : now) : Math.min(endOfDay, now);
  // Pre-filter in SQL (index on release_date), then apply the exact rule. 3 days covers every mode.
  const lower = new Date(windowEnd - 3 * DAY_MS).toISOString();
  const apps = appsReleasedSince(db, lower).filter((a) => inWindow(a.release_date, windowEnd, cfg.windowMode, cfg.windowTimeZone));
  return { date, run, windowEnd, apps, frontier: lastFrontier(db) };
}
