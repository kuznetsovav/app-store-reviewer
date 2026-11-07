/**
 * Themes: rough "what kind of apps are these" tags matched on app names only.
 * Descriptions are left out on purpose: almost every one mentions privacy, tracking
 * or AI somewhere, which would drown the signal. An app can match several themes.
 */

export interface Theme {
  id: string;
  label: string;
  /** The app matches when any pattern matches its name. */
  patterns: RegExp[];
}

export const THEMES: readonly Theme[] = [
  { id: "puzzle", label: "Puzzle & casual games", patterns: [/\b(puzzles?|sudoku|mahjong|solitaire|jigsaw|crosswords?|nonograms?|match-?3|merge|tiles?|word games?)\b/i] },
  // Case-sensitive so "Ai" (a name) and "said" don't count; agents/chatbots in any case.
  { id: "ai", label: "AI features", patterns: [/(?<![\p{L}\p{N}])(AI|GPT|LLM)(?![\p{L}\p{N}])/u, /\b(agents?|chatbots?|copilot)\b/i] },
  { id: "tracker", label: "Trackers, logs & counters", patterns: [/track/i, /\b(log|logs|logbook|counter|tally|habits?|streaks?)\b/i] },
  { id: "journal", label: "Journals, notes & diaries", patterns: [/\b(journal(ing)?|diary|diaries|notes?|notebook|memos?|memories)\b/i] },
  { id: "business", label: "Business operations", patterns: [/\b(erp|crm|inventory|attendance|payroll|invoices?|pos|fleet|admin|merchant|staff|scheduling|booking|appointments?|dispatch)\b/i] },
  { id: "scanner", label: "Scanners & PDF", patterns: [/scan/i, /\b(pdf|ocr|receipts?)\b/i] },
  { id: "remote", label: "Remotes, TV & media players", patterns: [/\b(remote|iptv|tv|cast|player|homekit|smart home|wake-on-lan)\b/i] },
  { id: "learning", label: "Language learning & exam prep", patterns: [/\b(learn\w*|languages?|vocab\w*|flashcards?|lessons?|tutor|exams?|ielts|toefl|citizenship|practice tests?|quiz\w*)\b/i] },
  { id: "photo", label: "Photo & video", patterns: [/\b(photos?|video|camera|editor|collage|filters?)\b/i] },
  { id: "faith", label: "Faith & religion", patterns: [/\b(bible|church|quran|qibla|prayers?|pray|adhkar|dzikir|gospel|ministr(y|ies)|devotional|psalms?|sermons?)\b/i] },
  { id: "fitness", label: "Fitness & workouts", patterns: [/\b(fitness|fit|workouts?|gym|wod|reps|pull-?ups?|squats?|cardio|yoga|pilates|running|steps)\b/i] },
  { id: "health", label: "Diet, medication & body tracking", patterns: [/\b(calories?|diet|meals?|nutrition|protein|fasting|glp-?1|dose|medications?|pills?|symptoms?|blood pressure|glucose|period)\b/i] },
  { id: "mind", label: "Mood, sleep & focus", patterns: [/\b(mood|sleep|meditat\w*|breath\w*|calm|mindful\w*|anxiety|stress|focus|relax\w*|stoic\w*)\b/i] },
  { id: "food", label: "Food & ordering", patterns: [/\b(food|restaurants?|recipes?|cafe|coffee|pizza|orders?|ordering|menu|kitchen|bakery)\b/i] },
  { id: "travel", label: "Travel & maps", patterns: [/\b(travel|trips?|flights?|hotels?|maps?|tours?|gps|navigation)\b/i] },
  { id: "car", label: "Cars, bikes & EVs", patterns: [/\b(car|cars|ev|tesla|garage|moto\w*|bikes?|cycling|driver|parking)\b/i] },
  { id: "privacy", label: "Private, offline & security", patterns: [/\b(private|privacy|offline|encrypted|on-device|vpn|passwords?)\b/i] },
  { id: "voice", label: "Voice, dictation & translation", patterns: [/translat|transcri|dictat/i, /\b(voice|speech|subtitles?)\b/i] },
  { id: "kids", label: "Kids & family", patterns: [/\b(kids?|baby|toddlers?|parent\w*|family|families|child\w*)\b/i] },
  { id: "pets", label: "Pets", patterns: [/\b(pets?|dogs?|cats?|pupp(y|ies)|kittens?|paws?)\b/i] },
  { id: "finance", label: "Money & finance", patterns: [/\b(budget\w*|money|expenses?|financ\w*|invest\w*|crypto|bitcoin|wallet|bank\w*|loans?|tax|stocks?|trading)\b/i] },
  { id: "widgets", label: "Widgets & wallpapers", patterns: [/\b(widgets?|wallpapers?|lock screen|icons?)\b/i] },
];

/** Earlier reports need at least this many apps in total before shares are compared. */
export const MIN_BASELINE_APPS = 100;
const EXAMPLES = 3;

export function themesOf(name: string | null): string[] {
  if (!name) return [];
  return THEMES.filter((t) => t.patterns.some((p) => p.test(name))).map((t) => t.id);
}

/** Apps per theme id (only themes with at least one app). */
export function countThemes(names: (string | null)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) for (const id of themesOf(n)) out[id] = (out[id] ?? 0) + 1;
  return out;
}

export interface ThemeRow {
  id: string;
  label: string;
  count: number;
  /** Share of this report's apps, 0..1. */
  share: number;
  /** Share across the earlier reports, or null when they have too few apps to compare. */
  previousShare: number | null;
  examples: string[];
}

export interface ThemeSummary {
  rows: ThemeRow[];
  /** Apps that matched no theme. */
  unmatched: number;
  /** Apps in the earlier reports used for comparison (0 when not compared). */
  baselineApps: number;
  baselineReports: number;
}

export interface ThemeHistory {
  count: number;
  themes?: Record<string, number>;
}

/**
 * Theme counts for this report (examples keep the order of `apps`), compared with the
 * pooled share across the earlier reports that recorded themes (newest 7).
 */
export function summarizeThemes(apps: { name: string | null }[], history: ThemeHistory[] = []): ThemeSummary {
  const n = apps.length;
  const byId = new Map<string, string[]>();
  let unmatched = 0;
  for (const a of apps) {
    const ids = themesOf(a.name);
    if (!ids.length) unmatched++;
    for (const id of ids) {
      const l = byId.get(id) ?? [];
      l.push(a.name!);
      byId.set(id, l);
    }
  }
  const base = history.filter((h) => h.themes).slice(0, 7);
  const baselineApps = base.reduce((s, h) => s + h.count, 0);
  const compare = baselineApps >= MIN_BASELINE_APPS;
  const rows: ThemeRow[] = THEMES.filter((t) => byId.has(t.id)).map((t) => {
    const names = byId.get(t.id)!;
    const prev = base.reduce((s, h) => s + (h.themes![t.id] ?? 0), 0);
    return { id: t.id, label: t.label, count: names.length, share: names.length / n, previousShare: compare ? prev / baselineApps : null, examples: names.slice(0, EXAMPLES) };
  });
  rows.sort((x, y) => y.count - x.count || x.label.localeCompare(y.label, "en"));
  return { rows, unmatched, baselineApps: compare ? baselineApps : 0, baselineReports: compare ? base.length : 0 };
}

export interface MarketStats {
  paid: number;
  /** Median price of paid apps, when they all share one currency. */
  medianPaidPrice: number | null;
  currency: string | null;
  sellers: number;
  singleAppSellers: number;
  /** Apps whose name contains a letter outside the Latin script (CJK, Arabic, Cyrillic, ...). */
  nonLatinNames: number;
}

const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;

export function hasNonLatinLetter(name: string | null): boolean {
  for (const ch of name ?? "") if (LETTER.test(ch) && !LATIN.test(ch)) return true;
  return false;
}

export function marketStats(apps: { price: number | null; currency: string | null; seller_name: string | null; name: string | null }[]): MarketStats {
  const paid = apps.filter((a) => a.price !== null && a.price > 0);
  const currencies = new Set(paid.map((a) => a.currency));
  let medianPaidPrice: number | null = null;
  if (paid.length && currencies.size === 1) {
    const p = paid.map((a) => a.price!).sort((a, b) => a - b);
    const mid = Math.floor(p.length / 2);
    medianPaidPrice = p.length % 2 ? p[mid]! : (p[mid - 1]! + p[mid]!) / 2;
  }
  const perSeller = new Map<string, number>();
  for (const a of apps) if (a.seller_name) perSeller.set(a.seller_name, (perSeller.get(a.seller_name) ?? 0) + 1);
  return {
    paid: paid.length,
    medianPaidPrice,
    currency: medianPaidPrice === null ? null : ([...currencies][0] ?? null),
    sellers: perSeller.size,
    singleAppSellers: [...perSeller.values()].filter((c) => c === 1).length,
    nonLatinNames: apps.filter((a) => hasNonLatinLetter(a.name)).length,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmt = (n: number) => n.toLocaleString("en-US");

export const formatShare = (x: number | null) => (x === null ? "—" : pct(x));

/** "+1.4 pp" / "−0.3 pp" / "0.0 pp", or "—" without a comparison. */
export function formatChange(share: number, previous: number | null): string {
  if (previous === null) return "—";
  const d = (share - previous) * 100;
  const v = Math.abs(d).toFixed(1);
  return v === "0.0" ? "0.0 pp" : `${d > 0 ? "+" : "−"}${v} pp`;
}

/** One sentence: seller concentration, script mix and paid-app pricing. Empty for no apps. */
export function marketLine(m: MarketStats, total: number): string {
  if (!total) return "";
  const parts = [`${fmt(m.singleAppSellers)} of ${fmt(m.sellers)} sellers released a single app`, `${pct(m.nonLatinNames / total)} of names use a non-Latin script`];
  if (m.medianPaidPrice !== null) parts.push(`median paid price ${m.medianPaidPrice.toFixed(2)} ${m.currency ?? ""}`.trim());
  return parts.join(" · ") + ".";
}

/** The note under the themes table: how matching works and what the comparison is against. */
export function themesNote(s: ThemeSummary, total: number): string {
  const base = s.baselineApps
    ? `"Earlier" is the pooled share across the previous ${s.baselineReports} report${s.baselineReports === 1 ? "" : "s"} (${fmt(s.baselineApps)} apps).`
    : `No comparison yet: earlier reports need at least ${MIN_BASELINE_APPS} apps in total.`;
  return `Matched on app names only; an app can count in several themes. ${fmt(s.unmatched)} of ${fmt(total)} apps (${pct(total ? s.unmatched / total : 0)}) matched no theme. ${base}`;
}
