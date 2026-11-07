/**
 * Themes say what kind of app it is; signals say how it pitches itself.
 *
 * Themes match the name, or the first DESCRIPTION_LEAD characters of the description with
 * stricter phrase patterns: short words like "track", "log" or "photos" mostly name a
 * feature there ("no tracking", "Log ind", "add photos"), not what the app is.
 * Signals match whole descriptions with phrases specific enough to survive boilerplate.
 * An app can match several tags of each kind.
 */

export interface Tag {
  id: string;
  label: string;
  /** Matched against the app name. */
  name?: RegExp[];
  /** Matched against the description lead. */
  lead?: RegExp[];
  /** Matched against the whole description. */
  full?: RegExp[];
}

/** "AI" as a capitalised word: not "Ai" (a name), "said" or "AIRPORT". */
const AI_WORD = /(?<![\p{L}\p{N}])(AI|GPT|LLMs?)(?![\p{L}\p{N}])/u;

export const THEMES: readonly Tag[] = [
  {
    id: "puzzle",
    label: "Puzzle & casual games",
    name: [/\b(puzzles?|sudoku|mahjong|solitaire|jigsaw|crosswords?|nonograms?|match-?3|merge|tiles?|word games?)\b/i],
    lead: [/\b(puzzle (game|adventure)s?|puzzles|sudoku|mahjong|solitaire|jigsaw|crosswords?|nonograms?|match-3|merge game|word (game|puzzle)s?|brain teasers?|logic (game|puzzle)s?)\b/i],
  },
  {
    id: "ai",
    label: "AI features",
    name: [AI_WORD, /\b(agents?|chatbots?|copilot)\b/i],
    lead: [AI_WORD, /\b(artificial intelligence|ChatGPT|machine learning|Apple Intelligence|AI agents?|chatbots?)\b/i],
  },
  {
    id: "tracker",
    label: "Trackers, logs & counters",
    name: [/track/i, /\b(log|logs|logbook|counter|tally|habits?|streaks?)\b/i],
    lead: [/\b(tracker|habit track\w*|track (your|every|each|daily|how|what|when|all)|log (your|every|each|daily)|logbook|keep track)\b/i],
  },
  {
    id: "journal",
    label: "Journals, notes & diaries",
    name: [/\b(journal(ing)?|diary|diaries|notes?|notebook|memos?|memories)\b/i],
    lead: [/\b(journal(ing)?|diary|note[- ]taking|notes app|take notes|notebook)\b/i],
  },
  {
    id: "business",
    label: "Business operations",
    name: [/\b(erp|crm|inventory|attendance|payroll|invoices?|pos|fleet|admin|merchant|staff|scheduling|booking|appointments?|dispatch)\b/i],
    lead: [/\b(for (small |local )?business(es)?|your (customers|clients|staff|employees|technicians)|inventory|invoic\w+|point of sale|ERP|CRM|field service|work orders?|attendance|payroll|timesheets?|merchants?)\b/i],
  },
  {
    id: "scanner",
    label: "Scanners & PDF",
    name: [/scan/i, /\b(pdf|ocr|receipts?)\b/i],
    lead: [/\b(scanner|scan (documents?|receipts?|pages|text|barcodes?|business cards)|PDFs?|OCR)\b/i],
  },
  {
    id: "remote",
    label: "Remotes, TV & media players",
    name: [/\b(remote|iptv|tv|cast|player|homekit|smart home|wake-on-lan)\b/i],
    lead: [/\b(remote control|IPTV|M3U|smart TV|Apple TV|Chromecast|AirPlay|(media|video|music|audio) player|HomeKit|smart home)\b/i],
  },
  {
    id: "learning",
    label: "Language learning & exam prep",
    name: [/\b(learn\w*|languages?|vocab\w*|flashcards?|lessons?|tutor|exams?|ielts|toefl|citizenship|practice tests?|quiz\w*)\b/i],
    lead: [/\b(language learning|learn (a new |to speak )?(language|English|Spanish|French|German|Italian|Chinese|Japanese|Korean|Arabic)|vocabulary|flashcards?|exam prep|test prep|practice (tests?|questions)|IELTS|TOEFL|citizenship test|driving (theory )?test)\b/i],
  },
  {
    id: "photo",
    label: "Photo & video",
    name: [/\b(photos?|video|camera|editor|collage|filters?)\b/i],
    lead: [/\b((photo|video) editor|edit (your )?(photos|videos)|camera app|collages?|presets|selfies?|photo booth)\b/i],
  },
  {
    id: "faith",
    label: "Faith & religion",
    name: [/\b(bible|church|quran|qibla|prayers?|pray|adhkar|dzikir|gospel|ministr(y|ies)|devotional|psalms?|sermons?)\b/i],
    lead: [/\b(bible|church|quran|qur'an|qibla|prayers?|adhkar|hadith|gospel|scripture|worship|sermons?|devotionals?|Christian|Catholic|Islamic|Muslim)\b/i],
  },
  {
    id: "fitness",
    label: "Fitness & workouts",
    name: [/\b(fitness|fit|workouts?|gym|wod|reps|pull-?ups?|squats?|cardio|yoga|pilates|running|steps)\b/i],
    lead: [/\b(workouts?|fitness|gym|strength training|training plans?|reps|cardio|yoga|pilates|running (app|plans?|coach)|runners|step counter|exercise (routines?|plans?|library))\b/i],
  },
  {
    id: "health",
    label: "Diet, medication & body tracking",
    name: [/\b(calories?|diet|meals?|nutrition|protein|fasting|glp-?1|dose|medications?|pills?|symptoms?|blood pressure|glucose|period)\b/i],
    lead: [/\b(calories|calorie|nutrition|diet|meal plans?|macros|protein|fasting|GLP-1|medications?|blood pressure|blood sugar|glucose|symptoms?|period tracker|menstrual|pregnan\w+)\b/i],
  },
  {
    id: "mind",
    label: "Mood, sleep & focus",
    name: [/\b(mood|sleep|meditat\w*|breath\w*|calm|mindful\w*|anxiety|stress|focus|relax\w*|stoic\w*)\b/i],
    lead: [/\b(meditat\w+|mindfulness|breathing (exercises?|techniques?)|sleep (track\w*|sounds|stories|better|quality)|better sleep|fall asleep|snor\w+|mood (track\w*|journal|log\w*)|anxiety|stress relief|mental health|therapy|CBT|focus timer|pomodoro|stoic\w*)\b/i],
  },
  {
    id: "food",
    label: "Food & ordering",
    name: [/\b(food|restaurants?|recipes?|cafe|coffee|pizza|orders?|ordering|menu|kitchen|bakery)\b/i],
    lead: [/\b(order (food|online|ahead)|restaurants?|recipes?|menu|takeout|take-out|coffee shop|cafe|loyalty (points|rewards|program)|meal prep)\b/i],
  },
  {
    id: "travel",
    label: "Travel & maps",
    name: [/\b(travel|trips?|flights?|hotels?|maps?|tours?|gps|navigation)\b/i],
    lead: [/\b(travel (guide|diary|journal|planner|app|companion|tools?|memories|maps?)|travell?ers|trip planner|plan (your |a )?trips?|itinerar(y|ies)|flight (tracker|status|deals|search)|hotel (booking|deals)|offline maps?|hiking trails?|tourists?)\b/i],
  },
  {
    id: "car",
    label: "Cars, bikes & EVs",
    name: [/\b(car|cars|ev|tesla|garage|moto\w*|bikes?|cycling|driver|parking)\b/i],
    lead: [/\b(your (car|vehicle|EV|Tesla|bike|motorcycle)s?|Tesla|electric vehicles?|EV charging|car (maintenance|wash|rental|dealer)|parking|cycling|motorcycl\w+)\b/i],
  },
  {
    id: "privacy",
    label: "Privacy & security apps",
    name: [/\b(private|privacy|offline|encrypted|on-device|vpn|passwords?)\b/i],
    lead: [/\b(password manager|VPN|encrypted (vault|storage|notes|messag\w+|drive)|end-to-end encrypt\w*|private browser|ad ?blocker|content blocker|block (ads|trackers)|data breach\w*)\b/i],
  },
  {
    id: "voice",
    label: "Voice, dictation & translation",
    name: [/translat|transcri|dictat/i, /\b(voice|speech|subtitles?)\b/i],
    lead: [/\b(translat\w+|transcri\w+|dictat\w+|speech[- ]to[- ]text|text[- ]to[- ]speech|voice (notes?|memos?|recorder|chang\w+)|subtitles?|teleprompter)\b/i],
  },
  {
    id: "kids",
    label: "Kids & family",
    name: [/\b(kids?|baby|toddlers?|parent\w*|family|families|child\w*)\b/i],
    lead: [/\b(kids|children|toddlers?|preschool\w*|bab(y|ies)|parents)\b/i],
  },
  {
    id: "pets",
    label: "Pets",
    name: [/\b(pets?|dogs?|cats?|pupp(y|ies)|kittens?|paws?)\b/i],
    lead: [/\b(your (pet|dog|cat|puppy|kitten)s?|pet (owners?|care|health)|dog owners?|cat owners?|veterinar\w+|virtual pet)\b/i],
  },
  {
    id: "finance",
    label: "Money & finance",
    name: [/\b(budget\w*|money|expenses?|financ\w*|invest\w*|crypto|bitcoin|wallet|bank\w*|loans?|tax|stocks?|trading)\b/i],
    lead: [/\b(budgeting|budget (app|planner|tracker)|monthly budget|expense track\w*|track (your )?(expenses|spending)|personal finance|money manager|investing|investments?|(investment|stock) portfolios?|crypto(currenc(y|ies))?|bitcoin|stock (market|prices)|(stock|crypto|forex|day) trading|savings (goals?|accounts?)|net worth|bank accounts?|loans?|taxes)\b/i],
  },
  {
    id: "widgets",
    label: "Widgets & wallpapers",
    name: [/\b(widgets?|wallpapers?|lock screen|icons?)\b/i],
    lead: [/\b((home|lock) screen widgets?|wallpapers?|icon packs?|app icons|StandBy)\b/i],
  },
];

export const SIGNALS: readonly Tag[] = [
  // "No subscription" is the opposite pitch: it counts under one_time instead.
  {
    id: "subscription",
    label: "Subscription",
    full: [/(?<!\b(no|without|not a|never a|zero|any)[- ])\bsubscriptions?\b/i, /\b(auto[- ]renew\w*|free trial|(weekly|monthly|yearly|annual) (or (weekly|monthly|yearly|annual) )?(plans?|subscriptions?|memberships?))\b/i],
  },
  { id: "ai", label: "AI in the pitch", full: [AI_WORD, /\b(artificial intelligence|ChatGPT|GPT-\d|machine learning|Apple Intelligence|Foundation Models)\b/i] },
  {
    id: "offline",
    label: "Works offline / on-device",
    full: [/\b(works? (fully |completely |entirely )?offline|offline[- ]first|100% offline|no internet (connection )?(needed|required)|on[- ]device|stays on your (device|phone|iPhone)|never leaves? your (device|phone|iPhone)|stored (locally|on your (device|phone|iPhone)))\b/i],
  },
  { id: "widgets", label: "Widgets / Live Activities", full: [/\b(widgets?|Live Activit(y|ies)|Dynamic Island|StandBy|Control Center)\b/i] },
  { id: "icloud", label: "iCloud sync", full: [/\b(iCloud|CloudKit)\b/] },
  { id: "no_account", label: "No account needed", full: [/\b(no (account|sign[- ]?ups?|sign[- ]?ins?|logins?|registration)s?( (needed|required))?|without (an )?(account|signing up|registration)|account[- ]free)\b/i] },
  { id: "no_ads", label: "No ads", full: [/\b(no (ads|advertis\w+)|ad[- ]free|without ads)\b/i] },
  { id: "no_tracking", label: "No tracking / data collection", full: [/\b(no (tracking|trackers|analytics|data collection)|(don't|do not|never|doesn't|does not) (collect|track|sell)|zero data collection)\b/i] },
  { id: "watch", label: "Apple Watch", full: [/\b(Apple Watch|watchOS)\b/i] },
  { id: "siri", label: "Siri & Shortcuts", full: [/\b(Siri|Shortcuts|App Intents|Action button)\b/] },
  { id: "health", label: "Apple Health", full: [/\b(Apple Health|HealthKit|Health app)\b/i] },
  { id: "one_time", label: "One-time purchase / no subscription", full: [/\b(one[- ]time (purchase|payment|unlock)|one payment|lifetime (access|unlock|purchase|license|plan)|pay once|buy once|no subscriptions?|without (a )?subscription)\b/i] },
];

/** Description characters used for themes: the pitch, before features and boilerplate. */
export const DESCRIPTION_LEAD = 300;
/** Earlier reports need at least this many apps in total before shares are compared. */
export const MIN_BASELINE_APPS = 100;
const EXAMPLES = 3;

export interface TaggableApp {
  name: string | null;
  /** null/undefined when unknown (old report, pruned raw JSON). */
  description?: string | null;
}

export const descriptionLead = (d: string | null | undefined, n = DESCRIPTION_LEAD) => (d ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const any = (ps: RegExp[] | undefined, s: string) => !!s && !!ps?.some((p) => p.test(s));

export function tagsOf(catalog: readonly Tag[], app: TaggableApp): string[] {
  const name = app.name ?? "";
  const lead = descriptionLead(app.description);
  const full = app.description ?? "";
  return catalog.filter((t) => any(t.name, name) || any(t.lead, lead) || any(t.full, full)).map((t) => t.id);
}

export const themesOf = (app: TaggableApp) => tagsOf(THEMES, app);
export const signalsOf = (app: TaggableApp) => tagsOf(SIGNALS, app);

/** Apps per tag id (only tags with at least one app). */
export function countTags(catalog: readonly Tag[], apps: TaggableApp[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of apps) for (const id of tagsOf(catalog, a)) out[id] = (out[id] ?? 0) + 1;
  return out;
}

export const hasDescription = (a: TaggableApp) => typeof a.description === "string" && a.description.trim() !== "";

export interface TagRow {
  id: string;
  label: string;
  count: number;
  /** Share of the counted apps, 0..1. */
  share: number;
  /** Share across the earlier reports, or null when they have too few apps to compare. */
  previousShare: number | null;
  examples: string[];
}

export interface TagSummary {
  rows: TagRow[];
  /** Apps counted (for signals: apps with a description). */
  total: number;
  /** Counted apps that matched no tag. */
  unmatched: number;
  /** Apps in the earlier reports used for comparison (0 when not compared). */
  baselineApps: number;
  baselineReports: number;
}

/** One earlier report as readHistory sees it. Counts are absent in reports written before they existed. */
export interface TagHistory {
  count: number;
  /** Apps with a description; themes/signals were counted with descriptions when > 0. */
  described?: number;
  themes?: Record<string, number>;
  signals?: Record<string, number>;
}

/**
 * Tag counts for `apps` (examples keep their order), compared with the pooled share across
 * the newest 7 earlier reports counted the same way. Themes compare only with reports that
 * had descriptions iff this one has them, so the change in method isn't read as a trend.
 */
function summarize(catalog: readonly Tag[], apps: TaggableApp[], baseline: { total: number; counts: Record<string, number> }[]): TagSummary {
  const byId = new Map<string, string[]>();
  let unmatched = 0;
  for (const a of apps) {
    const ids = tagsOf(catalog, a);
    if (!ids.length) unmatched++;
    for (const id of ids) {
      const l = byId.get(id) ?? [];
      l.push(a.name ?? "—");
      byId.set(id, l);
    }
  }
  const base = baseline.slice(0, 7);
  const baselineApps = base.reduce((s, h) => s + h.total, 0);
  const compare = baselineApps >= MIN_BASELINE_APPS;
  const n = apps.length;
  const rows: TagRow[] = catalog
    .filter((t) => byId.has(t.id))
    .map((t) => {
      const names = byId.get(t.id)!;
      const prev = base.reduce((s, h) => s + (h.counts[t.id] ?? 0), 0);
      return { id: t.id, label: t.label, count: names.length, share: names.length / n, previousShare: compare ? prev / baselineApps : null, examples: names.slice(0, EXAMPLES) };
    });
  rows.sort((x, y) => y.count - x.count || x.label.localeCompare(y.label, "en"));
  return { rows, total: n, unmatched, baselineApps: compare ? baselineApps : 0, baselineReports: compare ? base.length : 0 };
}

export function summarizeThemes(apps: TaggableApp[], history: TagHistory[] = []): TagSummary {
  const described = apps.some(hasDescription);
  const base = history.filter((h) => h.themes && (h.described ?? 0) > 0 === described).map((h) => ({ total: h.count, counts: h.themes! }));
  return summarize(THEMES, apps, base);
}

/** Signals count only apps with a description. */
export function summarizeSignals(apps: TaggableApp[], history: TagHistory[] = []): TagSummary {
  const base = history.filter((h) => h.signals && (h.described ?? 0) > 0).map((h) => ({ total: h.described!, counts: h.signals! }));
  return summarize(SIGNALS, apps.filter(hasDescription), base);
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

function baselineText(s: TagSummary): string {
  return s.baselineApps
    ? `"Earlier" is the pooled share across the previous ${s.baselineReports} comparable report${s.baselineReports === 1 ? "" : "s"} (${fmt(s.baselineApps)} apps).`
    : `No comparison yet: comparable earlier reports need at least ${MIN_BASELINE_APPS} apps in total.`;
}

/** The note under the themes table: how matching works and what the comparison is against. */
export function themesNote(s: TagSummary, described: boolean): string {
  const how = described
    ? `Matched on the app name and the first ${DESCRIPTION_LEAD} characters of the description`
    : "Matched on app names only (no descriptions available)";
  return `${how}; an app can count in several themes. ${fmt(s.unmatched)} of ${fmt(s.total)} apps (${pct(s.total ? s.unmatched / s.total : 0)}) matched no theme. ${baselineText(s)}`;
}

/** The note under the signals table. */
export function signalsNote(s: TagSummary, total: number): string {
  const scope = s.total === total ? `all ${fmt(total)} apps` : `${fmt(s.total)} of ${fmt(total)} apps (the rest have no description stored)`;
  return `Phrases in the full description of ${scope}; an app can show several signals. ${baselineText(s)}`;
}
