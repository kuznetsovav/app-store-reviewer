import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { pruneRaw } from "../db/prune.js";
import { notificationText, sendNotification } from "../notify.js";
import { readState } from "../state.js";
import { openDb, type Db } from "../db/index.js";
import { getRun } from "../db/repo.js";
import { scanWithCli } from "../scan/commands.js";
import { buildState, writeState } from "../state.js";
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

/** Drops raw JSON for old apps and compacts the DB file. */
export function pruneCommand(): void {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    const before = cfg.dbPath === ":memory:" || !existsSync(cfg.dbPath) ? 0 : statSync(cfg.dbPath).size;
    const r = pruneRaw(db, cfg.lookbackIds);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const after = cfg.dbPath === ":memory:" ? 0 : statSync(cfg.dbPath).size;
    const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
    console.error(
      r.belowId === null
        ? "Nothing to prune: no frontier yet."
        : `Pruned raw JSON of ${r.pruned} apps below ID ${r.belowId.toLocaleString("en-US")}; DB ${kb(before)} → ${kb(after)}.`,
    );
  } finally {
    db.close();
  }
}

/** POSTs the headline and watchlist of a report to NOTIFY_WEBHOOK_URL; silent no-op when unset. */
export async function notifyCommand(args: string[]): Promise<void> {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url || !url.trim()) return;
  const cfg = loadConfig();
  const explicit = args.includes("--date") || args.some((a) => a.startsWith("--date="));
  const date = explicit ? parseDate(args) : (readState(cfg.statePath)?.reportDate ?? todayUtc());
  const path = join(cfg.reportsDir, `${date}.md`);
  if (!existsSync(path)) {
    console.error(`No report for ${date}; nothing to send.`);
    return;
  }
  await sendNotification({ url, text: notificationText(readFileSync(path, "utf8")) });
}

/** scan, then report. Exit 0 on done/budget (or today already finished), 1 on aborted. */
export async function runCommand(args: string[]): Promise<void> {
  if (args.includes("--dry-run")) throw new Error("`run` has no --dry-run; use `scan --dry-run`.");
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    const res = await scanWithCli(db, cfg, args);
    // Written even after an abort: a partial list is still useful, and coverage says what's missing.
    const { out } = produceReport(db, cfg, res.run.run_date);
    writeState(cfg.statePath, buildState(db, getRun(db, res.run.id), res.run.run_date, out.count));
    console.error(`  wrote ${cfg.statePath}`);
    process.exitCode = !res.skipped && res.run.status === "aborted" ? 1 : 0;
  } finally {
    db.close();
  }
}
