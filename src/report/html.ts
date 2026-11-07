import type { Config } from "../config.js";
import type { AppDbRow } from "../db/repo.js";
import { formatTimes, isDayLevel, zonedDate } from "../scan/dates.js";
import { anomalyLine, coverageLines, formatPrice } from "./build.js";
import type { ReportData } from "./query.js";
import { formatChange, formatShare, marketLine, marketStats, summarizeThemes, themesNote } from "./themes.js";
import { matchWatchlist } from "./watchlist.js";

const DAY_MS = 86_400_000;

/** Escapes text for HTML element content and quoted attributes. */
export function esc(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes, then turns the coverage lines' **bold** markers into <strong>. */
const rich = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

/** Only http(s) links reach an href or src; anything else is dropped. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : null;
  } catch {
    return null;
  }
}

function iconUrl(a: AppDbRow): string | null {
  try {
    const raw = JSON.parse(a.raw) as Record<string, unknown>;
    const u = raw.artworkUrl100 ?? raw.artworkUrl60;
    return typeof u === "string" ? safeUrl(u) : null;
  } catch {
    return null;
  }
}

/** Day-level dates as the Pacific calendar day Apple meant; precise ones in UTC. */
function releaseLabel(iso: string | null, cfg: Config): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  if (isDayLevel(iso)) return zonedDate(ms, cfg.windowTimeZone);
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function appCell(a: AppDbRow): string {
  const icon = iconUrl(a);
  const img = icon ? `<img src="${esc(icon)}" alt="" width="40" height="40" loading="lazy">` : `<span class="noicon" aria-hidden="true"></span>`;
  const url = safeUrl(a.track_view_url);
  const name = esc(a.name ?? "—");
  const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name;
  return `<div class="app">${img}<div><div class="name">${title}</div><div class="sub">${esc(a.seller_name ?? "—")}</div></div></div>`;
}

const STYLE = `
:root{--bg:#f7f7f5;--surface:#fff;--text:#1c1c1e;--muted:#6b6b70;--line:#e4e4e0;--accent:#0a66d8;--bar:#9db8e0;--warn-bg:#fff4dc;--warn-line:#e9b949;--ok:#1d7a46;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141416;--surface:#1d1d20;--text:#ececef;--muted:#9a9aa2;--line:#2e2e33;--accent:#6aa8ff;--bar:#3a5a8a;--warn-bg:#3a2f12;--warn-line:#a07a1c;--ok:#5bc48a;--bad:#ff8a80}}
:root[data-theme="dark"]{--bg:#141416;--surface:#1d1d20;--text:#ececef;--muted:#9a9aa2;--line:#2e2e33;--accent:#6aa8ff;--bar:#3a5a8a;--warn-bg:#3a2f12;--warn-line:#a07a1c;--ok:#5bc48a;--bad:#ff8a80}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:28px;line-height:1.2;margin:0 0 4px}
h2{font-size:18px;margin:40px 0 12px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.lede{color:var(--muted);margin:0 0 24px;max-width:75ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tile .k{color:var(--muted);font-size:13px}.tile .v{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}
.status-done .v{color:var(--ok)}.status-aborted .v{color:var(--bad)}
.banner{background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:10px;padding:12px 16px;margin:0 0 20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:4px 16px}
ul.coverage{margin:0;padding:12px 0 12px 20px}ul.coverage li{margin:4px 0}
.bars{display:grid;grid-template-columns:minmax(120px,max-content) 1fr 3ch;gap:6px 12px;align-items:center;padding:12px 0}
.bars .track{height:10px;background:var(--line);border-radius:5px;overflow:hidden}.bars .fill{height:100%;background:var(--bar)}
.bars .n{text-align:right;font-variant-numeric:tabular-nums}
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:0}
th{font-size:13px;color:var(--muted);font-weight:600;white-space:nowrap}
th[data-sort]{cursor:pointer;user-select:none}th[data-sort]:hover{color:var(--text)}
th[aria-sort="ascending"]::after{content:" ▲"}th[aria-sort="descending"]::after{content:" ▼"}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.nowrap{white-space:nowrap}
td.up{color:var(--ok)}td.down{color:var(--bad)}
.app{display:flex;gap:10px;align-items:center;min-width:220px}
.app img,.noicon{width:40px;height:40px;border-radius:9px;flex:none;background:var(--line)}
.app .name{font-weight:500}.sub{color:var(--muted);font-size:13px}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.controls input,.controls select{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
.controls input{flex:1 1 220px}
.empty{color:var(--muted);font-style:italic;padding:12px 0}
footer{color:var(--muted);font-size:13px;margin-top:40px}
`;

// Search, genre filter and column sorting for the main table. No external scripts.
const SCRIPT = `
(function(){
  var t=document.getElementById("apps");if(!t)return;
  var body=t.tBodies[0],rows=Array.prototype.slice.call(body.rows);
  var q=document.getElementById("q"),g=document.getElementById("genre"),shown=document.getElementById("shown");
  function filter(){
    var s=q.value.trim().toLowerCase(),gv=g.value,n=0;
    rows.forEach(function(r){var ok=(!s||r.dataset.text.indexOf(s)>=0)&&(!gv||r.dataset.genre===gv);r.hidden=!ok;if(ok)n++;});
    shown.textContent=n;
  }
  q.addEventListener("input",filter);g.addEventListener("change",filter);
  Array.prototype.forEach.call(t.tHead.rows[0].cells,function(th){
    var key=th.dataset.sort;if(!key)return;
    th.tabIndex=0;
    function sort(){
      var asc=th.getAttribute("aria-sort")!=="ascending";
      Array.prototype.forEach.call(t.tHead.rows[0].cells,function(c){c.removeAttribute("aria-sort");});
      th.setAttribute("aria-sort",asc?"ascending":"descending");
      var num=key==="price";
      rows.sort(function(a,b){
        var x=a.dataset[key]||"",y=b.dataset[key]||"";
        var c=num?(parseFloat(x||"-1")-parseFloat(y||"-1")):x.localeCompare(y);
        return asc?c:-c;
      });
      rows.forEach(function(r){body.appendChild(r);});
    }
    th.addEventListener("click",sort);
    th.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();sort();}});
  });
})();
`;

/** A self-contained HTML page with the same content as the Markdown report. */
export function toHtml(d: ReportData, apps: AppDbRow[], cfg: Config): string {
  const n = apps.length;
  const title = `${n} new app${n === 1 ? "" : "s"} — ${d.date}`;
  const t = (ms: number) => formatTimes(ms, cfg.displayTimeZone);
  const parts: string[] = [];

  parts.push(`<h1>${esc(title)}</h1>`);
  parts.push(
    `<p class="lede">Window: apps first found between ${esc(t(d.windowStart))} and ${esc(t(d.windowEnd))} and released since ${esc(t(d.windowStart - DAY_MS))}, ` +
      `plus apps found earlier whose release date arrived in that span. Date-only release dates count by calendar day in ${esc(cfg.windowTimeZone)}` +
      `${cfg.windowMode === "mixed" ? "" : ` (window mode: ${esc(cfg.windowMode)})`}. Storefronts: ${esc(cfg.storefronts.join(", "))}.</p>`,
  );

  const anomaly = anomalyLine(n, d.history);
  if (anomaly) parts.push(`<div class="banner" role="note">${rich(anomaly)}</div>`);

  const free = apps.filter((a) => a.price === 0).length;
  const unknown = apps.filter((a) => a.price === null).length;
  const byGenre = new Map<string, number>();
  for (const a of apps) byGenre.set(a.primary_genre ?? "Unknown", (byGenre.get(a.primary_genre ?? "Unknown") ?? 0) + 1);
  const genres = [...byGenre].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], "en"));
  const status = d.run?.status ?? "no run";
  const tile = (k: string, v: string | number, cls = "") => `<div class="tile${cls ? ` ${cls}` : ""}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
  parts.push(
    `<div class="tiles">${tile("New apps", n)}${tile("Free", free)}${tile("Paid", n - free - unknown)}${tile("Genres", genres.length)}` +
      `${tile("Run status", status, `status-${status.replace(/\W+/g, "-")}`)}</div>`,
  );

  parts.push(`<h2>Coverage</h2><div class="card"><ul class="coverage">${coverageLines(d, cfg).map((l) => `<li>${rich(l)}</li>`).join("")}</ul></div>`);

  const wl = cfg.watchlist;
  const terms = [...wl.keywords.map((k) => `"${k}"`), ...wl.genres.map((g) => `genre ${g}`)];
  parts.push(`<h2>Watchlist</h2>`);
  parts.push(`<p class="lede">${terms.length ? `Terms: ${esc(terms.join(", "))} (name, description or genre; case-insensitive).` : "No watchlist terms configured."}</p>`);
  const matches = apps.map((a) => ({ a, m: matchWatchlist(a, wl) })).filter((x) => x.m.length);
  if (matches.length) {
    parts.push(
      `<div class="tablewrap"><table><thead><tr><th>App</th><th>Matched</th><th>Genre</th><th class="num">Price</th></tr></thead><tbody>` +
        matches
          .map(({ a, m }) => `<tr><td>${appCell(a)}</td><td>${esc(m.join(", "))}</td><td>${esc(a.primary_genre ?? "—")}</td><td class="num">${esc(formatPrice(a.price, a.currency))}</td></tr>`)
          .join("") +
        `</tbody></table></div>`,
    );
  } else parts.push(`<p class="empty">No matches.</p>`);

  parts.push(`<h2>Genres</h2>`);
  if (n === 0) parts.push(`<p class="empty">Nothing to count.</p>`);
  else {
    const max = genres[0]![1];
    parts.push(
      `<div class="card"><div class="bars">` +
        genres
          .map(([g, c]) => `<div>${esc(g)}</div><div class="track"><div class="fill" style="width:${((c / max) * 100).toFixed(1)}%"></div></div><div class="n">${c}</div>`)
          .join("") +
        `</div></div>`,
    );
    parts.push(`<p class="lede">${esc(marketLine(marketStats(apps), n))}</p>`);
  }

  parts.push(`<h2>Themes</h2>`);
  if (n === 0) parts.push(`<p class="empty">Nothing to count.</p>`);
  else {
    const s = summarizeThemes(apps, d.history);
    const changeClass = (r: { share: number; previousShare: number | null }) =>
      r.previousShare === null || Math.abs(r.share - r.previousShare) < 0.005 ? "" : r.share > r.previousShare ? " up" : " down";
    parts.push(
      `<div class="tablewrap"><table><thead><tr><th>Theme</th><th class="num">Apps</th><th class="num">Share</th><th class="num">Earlier</th><th class="num">Change</th><th>Examples</th></tr></thead><tbody>` +
        s.rows
          .map(
            (r) =>
              `<tr><td class="nowrap">${esc(r.label)}</td><td class="num">${r.count}</td><td class="num">${esc(formatShare(r.share))}</td>` +
              `<td class="num">${esc(formatShare(r.previousShare))}</td><td class="num${changeClass(r)}">${esc(formatChange(r.share, r.previousShare))}</td>` +
              `<td class="sub">${esc(r.examples.join(", "))}</td></tr>`,
          )
          .join("") +
        `</tbody></table></div>`,
    );
    parts.push(`<p class="sub">${esc(themesNote(s, n))}</p>`);
  }

  parts.push(`<h2>All new apps</h2>`);
  if (n === 0) parts.push(`<p class="empty">No new apps in this window.</p>`);
  else {
    parts.push(
      `<div class="controls"><input id="q" type="search" placeholder="Search name or seller" aria-label="Search apps">` +
        `<select id="genre" aria-label="Filter by genre"><option value="">All genres</option>${genres.map(([g]) => `<option>${esc(g)}</option>`).join("")}</select>` +
        `<span class="sub" style="align-self:center">Showing <span id="shown">${n}</span> of ${n}</span></div>`,
    );
    const rows = apps.map((a) => {
      const sf = (JSON.parse(a.storefronts) as string[]).join(", ");
      const data =
        `data-text="${esc(`${a.name ?? ""} ${a.seller_name ?? ""}`.toLowerCase())}" data-genre="${esc(a.primary_genre ?? "Unknown")}" ` +
        `data-name="${esc((a.name ?? "").toLowerCase())}" data-price="${a.price ?? ""}" data-released="${esc(a.release_date ?? "")}"`;
      return (
        `<tr ${data}><td>${appCell(a)}</td><td>${esc(a.primary_genre ?? "—")}</td><td class="num">${esc(formatPrice(a.price, a.currency))}</td>` +
        `<td>${esc(sf)}</td><td class="nowrap">${esc(releaseLabel(a.release_date, cfg))}</td></tr>`
      );
    });
    parts.push(
      `<div class="tablewrap"><table id="apps"><thead><tr><th data-sort="name">App</th><th>Genre</th><th class="num" data-sort="price">Price</th><th>Storefronts</th>` +
        `<th data-sort="released" aria-sort="descending">Released</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
    );
  }

  parts.push(`<footer>Built from Apple's public iTunes Lookup API. Same data as ${esc(d.date)}.csv / .json / .md.</footer>`);

  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${esc(title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n<main>\n${parts.join("\n")}\n</main>\n` +
    (n ? `<script>${SCRIPT}</script>\n` : "") +
    `</body>\n</html>\n`
  );
}
