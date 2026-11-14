import { loadConfig, trendsConfig, type Config } from "../config.js";
import type { Db } from "../db/index.js";
import { LookupClient } from "../lookup/client.js";
import { collectTrends, utcDate } from "./collect.js";
import { openTrendsDb } from "./db.js";
import { latestSnapDate, loadTrendsReport } from "./query.js";
import { headline, writeTrendsReport } from "./report.js";

function parseDate(args: string[]): string | undefined {
  const i = args.indexOf("--date");
  const v = i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--date="))?.slice(7);
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error(`--date needs YYYY-MM-DD, got ${v}`);
  return v;
}

export function produceTrendsReport(db: Db, cfg: Config, date: string): void {
  const r = loadTrendsReport(db, cfg, date);
  const files = writeTrendsReport(cfg.reportsDir, r, cfg);
  console.error([headline(r), ...files.map((f) => `  wrote ${f}`)].join("\n"));
}

/** Lookup calls already made by earlier invocations today, so maxCalls holds per day. */
function callsUsedToday(db: Db, date: string): number {
  return (db.prepare("SELECT COALESCE(SUM(lookup_calls), 0) FROM trend_runs WHERE snap_date = ?").pluck().get(date) as number) ?? 0;
}

/** Snapshot charts + rating counts, then write reports/viral.*. Exit 1 when the run aborted. */
export async function trendsCommand(_args: string[]): Promise<void> {
  const cfg = loadConfig();
  const tc = trendsConfig(cfg);
  const db = openTrendsDb(tc.dbPath);
  try {
    const used = callsUsedToday(db, utcDate(Date.now()));
    const client = new LookupClient(cfg, {
      maxLookupCalls: Math.max(0, tc.maxCalls - used),
      log: (line) => console.log(JSON.stringify(line)),
    });
    const run = await collectTrends(db, client, cfg, { reportsDir: cfg.reportsDir });
    console.error(
      `Trends run ${run.id} (${run.snap_date}): ${run.status}; ${run.charts_ok} charts, ${run.charts_failed} failed; ` +
        `${run.apps_tracked} apps rated in ${run.lookup_calls} Lookup calls${run.error ? `; ${run.error}` : ""}.`,
    );
    // Written even after an abort: the coverage section says what's missing.
    produceTrendsReport(db, cfg, run.snap_date);
    process.exitCode = run.status === "aborted" ? 1 : 0;
  } finally {
    db.close();
  }
}

export function trendsReportCommand(args: string[]): void {
  const cfg = loadConfig();
  const db = openTrendsDb(trendsConfig(cfg).dbPath);
  try {
    const date = parseDate(args) ?? latestSnapDate(db);
    if (!date) throw new Error("No snapshots yet; run `trends` first.");
    produceTrendsReport(db, cfg, date);
  } finally {
    db.close();
  }
}
