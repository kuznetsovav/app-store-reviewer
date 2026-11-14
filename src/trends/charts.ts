/**
 * Apple's legacy RSS top charts (itunes.apple.com/{cc}/rss/...). Unlike the newer
 * rss.marketingtools.apple.com feeds they take a genre and include top grossing.
 * Measured 2026-11-14: 100 entries per chart even with limit=200; the newer feed 504s at 200.
 */

export const CHART_FEEDS: Record<string, string> = {
  topfree: "topfreeapplications",
  toppaid: "toppaidapplications",
  topgrossing: "topgrossingapplications",
};

export const CHART_LABELS: Record<string, string> = { topfree: "Top Free", toppaid: "Top Paid", topgrossing: "Top Grossing" };

/**
 * Genre IDs the US legacy feeds answer with ~100 apps (probed 2026-11-14). Left out because
 * they come back empty or duplicate another chart: 6021 (= News), 6022, 6025, 7007, 7008.
 * Entries in game-subgenre charts are all labelled "Games", so names come from here.
 */
export const GENRE_NAMES: Record<number, string> = {
  0: "All apps",
  6000: "Business", 6001: "Weather", 6002: "Utilities", 6003: "Travel", 6004: "Sports", 6005: "Social Networking",
  6006: "Reference", 6007: "Productivity", 6008: "Photo & Video", 6009: "News", 6010: "Navigation", 6011: "Music",
  6012: "Lifestyle", 6013: "Health & Fitness", 6014: "Games", 6015: "Finance", 6016: "Entertainment", 6017: "Education",
  6018: "Books", 6020: "Medical", 6023: "Food & Drink", 6024: "Shopping", 6026: "Developer Tools", 6027: "Graphics & Design",
  7001: "Games: Action", 7002: "Games: Adventure", 7003: "Games: Arcade", 7004: "Games: Board", 7005: "Games: Card",
  7006: "Games: Casino", 7009: "Games: Family", 7011: "Games: Music", 7012: "Games: Puzzle", 7013: "Games: Racing",
  7014: "Games: Role Playing", 7015: "Games: Simulation", 7016: "Games: Sports", 7017: "Games: Strategy",
  7018: "Games: Trivia", 7019: "Games: Word",
};

export interface ChartSpec {
  country: string;
  chart: string;
  genreId: number;
}

export interface ChartEntry {
  rank: number;
  trackId: number;
  name: string | null;
  seller: string | null;
  genre: string | null;
  genreId: number | null;
  releaseDate: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
  artwork: string | null;
}

export function chartUrl(s: ChartSpec): string {
  const feed = CHART_FEEDS[s.chart];
  if (!feed) throw new Error(`Unknown chart ${s.chart}; expected one of ${Object.keys(CHART_FEEDS).join(", ")}`);
  const genre = s.genreId ? `genre=${s.genreId}/` : "";
  return `https://itunes.apple.com/${encodeURIComponent(s.country)}/rss/${feed}/limit=100/${genre}json`;
}

export function chartSpecs(countries: string[], charts: string[], genreIds: number[]): ChartSpec[] {
  const out: ChartSpec[] = [];
  for (const country of countries) for (const genreId of genreIds) for (const chart of charts) out.push({ country, chart, genreId });
  return out;
}

const label = (v: unknown): string | null => {
  const l = v && typeof v === "object" ? (v as { label?: unknown }).label : undefined;
  return typeof l === "string" ? l : null;
};
const attrs = (v: unknown): Record<string, unknown> => {
  const a = v && typeof v === "object" ? (v as { attributes?: unknown }).attributes : undefined;
  return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
};
const posInt = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The feed's "-07:00" offsets as UTC ISO strings, like Lookup's dates. */
function isoUtc(s: string | null): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(".000Z", "Z");
}

/**
 * Parses a chart feed body. Returns null when the body isn't a chart feed at all (the
 * caller treats that as a failed fetch). A feed with no `entry` is an empty chart.
 */
export function parseChartFeed(body: unknown): ChartEntry[] | null {
  const feed = body && typeof body === "object" ? (body as { feed?: unknown }).feed : undefined;
  if (!feed || typeof feed !== "object") return null;
  const raw = (feed as { entry?: unknown }).entry;
  // One entry comes as an object, not a one-element array.
  const list: unknown[] = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: ChartEntry[] = [];
  const seen = new Set<number>();
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const trackId = posInt(attrs(o.id)["im:id"]);
    if (trackId === null || seen.has(trackId)) continue;
    seen.add(trackId);
    const cat = attrs(o.category);
    const price = attrs(o["im:price"]);
    const images = Array.isArray(o["im:image"]) ? (o["im:image"] as unknown[]) : [];
    const amount = typeof price.amount === "string" ? Number(price.amount) : NaN;
    const link = Array.isArray(o.link) ? o.link[0] : o.link;
    const href = attrs(link).href;
    out.push({
      rank: out.length + 1,
      trackId,
      name: label(o["im:name"]),
      seller: label(o["im:artist"]),
      genre: typeof cat.label === "string" ? cat.label : null,
      genreId: posInt(cat["im:id"]),
      releaseDate: isoUtc(label(o["im:releaseDate"])),
      price: Number.isFinite(amount) ? amount : null,
      currency: typeof price.currency === "string" ? price.currency : null,
      url: typeof href === "string" ? href : label(o.id),
      artwork: images.length ? label(images[images.length - 1]) : null,
    });
  }
  return out;
}

/** The genre name a chart is about: "All apps" for 0, else the label most entries carry. */
export function chartGenreName(genreId: number, entries: ChartEntry[]): string | null {
  if (genreId === 0) return "All apps";
  const counts = new Map<string, number>();
  for (const e of entries) if (e.genreId === genreId && e.genre) counts.set(e.genre, (counts.get(e.genre) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
