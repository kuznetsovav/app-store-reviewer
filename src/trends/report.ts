import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trendsConfig, type Config } from "../config.js";
import { formatPrice } from "../report/build.js";
import { esc, safeUrl, STYLE } from "../report/html.js";
import { CHART_LABELS } from "./charts.js";
import { GROWTH_FLOOR, type AppInfo, type Position, type TrendsReport, type Windowed } from "./query.js";

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (x: number) => `+${fmt(Math.round(x * 100))}%`;
const avg = (a: number | null) => (a === null ? "—" : a.toFixed(1));
const released = (a: AppInfo) => (a.releaseDate ? a.releaseDate.slice(0, 10) : "—");

export function positionLabel(p: Position | null): string {
  if (!p) return "—";
  return `#${p.rank} ${chartLabel(p)}`;
}

/** "Top Free" for the overall chart, "Top Free · Games: Puzzle" for a genre chart. */
export function chartLabel(p: Pick<Position, "chart" | "genreId" | "genreName">): string {
  const chart = CHART_LABELS[p.chart] ?? p.chart;
  return p.genreId === 0 ? chart : `${chart} · ${p.genreName ?? `genre ${p.genreId}`}`;
}

function windowNote(w: Windowed<unknown>, date: string, what: string): string {
  if (!w.baseDate) return `Needs a second day of ${what}; the first one is ${date}.`;
  const span = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${w.baseDate}T00:00:00Z`)) / 86_400_000);
  return w.partial
    ? `Only ${span} day${span === 1 ? "" : "s"} of ${what} so far: compared with ${w.baseDate}, not ${w.days} days back.`
    : `Compared with ${w.baseDate} (${span} days back).`;
}

export function headline(r: TrendsReport): string {
  return (
    `Viral apps ${r.date} (${r.country.toUpperCase()}): ${r.breakouts.length} breakouts, ${r.fastStarters.length} fast starters, ` +
    `${r.climbers[0]?.rows.length ?? 0} chart climbers and ${r.ratings[0]?.rows.length ?? 0} rating risers over 7 days.`
  );
}

export function coverageLines(r: TrendsReport, cfg: Config): string[] {
  const tc = trendsConfig(cfg);
  const c = r.coverage;
  const lines: string[] = [];
  if (c.run) {
    lines.push(
      `Snapshot run: **${c.run.status}**. ${fmt(c.run.charts_ok)} charts fetched${c.run.charts_failed ? `, ${fmt(c.run.charts_failed)} failed` : ""}; ` +
        `rating counts of ${fmt(c.run.apps_tracked)} apps in ${fmt(c.run.lookup_calls)} Lookup calls${c.run.error ? `. Stopped: ${c.run.error}` : ""}.`,
    );
  } else lines.push("No snapshot run recorded for this date.");
  lines.push(
    `Today: ${fmt(c.chartsToday)} charts (top 100 each; ${tc.charts.map((x) => CHART_LABELS[x] ?? x).join(", ")}; all apps plus ${tc.genreIds.filter((g) => g !== 0).length} genres) ` +
      `with ${fmt(c.appsCharting)} distinct apps; rating counts for ${fmt(c.appsRated)} apps.`,
  );
  lines.push(
    `History: chart snapshots on ${fmt(c.chartDays)} day${c.chartDays === 1 ? "" : "s"}${c.firstChartDate ? ` since ${c.firstChartDate}` : ""}; ` +
      `rating snapshots on ${fmt(c.ratingDays)} day${c.ratingDays === 1 ? "" : "s"}${c.firstRatingDate ? ` since ${c.firstRatingDate}` : ""}. ` +
      "Apple keeps no history, so 7- and 30-day comparisons fill in as snapshots accumulate.",
  );
  lines.push(
    `Tracked for ratings: apps in any chart in the last ${tc.chartWatchDays} days and apps from the new-apps reports of the last ${tc.newAppWatchDays} days. ` +
      "An app outside every top 100 that the daily scan didn't list is not covered.",
  );
  lines.push("Rating counts stand in for downloads (only a small share of users rate). They are per storefront and Apple updates them with a lag of up to a day.");
  return lines;
}

const NOTES = {
  breakouts: (days: number) => `Released in the last ${days} days and in at least one top chart today. Overall charts first, then by rank.`,
  climbers: "Each app's biggest move; entering the top 100 counts as a climb from #101.",
  ratings: (min: number) => `Sorted by growth: new ratings ÷ the earlier count (at least ${GROWTH_FLOOR}); at least ${min} new ratings.`,
  fast: (days: number, min: number) => `Released in the last ${days} days with at least ${min} ratings, by ratings per day since release.`,
};

const mdCell = (s: string | null | undefined) => (s ?? "—").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
function mdApp(a: AppInfo): string {
  const name = mdCell(a.name ?? `App ${a.trackId}`).replace(/[[\]]/g, "\\$&");
  const url = safeUrl(a.url);
  return url ? `[${name}](${url})` : name;
}

/** `numeric` marks right-aligned columns. */
function mdTable(head: [string, boolean][], rows: string[][]): string[] {
  return [`| ${head.map(([h]) => h).join(" | ")} |`, `|${head.map(([, n]) => (n ? " ---: " : " --- ")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
}

export function toMarkdown(r: TrendsReport, cfg: Config): string {
  const tc = trendsConfig(cfg);
  const out: string[] = [];
  out.push(`# Viral apps — ${r.country.toUpperCase()}, ${r.date}`, "");
  out.push(
    "Apps gaining fast on the App Store, from daily snapshots of Apple's public top charts and the rating counts of tracked apps (iTunes Lookup API). " +
      "No download numbers: chart moves and new ratings are the signal.",
    "",
  );
  out.push("## Coverage", "", ...coverageLines(r, cfg).map((l) => `- ${l}`), "");

  out.push("## Breakouts: new apps already charting", "", NOTES.breakouts(tc.newAppMaxAgeDays), "");
  if (r.breakouts.length)
    out.push(
      ...mdTable(
        [["#", true], ["App", false], ["Genre", false], ["Released", false], ["Best position", false], ["Charts", true], ["Ratings", true]],
        r.breakouts.map((b, i) => [String(i + 1), mdApp(b.app), mdCell(b.app.genre), released(b.app), positionLabel(b.best), String(b.charts), b.ratings === null ? "—" : fmt(b.ratings)]),
      ),
    );
  else out.push("_None today._");
  out.push("");

  for (const w of r.climbers) {
    out.push(`## Climbing the charts — last ${w.days} days`, "", `${windowNote(w, r.date, "chart snapshots")} ${NOTES.climbers}`, "");
    if (w.rows.length)
      out.push(
        ...mdTable(
          [["#", true], ["App", false], ["Chart", false], ["Then", true], ["Now", true], ["Gain", true]],
          w.rows.map((c, i) => [String(i + 1), mdApp(c.app), mdCell(chartLabel(c.move)), c.move.prev === null ? "new" : `#${c.move.prev}`, `#${c.move.rank}`, `+${c.move.gain}`]),
        ),
      );
    else if (w.baseDate) out.push("_No climbers._");
    out.push("");
  }

  for (const w of r.ratings) {
    out.push(`## Fastest-growing ratings — last ${w.days} days`, "", `${windowNote(w, r.date, "rating snapshots")} ${NOTES.ratings(tc.minRatings)}`, "");
    if (w.rows.length)
      out.push(
        ...mdTable(
          [["#", true], ["App", false], ["Genre", false], ["Then", true], ["Now", true], ["Gain", true], ["Growth", true], ["Avg", true], ["Best position", false]],
          w.rows.map((g, i) => [String(i + 1), mdApp(g.app), mdCell(g.app.genre), fmt(g.base), fmt(g.now), `+${fmt(g.delta)}`, pct(g.growth), avg(g.avg), positionLabel(g.best)]),
        ),
      );
    else if (w.baseDate) out.push("_No app gained enough ratings._");
    out.push("");
  }

  out.push("## Fast starters", "", NOTES.fast(tc.newAppMaxAgeDays, tc.minRatings), "");
  if (r.fastStarters.length)
    out.push(
      ...mdTable(
        [["#", true], ["App", false], ["Genre", false], ["Released", false], ["Ratings", true], ["Per day", true], ["Avg", true], ["Best position", false]],
        r.fastStarters.map((f, i) => [String(i + 1), mdApp(f.app), mdCell(f.app.genre), released(f.app), fmt(f.ratings), f.perDay.toFixed(1), avg(f.avg), positionLabel(f.best)]),
      ),
    );
  else out.push("_None today._");
  out.push("");
  return out.join("\n");
}

function htmlApp(a: AppInfo): string {
  const icon = safeUrl(a.artwork);
  const img = icon ? `<img src="${esc(icon)}" alt="" width="40" height="40" loading="lazy">` : `<span class="noicon" aria-hidden="true"></span>`;
  const url = safeUrl(a.url);
  const name = esc(a.name ?? `App ${a.trackId}`);
  const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name;
  const price = a.price === null ? "" : ` · ${esc(formatPrice(a.price, a.currency))}`;
  return `<div class="app">${img}<div><div class="name">${title}</div><div class="sub">${esc(a.seller ?? "—")}${price}</div></div></div>`;
}

/** Cells are already-escaped HTML. */
function htmlTable(head: [string, boolean][], rows: string[][]): string {
  const th = head.map(([h, n]) => `<th${n ? ' class="num"' : ""}>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${head[i]![1] ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("");
  return `<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const rich = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

export function toHtml(r: TrendsReport, cfg: Config): string {
  const tc = trendsConfig(cfg);
  const title = `Viral apps — ${r.country.toUpperCase()}, ${r.date}`;
  const p: string[] = [];
  p.push(`<h1>${esc(title)}</h1>`);
  p.push(
    `<p class="lede">Apps gaining fast on the App Store, from daily snapshots of Apple's public top charts and the rating counts of tracked apps. ` +
      `No download numbers: chart moves and new ratings are the signal. <a href="latest.html">New apps report →</a></p>`,
  );
  const tile = (k: string, v: string | number) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
  p.push(
    `<div class="tiles">${tile("Breakouts", r.breakouts.length)}${tile("Fast starters", r.fastStarters.length)}${tile("Climbers (7d)", r.climbers[0]?.rows.length ?? 0)}` +
      `${tile("Rating risers (7d)", r.ratings[0]?.rows.length ?? 0)}${tile("Days of history", r.coverage.chartDays)}</div>`,
  );
  p.push(`<h2>Coverage</h2><div class="card"><ul class="coverage">${coverageLines(r, cfg).map((l) => `<li>${rich(l)}</li>`).join("")}</ul></div>`);

  const section = (h: string, note: string, table: string | null, empty: string | null) => {
    p.push(`<h2>${esc(h)}</h2><p class="lede">${esc(note)}</p>`);
    if (table) p.push(table);
    else if (empty) p.push(`<p class="empty">${esc(empty)}</p>`);
  };

  section(
    "Breakouts: new apps already charting",
    NOTES.breakouts(tc.newAppMaxAgeDays),
    r.breakouts.length
      ? htmlTable(
          [["#", true], ["App", false], ["Genre", false], ["Released", false], ["Best position", false], ["Charts", true], ["Ratings", true]],
          r.breakouts.map((b, i) => [String(i + 1), htmlApp(b.app), esc(b.app.genre ?? "—"), esc(released(b.app)), esc(positionLabel(b.best)), String(b.charts), b.ratings === null ? "—" : fmt(b.ratings)]),
        )
      : null,
    "None today.",
  );

  for (const w of r.climbers)
    section(
      `Climbing the charts — last ${w.days} days`,
      `${windowNote(w, r.date, "chart snapshots")} ${NOTES.climbers}`,
      w.rows.length
        ? htmlTable(
            [["#", true], ["App", false], ["Chart", false], ["Then", true], ["Now", true], ["Gain", true]],
            w.rows.map((c, i) => [String(i + 1), htmlApp(c.app), esc(chartLabel(c.move)), c.move.prev === null ? "new" : `#${c.move.prev}`, `#${c.move.rank}`, `<span class="up">+${c.move.gain}</span>`]),
          )
        : null,
      w.baseDate ? "No climbers." : null,
    );

  for (const w of r.ratings)
    section(
      `Fastest-growing ratings — last ${w.days} days`,
      `${windowNote(w, r.date, "rating snapshots")} ${NOTES.ratings(tc.minRatings)}`,
      w.rows.length
        ? htmlTable(
            [["#", true], ["App", false], ["Genre", false], ["Then", true], ["Now", true], ["Gain", true], ["Growth", true], ["Avg", true], ["Best position", false]],
            w.rows.map((g, i) => [String(i + 1), htmlApp(g.app), esc(g.app.genre ?? "—"), fmt(g.base), fmt(g.now), `<span class="up">+${fmt(g.delta)}</span>`, pct(g.growth), avg(g.avg), esc(positionLabel(g.best))]),
          )
        : null,
      w.baseDate ? "No app gained enough ratings." : null,
    );

  section(
    "Fast starters",
    NOTES.fast(tc.newAppMaxAgeDays, tc.minRatings),
    r.fastStarters.length
      ? htmlTable(
          [["#", true], ["App", false], ["Genre", false], ["Released", false], ["Ratings", true], ["Per day", true], ["Avg", true], ["Best position", false]],
          r.fastStarters.map((f, i) => [String(i + 1), htmlApp(f.app), esc(f.app.genre ?? "—"), esc(released(f.app)), fmt(f.ratings), f.perDay.toFixed(1), avg(f.avg), esc(positionLabel(f.best))]),
        )
      : null,
    "None today.",
  );

  p.push(`<footer>Built from Apple's public RSS top charts and iTunes Lookup API. Same data as viral.json / viral.md.</footer>`);
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${esc(title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n<main>\n${p.join("\n")}\n</main>\n</body>\n</html>\n`
  );
}

/** Writes reports/viral.{md,html,json}; git history keeps earlier days. */
export function writeTrendsReport(dir: string, r: TrendsReport, cfg: Config): string[] {
  mkdirSync(dir, { recursive: true });
  const files: [string, string][] = [
    ["viral.md", toMarkdown(r, cfg)],
    ["viral.html", toHtml(r, cfg)],
    ["viral.json", JSON.stringify(r, null, 2) + "\n"],
  ];
  return files.map(([f, body]) => {
    const path = join(dir, f);
    writeFileSync(path, body);
    return path;
  });
}
