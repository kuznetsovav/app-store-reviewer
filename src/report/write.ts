import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportOutput } from "./build.js";

const DATED_MD = /^\d{4}-\d{2}-\d{2}\.md$/;
const DATED_JSON = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** New-app counts of reports before `date`, newest first (at most 7). Used for the anomaly line. */
export function readHistory(dir: string, date: string): { date: string; count: number }[] {
  if (!existsSync(dir)) return [];
  const out: { date: string; count: number }[] = [];
  for (const f of readdirSync(dir).sort().reverse()) {
    const m = DATED_JSON.exec(f);
    if (!m || m[1]! >= date) continue;
    try {
      const rows = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
      if (Array.isArray(rows)) out.push({ date: m[1]!, count: rows.length });
    } catch {
      /* skip unreadable files */
    }
    if (out.length === 7) break;
  }
  return out;
}

/**
 * Writes YYYY-MM-DD.csv/.json/.md and latest.md. latest.md is only replaced when this
 * date is the newest report in the folder, so backfilling an old date keeps it.
 */
export function writeReports(dir: string, date: string, out: Pick<ReportOutput, "csv" | "json" | "md">): { files: string[]; latestUpdated: boolean } {
  mkdirSync(dir, { recursive: true });
  const files = [`${date}.csv`, `${date}.json`, `${date}.md`].map((f) => join(dir, f));
  writeFileSync(files[0]!, out.csv);
  writeFileSync(files[1]!, out.json);
  writeFileSync(files[2]!, out.md);
  const newest = readdirSync(dir).filter((f) => DATED_MD.test(f)).sort().at(-1);
  const latestUpdated = newest === `${date}.md`;
  if (latestUpdated) {
    const latest = join(dir, "latest.md");
    writeFileSync(latest, out.md);
    files.push(latest);
  }
  return { files, latestUpdated };
}
