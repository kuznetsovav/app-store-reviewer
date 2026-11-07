import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportOutput } from "./build.js";
import type { ReportHistory } from "./query.js";
import { countThemes } from "./themes.js";

const DATED_MD = /^\d{4}-\d{2}-\d{2}\.md$/;
const DATED_JSON = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** New-app and theme counts of reports before `date`, newest first (at most 7). Used for the anomaly line and themes. */
export function readHistory(dir: string, date: string): ReportHistory[] {
  if (!existsSync(dir)) return [];
  const out: ReportHistory[] = [];
  for (const f of readdirSync(dir).sort().reverse()) {
    const m = DATED_JSON.exec(f);
    if (!m || m[1]! >= date) continue;
    try {
      const rows = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
      if (Array.isArray(rows)) {
        const names = rows.map((r) => (r && typeof r === "object" && typeof (r as { name?: unknown }).name === "string" ? (r as { name: string }).name : null));
        out.push({ date: m[1]!, count: rows.length, themes: countThemes(names) });
      }
    } catch {
      /* skip unreadable files */
    }
    if (out.length === 7) break;
  }
  return out;
}

/**
 * Writes YYYY-MM-DD.csv/.json/.md/.html and latest.md/.html. The latest files are only
 * replaced when this date is the newest report in the folder, so backfilling an old date keeps them.
 */
export function writeReports(dir: string, date: string, out: Pick<ReportOutput, "csv" | "json" | "md" | "html">): { files: string[]; latestUpdated: boolean } {
  mkdirSync(dir, { recursive: true });
  const files = [`${date}.csv`, `${date}.json`, `${date}.md`, `${date}.html`].map((f) => join(dir, f));
  writeFileSync(files[0]!, out.csv);
  writeFileSync(files[1]!, out.json);
  writeFileSync(files[2]!, out.md);
  writeFileSync(files[3]!, out.html);
  const newest = readdirSync(dir).filter((f) => DATED_MD.test(f)).sort().at(-1);
  const latestUpdated = newest === `${date}.md`;
  if (latestUpdated) {
    for (const [name, body] of [["latest.md", out.md], ["latest.html", out.html]] as const) {
      const latest = join(dir, name);
      writeFileSync(latest, body);
      files.push(latest);
    }
  }
  return { files, latestUpdated };
}
