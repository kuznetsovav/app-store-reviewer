import { trendsConfig, type Config } from "../config.js";
import type { Db } from "../db/index.js";
import { addDays, latestTrendRun, type TrendRunRow } from "./collect.js";

const DAY_MS = 86_400_000;
/** "Not in the top 100" ranks as 101, so entering at #100 is a gain of 1. */
const OFF_CHART = 101;
/** Growth is rating gain / max(base, this), so tiny bases don't make every app look viral. */
export const GROWTH_FLOOR = 100;
export const WINDOWS = [7, 30] as const;

export interface AppInfo {
  trackId: number;
  name: string | null;
  seller: string | null;
  genre: string | null;
  releaseDate: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
  artwork: string | null;
}

export interface Position {
  chart: string;
  genreId: number;
  genreName: string | null;
  rank: number;
}

export interface Breakout {
  app: AppInfo;
  ageDays: number;
  best: Position;
  charts: number;
  ratings: number | null;
}

export interface Climber {
  app: AppInfo;
  move: Position & { prev: number | null; gain: number };
  /** In this many charts today. */
  charts: number;
}

export interface RatingGrowth {
  app: AppInfo;
  base: number;
  now: number;
  delta: number;
  growth: number;
  avg: number | null;
  best: Position | null;
}

export interface FastStarter {
  app: AppInfo;
  ageDays: number;
  ratings: number;
  perDay: number;
  avg: number | null;
  best: Position | null;
}

export interface Windowed<T> {
  days: number;
  /** The snapshot compared against: the latest at least `days` old, else the oldest there is. */
  baseDate: string | null;
  /** True when no snapshot is `days` old yet, so the comparison spans fewer days. */
  partial: boolean;
  rows: T[];
}

export interface TrendsCoverage {
  chartDays: number;
  firstChartDate: string | null;
  ratingDays: number;
  firstRatingDate: string | null;
  chartsToday: number;
  appsCharting: number;
  appsRated: number;
  run: TrendRunRow | null;
}

export interface TrendsReport {
  date: string;
  country: string;
  coverage: TrendsCoverage;
  breakouts: Breakout[];
  climbers: Windowed<Climber>[];
  ratings: Windowed<RatingGrowth>[];
  fastStarters: FastStarter[];
}

interface EntryRow {
  chart: string;
  genre_id: number;
  genre_name: string | null;
  rank: number;
  track_id: number;
}

const key = (e: { chart: string; genre_id: number }) => `${e.chart}/${e.genre_id}`;

/** Overall charts beat genre charts; then the better rank. */
export function betterPosition(a: Position, b: Position): Position {
  if ((a.genreId === 0) !== (b.genreId === 0)) return a.genreId === 0 ? a : b;
  return b.rank < a.rank ? b : a;
}

function toPos(e: EntryRow): Position {
  return { chart: e.chart, genreId: e.genre_id, genreName: e.genre_name, rank: e.rank };
}

function chartEntries(db: Db, date: string, country: string): EntryRow[] {
  return db
    .prepare(
      `SELECT ce.chart, ce.genre_id, cs.genre_name, ce.rank, ce.track_id
       FROM chart_entries ce JOIN chart_snapshots cs USING (snap_date, country, chart, genre_id)
       WHERE ce.snap_date = ? AND ce.country = ?`,
    )
    .all(date, country) as EntryRow[];
}

function snapDates(db: Db, table: "chart_snapshots" | "rating_snapshots", country: string, upTo: string): string[] {
  return db.prepare(`SELECT DISTINCT snap_date FROM ${table} WHERE country = ? AND snap_date <= ? ORDER BY snap_date`).pluck().all(country, upTo) as string[];
}

/** The latest date at least `days` before `date`, else the oldest earlier one. */
export function baseDate(dates: string[], date: string, days: number): { baseDate: string | null; partial: boolean } {
  const target = addDays(date, -days);
  const full = dates.filter((d) => d <= target).at(-1);
  if (full) return { baseDate: full, partial: false };
  const earlier = dates.find((d) => d < date);
  return { baseDate: earlier ?? null, partial: earlier !== undefined };
}

/** Whole days from release to the end of `date` (UTC). Null when the date is unknown. */
export function ageDays(releaseDate: string | null, date: string): number | null {
  const ms = releaseDate ? Date.parse(releaseDate) : NaN;
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.parse(`${date}T23:59:59Z`) - ms) / DAY_MS));
}

function appInfo(db: Db): (id: number) => AppInfo {
  const stmt = db.prepare("SELECT * FROM apps WHERE track_id = ?");
  const cache = new Map<number, AppInfo>();
  return (id) => {
    let a = cache.get(id);
    if (!a) {
      const r = stmt.get(id) as Record<string, unknown> | undefined;
      const s = (k: string) => (typeof r?.[k] === "string" ? (r[k] as string) : null);
      a = {
        trackId: id,
        name: s("name"),
        seller: s("seller"),
        genre: s("genre"),
        releaseDate: s("release_date"),
        price: typeof r?.price === "number" ? r.price : null,
        currency: s("currency"),
        url: s("url"),
        artwork: s("artwork"),
      };
      cache.set(id, a);
    }
    return a;
  };
}

function ratingsOn(db: Db, date: string, country: string): Map<number, { count: number | null; avg: number | null }> {
  const rows = db.prepare("SELECT track_id, rating_count, avg_rating FROM rating_snapshots WHERE snap_date = ? AND country = ?").all(date, country) as {
    track_id: number;
    rating_count: number | null;
    avg_rating: number | null;
  }[];
  return new Map(rows.map((r) => [r.track_id, { count: r.rating_count, avg: r.avg_rating }]));
}

/** Everything the viral report shows for `date`, from the trends DB only (no API calls). */
export function loadTrendsReport(db: Db, cfg: Config, date: string): TrendsReport {
  const tc = trendsConfig(cfg);
  const country = tc.countries[0]!;
  const info = appInfo(db);
  const today = chartEntries(db, date, country);

  const bestByApp = new Map<number, { best: Position; charts: number }>();
  for (const e of today) {
    const cur = bestByApp.get(e.track_id);
    bestByApp.set(e.track_id, cur ? { best: betterPosition(cur.best, toPos(e)), charts: cur.charts + 1 } : { best: toPos(e), charts: 1 });
  }
  const ratingsToday = ratingsOn(db, date, country);

  // Breakouts: released recently and already in a chart. Needs no history.
  const breakouts: Breakout[] = [];
  for (const [id, b] of bestByApp) {
    const app = info(id);
    const age = ageDays(app.releaseDate, date);
    if (age === null || age > tc.newAppMaxAgeDays) continue;
    breakouts.push({ app, ageDays: age, best: b.best, charts: b.charts, ratings: ratingsToday.get(id)?.count ?? null });
  }
  breakouts.sort(
    (x, y) => Number(y.best.genreId === 0) - Number(x.best.genreId === 0) || x.best.rank - y.best.rank || y.charts - x.charts || x.app.trackId - y.app.trackId,
  );

  // Climbers: rank now vs. the base snapshot, only in charts both snapshots have.
  const chartDates = snapDates(db, "chart_snapshots", country, date);
  const climbers = WINDOWS.map((days): Windowed<Climber> => {
    const { baseDate: base, partial } = baseDate(chartDates, date, days);
    if (!base) return { days, baseDate: null, partial: false, rows: [] };
    const baseCharts = new Set(
      (db.prepare("SELECT chart, genre_id FROM chart_snapshots WHERE snap_date = ? AND country = ?").all(base, country) as { chart: string; genre_id: number }[]).map(key),
    );
    const prev = new Map<string, number>();
    for (const e of chartEntries(db, base, country)) prev.set(`${key(e)}/${e.track_id}`, e.rank);
    const best = new Map<number, Climber["move"]>();
    for (const e of today) {
      if (!baseCharts.has(key(e))) continue;
      const p = prev.get(`${key(e)}/${e.track_id}`) ?? null;
      const move = { ...toPos(e), prev: p, gain: (p ?? OFF_CHART) - e.rank };
      if (move.gain < (p === null ? 1 : tc.minRankGain)) continue;
      const cur = best.get(e.track_id);
      if (!cur || move.gain > cur.gain || (move.gain === cur.gain && betterPosition(cur, move) === move)) best.set(e.track_id, move);
    }
    const rows = [...best]
      .map(([id, move]) => ({ app: info(id), move, charts: bestByApp.get(id)?.charts ?? 0 }))
      .sort((x, y) => y.move.gain - x.move.gain || Number(y.move.genreId === 0) - Number(x.move.genreId === 0) || x.move.rank - y.move.rank || x.app.trackId - y.app.trackId)
      .slice(0, tc.topN);
    return { days, baseDate: base, partial, rows };
  });

  // Rating growth: gain relative to the base count, floored so small apps need real numbers.
  const ratingDates = snapDates(db, "rating_snapshots", country, date);
  const ratings = WINDOWS.map((days): Windowed<RatingGrowth> => {
    const { baseDate: base, partial } = baseDate(ratingDates, date, days);
    if (!base) return { days, baseDate: null, partial: false, rows: [] };
    const then = ratingsOn(db, base, country);
    const rows: RatingGrowth[] = [];
    for (const [id, r] of ratingsToday) {
      if (r.count === null) continue;
      const app = info(id);
      let b = then.get(id)?.count ?? null;
      // Not tracked (or not out) on the base day: only an app released since then surely had 0.
      if (b === null) {
        const rel = app.releaseDate ? Date.parse(app.releaseDate) : NaN;
        if (Number.isNaN(rel) || rel < Date.parse(`${base}T00:00:00Z`)) continue;
        b = 0;
      }
      const delta = r.count - b;
      if (delta < tc.minRatings) continue;
      rows.push({ app, base: b, now: r.count, delta, growth: delta / Math.max(b, GROWTH_FLOOR), avg: r.avg, best: bestByApp.get(id)?.best ?? null });
    }
    rows.sort((x, y) => y.growth - x.growth || y.delta - x.delta || x.app.trackId - y.app.trackId);
    return { days, baseDate: base, partial, rows: rows.slice(0, tc.topN) };
  });

  // Fast starters: ratings per day since release. Needs no history.
  const fastStarters: FastStarter[] = [];
  for (const [id, r] of ratingsToday) {
    if (r.count === null || r.count < tc.minRatings) continue;
    const app = info(id);
    const age = ageDays(app.releaseDate, date);
    if (age === null || age > tc.newAppMaxAgeDays) continue;
    fastStarters.push({ app, ageDays: age, ratings: r.count, perDay: r.count / Math.max(age, 1), avg: r.avg, best: bestByApp.get(id)?.best ?? null });
  }
  fastStarters.sort((x, y) => y.perDay - x.perDay || x.app.trackId - y.app.trackId);

  const chartsToday = db.prepare("SELECT COUNT(*) FROM chart_snapshots WHERE snap_date = ? AND country = ?").pluck().get(date, country) as number;
  return {
    date,
    country,
    coverage: {
      chartDays: chartDates.length,
      firstChartDate: chartDates[0] ?? null,
      ratingDays: ratingDates.length,
      firstRatingDate: ratingDates[0] ?? null,
      chartsToday,
      appsCharting: bestByApp.size,
      appsRated: [...ratingsToday.values()].filter((r) => r.count !== null).length,
      run: latestTrendRun(db, date) ?? null,
    },
    breakouts: breakouts.slice(0, tc.topN),
    climbers,
    ratings,
    fastStarters: fastStarters.slice(0, tc.topN),
  };
}

/** The newest date with a chart snapshot, for `trends-report` without --date. */
export function latestSnapDate(db: Db): string | null {
  return (db.prepare("SELECT MAX(snap_date) FROM chart_snapshots").pluck().get() as string | null) ?? null;
}
