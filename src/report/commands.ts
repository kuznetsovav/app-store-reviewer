import { loadConfig, type Config } from "../config.js";
import { openDb, type Db } from "../db/index.js";
import { scanWithCli } from "../scan/commands.js";
import { buildReport } from "./build.js";
import { loadReportData } from "./query.js";
import { writeReports } from "./write.js";

const todayUtc = () => new Date().toISOString().slice(0, 10);

function parseDate(args: string[]): string {
  const i = args.indexOf("--date");
  const v = i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--date="))?.slice(7);
  if (v === undefined) return todayUtc();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error(`--date needs YYYY-MM-DD, got ${v}`);
  return v;
}

/** Builds and writes the reports for one date from the database only. */
export function produceReport(db: Db, cfg: Config, date: string, now = Date.now()) {
  const out = buildReport(loadReportData(db, date, cfg, now), cfg);
  const written = writeReports(cfg.reportsDir, date, out);
  console.error([out.headline, ...written.files.map((f) => `  wrote ${f}`)].join("\n"));
  if (!written.latestUpdated) console.error("  latest.md left alone: a newer report exists.");
  return { out, written };
}

export function reportCommand(args: string[]): void {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    produceReport(db, cfg, parseDate(args));
  } finally {
    db.close();
  }
}

/** scan, then report. Exit 0 on done/budget (or today already finished), 1 on aborted. */
export async function runCommand(args: string[]): Promise<void> {
  if (args.includes("--dry-run")) throw new Error("`run` has no --dry-run; use `scan --dry-run`.");
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    const res = await scanWithCli(db, cfg, args);
    // Written even after an abort: a partial list is still useful, and coverage says what's missing.
    produceReport(db, cfg, res.run.run_date);
    process.exitCode = !res.skipped && res.run.status === "aborted" ? 1 : 0;
  } finally {
    db.close();
  }
}
