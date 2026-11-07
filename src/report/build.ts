import type { Config } from "../config.js";
import type { AppDbRow, FailedRange } from "../db/repo.js";
import { formatTimes } from "../scan/dates.js";
import type { ReportData } from "./query.js";
import { toHtml } from "./html.js";
import { descriptionOf, descriptionSnippet } from "./raw.js";
import { formatChange, formatShare, hasDescription, marketLine, marketStats, signalsNote, summarizeSignals, summarizeThemes, themesNote, type TagSummary, type TaggableApp } from "./themes.js";
import { matchWatchlist } from "./watchlist.js";

export const CSV_COLUMNS = [
  "track_id",
  "name",
  "seller_name",
  "primary_genre",
  "price",
  "currency",
  "release_date",
  "storefronts",
  "track_view_url",
  "bundle_id",
  "description",
] as const;

export interface ReportRow {
  track_id: number;
  name: string | null;
  seller_name: string | null;
  primary_genre: string | null;
  price: number | null;
  currency: string | null;
  release_date: string | null;
  storefronts: string[];
  track_view_url: string | null;
  bundle_id: string | null;
  /** Full App Store description; null when not stored (pruned raw JSON). */
  description: string | null;
}

export interface ReportOutput {
  count: number;
  headline: string;
  rows: ReportRow[];
  csv: string;
  json: string;
  md: string;
  html: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const DAY_MS = 86_400_000;

/** Median of the last 7 earlier reports; null when fewer than 3 exist. */
export function anomalyLine(count: number, history: { count: number }[]): string | null {
  const last = history.slice(0, 7).map((h) => h.count).sort((a, b) => a - b);
  if (last.length < 3) return null;
  const mid = Math.floor(last.length / 2);
  const median = last.length % 2 ? last[mid]! : (last[mid - 1]! + last[mid]!) / 2;
  if (median <= 0) return null;
  const pct = Math.round((count / median) * 100);
  if (count < 0.5 * median) return `**Anomaly:** ${count} new apps is ${pct}% of the median of the last ${last.length} reports (${median}). Check the coverage below before trusting this list.`;
  if (count > 2 * median) return `**Anomaly:** ${count} new apps is ${pct}% of the median of the last ${last.length} reports (${median}). Check for duplicates or a change in what Apple returns.`;
  return null;
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** release_date newest first, then name. */
export function sortApps(apps: AppDbRow[]): AppDbRow[] {
  return [...apps].sort((a, b) => cmp(b.release_date ?? "", a.release_date ?? "") || (a.name ?? "").localeCompare(b.name ?? "", "en"));
}

export function toRow(a: AppDbRow): ReportRow {
  return {
    track_id: a.track_id,
    name: a.name,
    seller_name: a.seller_name,
    primary_genre: a.primary_genre,
    price: a.price,
    currency: a.currency,
    release_date: a.release_date,
    storefronts: JSON.parse(a.storefronts) as string[],
    track_view_url: a.track_view_url,
    bundle_id: a.bundle_id,
    description: descriptionOf(a),
  };
}

export const toTaggable = (a: AppDbRow): TaggableApp => ({ name: a.name, description: descriptionOf(a) });

/** Characters of the description shown next to each app in the Markdown and HTML lists. */
export const SNIPPET_CHARS = 140;

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 quoting. Text starting with = + - @ (or tab/CR) gets a leading ' so
 * spreadsheets don't evaluate it as a formula; the JSON report keeps the original.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join(";") : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ReportRow[]): string {
  const lines = [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))];
  return lines.join("\n") + "\n";
}

// ── Markdown ─────────────────────────────────────────────────────────────────

const mdCell = (s: string | null | undefined) =>
  (s ?? "—").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim() || "—";

const mdLink = (text: string | null, url: string | null) => {
  const label = mdCell(text).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return url ? `[${label}](<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>)` : label;
};

export function formatPrice(price: number | null, currency: string | null): string {
  if (price === null) return "—";
  if (price === 0) return "Free";
  return `${price.toFixed(2)} ${currency ?? ""}`.trim();
}

/** The coverage bullets: what this run looked at, and what it skipped. */
export function coverageLines(d: ReportData, cfg: Config): string[] {
  const lines: string[] = [];
  const r = d.run;
  if (!r) {
    lines.push(`No scan ran on ${d.date}. The list below comes from apps stored by earlier runs.`);
    if (d.frontier) lines.push(`Latest frontier: ${fmt(d.frontier.max_hit_id)} (observed ${formatTimes(Date.parse(d.frontier.observed_at), cfg.displayTimeZone)}).`);
    return lines;
  }

  for (const w of JSON.parse(r.warnings ?? "[]") as string[]) lines.push(`**Warning:** ${w}`);
  const finished = r.finished_at ? `finished ${formatTimes(Date.parse(r.finished_at), cfg.displayTimeZone)}` : "still running";
  lines.push(`Run #${r.id}: **${r.status}**${r.error ? ` (${r.error})` : ""}, ${fmt(r.calls)} calls, ${finished}.`);
  for (const e of d.earlierRuns) {
    const when = e.finished_at ? `finished ${formatTimes(Date.parse(e.finished_at), cfg.displayTimeZone)}` : "not finished";
    lines.push(`Also includes apps from run #${e.id} earlier the same day: **${e.status}**, ${fmt(e.calls)} calls, ${when}. Its coverage details are in the git history of this file.`);
  }

  const extendDone = r.phase === "rescan";
  if (extendDone) {
    lines.push(`Frontier: ${fmt(r.range_to)} → ${fmt(r.extend_max_hit)} (+${fmt(r.extend_max_hit - r.range_to)} IDs).`);
    lines.push(
      r.extend_end !== null
        ? `Extend: IDs ${fmt(r.range_to + 1)} – ${fmt(r.extend_end)} scanned.`
        : `Extend: finished (range not recorded for this run).`,
    );
  } else {
    lines.push(`Frontier: ${fmt(r.range_to)}; the search for the new frontier did not finish (highest hit so far ${fmt(r.extend_max_hit)}).`);
    lines.push(
      r.next_id - 1 > r.range_to ? `Extend: IDs ${fmt(r.range_to + 1)} – ${fmt(r.next_id - 1)} scanned, then stopped.` : `Extend: not started.`,
    );
  }

  const lookback = r.range_to - r.range_from + 1;
  let skipped: [number, number] | null = null;
  let lowCovered: number;
  if (!extendDone) {
    lines.push(`Rescan: not reached.`);
    skipped = [r.range_from, r.range_to];
    lowCovered = r.range_to + 1;
  } else {
    lowCovered = Math.max(r.next_id + 1, r.range_from);
    const covered = Math.max(0, r.range_to - lowCovered + 1);
    lines.push(`Rescan: ${fmt(r.range_to)} down to ${fmt(Math.min(lowCovered, r.range_to))}, ${fmt(covered)} of ${fmt(lookback)} lookback IDs.`);
    if (r.next_id >= r.range_from) skipped = [r.range_from, r.next_id];
  }
  if (skipped && r.status !== "running") {
    lines.push(
      `**Skipped (${r.status}):** IDs ${fmt(skipped[0])} – ${fmt(skipped[1])} (${fmt(skipped[1] - skipped[0] + 1)} IDs) were not rescanned. Apps released there are missing from this report.`,
    );
  }
  const failed = JSON.parse(r.failed_ranges) as FailedRange[];
  if (failed.length) {
    lines.push(`Failed batches not retried: ${failed.map((f) => `${fmt(f.first)} – ${fmt(f.last)}`).join(", ")}.`);
  }

  const top = Math.max(r.extend_max_hit, r.range_to);
  const days = Math.max(0, top - lowCovered) / cfg.idsPerDayEstimate;
  const span = days >= 1 ? `${days.toFixed(1)} days` : `${Math.max(0.1, days * 24).toFixed(1)} hours`;
  lines.push(
    `Scope: apps released in the window whose App Store record was created in roughly the last ${span} ` +
      `(IDs ${fmt(Math.min(lowCovered, top))} – ${fmt(top)}, at ~${fmt(cfg.idsPerDayEstimate)} new IDs/day), plus apps stored by earlier runs. ` +
      `Apps that sat unreleased longer are not covered; the median app waits ~13 days between record creation and release.`,
  );
  return lines;
}

export function toMarkdown(d: ReportData, apps: AppDbRow[], cfg: Config): string {
  const n = apps.length;
  const out: string[] = [];
  out.push(`# ${n} new app${n === 1 ? "" : "s"} — ${d.date}`, "");
  const anomaly = anomalyLine(n, d.history);
  if (anomaly) out.push(anomaly, "");
  const t = (ms: number) => formatTimes(ms, cfg.displayTimeZone);
  out.push(
    `Window: apps first found between ${t(d.windowStart)} and ${t(d.windowEnd)} and released since ${t(d.windowStart - DAY_MS)}, ` +
      `plus apps found earlier whose release date arrived in that span. Date-only release dates count by calendar day in ${cfg.windowTimeZone}` +
      `${cfg.windowMode === "mixed" ? "" : ` (window mode: ${cfg.windowMode})`}. Storefronts: ${cfg.storefronts.join(", ")}.`,
    "",
  );

  out.push("## Coverage", "", ...coverageLines(d, cfg).map((l) => `- ${l}`), "");

  const wl = cfg.watchlist;
  const terms = [...wl.keywords.map((k) => `"${k}"`), ...wl.genres.map((g) => `genre ${g}`)];
  out.push("## Watchlist", "");
  out.push(terms.length ? `Terms: ${terms.join(", ")} (name, description or genre; case-insensitive).` : "No watchlist terms configured.", "");
  const matches = apps.map((a) => ({ a, m: matchWatchlist(a, wl) })).filter((x) => x.m.length);
  if (matches.length) {
    out.push("| App | Matched | Seller | Genre | Price |", "| --- | --- | --- | --- | --- |");
    for (const { a, m } of matches) {
      out.push(`| ${mdLink(a.name, a.track_view_url)} | ${mdCell(m.join(", "))} | ${mdCell(a.seller_name)} | ${mdCell(a.primary_genre)} | ${formatPrice(a.price, a.currency)} |`);
    }
  } else out.push("_No matches._");
  out.push("");

  out.push("## Counts", "");
  if (n === 0) out.push("_Nothing to count._");
  else {
    const byGenre = new Map<string, number>();
    for (const a of apps) byGenre.set(a.primary_genre ?? "Unknown", (byGenre.get(a.primary_genre ?? "Unknown") ?? 0) + 1);
    out.push("| Genre | Apps |", "| --- | ---: |");
    for (const [g, c] of [...byGenre].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], "en"))) out.push(`| ${mdCell(g)} | ${c} |`);
    const free = apps.filter((a) => a.price === 0).length;
    const unknown = apps.filter((a) => a.price === null).length;
    out.push("", `**Free:** ${free} · **Paid:** ${n - free - unknown}${unknown ? ` · **Unknown price:** ${unknown}` : ""}`);
    out.push("", `**Market:** ${marketLine(marketStats(apps), n)}`);
  }
  out.push("");

  const tagged = apps.map(toTaggable);
  const tagTable = (head: string, s: TagSummary) => {
    out.push(`| ${head} | Apps | Share | Earlier | Change | Examples |`, "| --- | ---: | ---: | ---: | ---: | --- |");
    for (const r of s.rows) {
      out.push(`| ${mdCell(r.label)} | ${r.count} | ${formatShare(r.share)} | ${formatShare(r.previousShare)} | ${formatChange(r.share, r.previousShare)} | ${mdCell(r.examples.join(", "))} |`);
    }
  };

  out.push("## Themes", "");
  if (n === 0) out.push("_Nothing to count._");
  else {
    const s = summarizeThemes(tagged, d.history);
    tagTable("Theme", s);
    out.push("", themesNote(s, tagged.some(hasDescription)));
  }
  out.push("");

  out.push("## Signals", "");
  const signals = summarizeSignals(tagged, d.history);
  if (signals.total === 0) out.push(n === 0 ? "_Nothing to count._" : "_No descriptions stored for these apps._");
  else {
    tagTable("Signal", signals);
    out.push("", signalsNote(signals, n));
  }
  out.push("");

  out.push("## All new apps", "");
  if (n === 0) out.push("_No new apps in this window._");
  else {
    out.push("| App | Seller | Genre | Price | Storefronts | Released | About |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const a of apps) {
      out.push(
        `| ${mdLink(a.name, a.track_view_url)} | ${mdCell(a.seller_name)} | ${mdCell(a.primary_genre)} | ${formatPrice(a.price, a.currency)} | ${(JSON.parse(a.storefronts) as string[]).join(", ")} | ${mdCell(a.release_date)} | ${mdCell(descriptionSnippet(descriptionOf(a), SNIPPET_CHARS) || null)} |`,
      );
    }
  }
  return out.join("\n") + "\n";
}

export function buildReport(d: ReportData, cfg: Config): ReportOutput {
  const apps = sortApps(d.apps);
  const rows = apps.map(toRow);
  const md = toMarkdown(d, apps, cfg);
  return { count: rows.length, headline: md.split("\n")[0]!.replace(/^# /, ""), rows, csv: toCsv(rows), json: JSON.stringify(rows, null, 2) + "\n", md, html: toHtml(d, apps, cfg) };
}
