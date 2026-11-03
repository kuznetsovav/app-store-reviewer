import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportOutput } from "./build.js";

const DATED_MD = /^\d{4}-\d{2}-\d{2}\.md$/;

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
