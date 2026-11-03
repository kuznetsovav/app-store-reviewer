export const DAY_MS = 86_400_000;

export interface SizeTrial {
  size: number;
  trial: number;
  status: number;
  resultCount: number;
  /** Known-valid IDs put into this batch (the rest are fillers that should return nothing). */
  validIncluded: number;
  validReturned: number;
  ms: number;
  urlLength: number;
}

/**
 * Largest batch size where every trial returned 200 and every valid ID came back,
 * with all smaller sizes also passing. Null if even the smallest failed.
 */
export function chooseBatchSize(trials: SizeTrial[]): number | null {
  const sizes = [...new Set(trials.map((t) => t.size))].sort((a, b) => a - b);
  let best: number | null = null;
  for (const size of sizes) {
    const ts = trials.filter((t) => t.size === size);
    const ok = ts.length > 0 && ts.every((t) => t.status === 200 && t.validReturned === t.validIncluded);
    if (!ok) break;
    best = size;
  }
  return best;
}

export function hitsPer1000(hits: number, idsScanned: number): number {
  return idsScanned === 0 ? 0 : (hits / idsScanned) * 1000;
}

/**
 * Least-squares slope of ID against time, in IDs per day.
 * Points are (region centre ID, earliest releaseDate in region) — the lower envelope.
 */
export function fitIdsPerDay(points: { id: number; t: number }[]): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanT = points.reduce((s, p) => s + p.t, 0) / n;
  const meanId = points.reduce((s, p) => s + p.id, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - meanT) * (p.id - meanId);
    den += (p.t - meanT) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * DAY_MS;
}

/**
 * IDs minted per day from the median release time of recently released items.
 * The lower envelope (earliest release per region) fails in practice: re-released music
 * keeps its original release date (1992, 2011, ...). Recent releases track minting closely.
 * Items are bucketed by ID; each bucket with enough recent items gives (centre, median time).
 */
export function medianIdsPerDay(
  items: { id: number; t: number }[],
  now: number,
  { bucketSize = 250_000, minPerBucket = 20, windowDays = 30 } = {},
): { idsPerDay: number | null; buckets: { centreId: number; median: string; n: number }[] } {
  const groups = new Map<number, number[]>();
  for (const it of items) {
    if (!(it.t <= now && now - it.t < windowDays * DAY_MS)) continue;
    const b = Math.floor(it.id / bucketSize) * bucketSize;
    const g = groups.get(b) ?? [];
    g.push(it.t);
    groups.set(b, g);
  }
  const buckets = [...groups.entries()]
    .filter(([, ts]) => ts.length >= minPerBucket)
    .sort((a, b) => a[0] - b[0])
    .map(([b, ts]) => {
      ts.sort((x, y) => x - y);
      return { id: b + bucketSize / 2, t: ts[Math.floor(ts.length / 2)]!, n: ts.length };
    });
  return {
    idsPerDay: fitIdsPerDay(buckets),
    buckets: buckets.map((b) => ({ centreId: b.id, median: new Date(b.t).toISOString(), n: b.n })),
  };
}

export interface PrecisionReport {
  values: number;
  distinctTimes: Record<string, number>;
  /** True when every value has the same time-of-day, i.e. only the date carries information. */
  dayLevel: boolean;
}

/** Counts the time-of-day part of ISO timestamps like 2026-11-02T07:00:00Z. */
export function datePrecision(values: string[]): PrecisionReport {
  const distinctTimes: Record<string, number> = {};
  for (const v of values) {
    const time = v.includes("T") ? v.slice(v.indexOf("T") + 1) : "(none)";
    distinctTimes[time] = (distinctTimes[time] ?? 0) + 1;
  }
  return { values: values.length, distinctTimes, dayLevel: values.length > 0 && Object.keys(distinctTimes).length === 1 };
}

export interface CapacityInput {
  ratePerMin: number;
  hours: number;
  batchSize: number;
  idsPerDay: number;
  storefronts: number;
}

export function capacity(c: CapacityInput) {
  const calls = Math.floor(c.ratePerMin * 60 * c.hours);
  const idsCoveredPerStorefront = Math.floor((calls * c.batchSize) / c.storefronts);
  const daysOfLookback = idsCoveredPerStorefront / c.idsPerDay;
  return { ...c, calls, idsCoveredPerStorefront, daysOfLookback: Math.round(daysOfLookback * 10) / 10 };
}

/** Small seeded PRNG so batch-size trials are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}
