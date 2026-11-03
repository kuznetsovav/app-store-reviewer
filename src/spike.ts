import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { BudgetExceededError, LookupClient, RequestFailedError, type LookupResult } from "./lookup/client.js";
import {
  DAY_MS,
  capacity,
  chooseBatchSize,
  datePrecision,
  fitIdsPerDay,
  hitsPer1000,
  medianIdsPerDay,
  mulberry32,
  range,
  shuffle,
  type SizeTrial,
} from "./spike-math.js";

const OUT_DIR = "data/spike";
const RAW_DIR = join(OUT_DIR, "raw");
const LOOKUP_BUDGET = 300;
const RSS_BASE = "https://rss.marketingtools.apple.com/api/v2";
const CHART_COUNTRIES = ["us", "gb", "ca", "au", "de", "fr", "jp", "br"];
const FEEDS = ["top-free", "top-paid"];
const SIZES = [50, 100, 200, 300, 500, 1000];
const DISTANCES = [0, 200_000, 1_000_000, 3_000_000];
const MAX_VALIDATION_CALLS = 24;
const MAX_UP_PROBES = 25;
const MAX_BISECT_CALLS = 24;

interface Hit {
  id: number;
  kind?: string;
  name?: string;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
  step: string;
}

interface Probe {
  start: number;
  end: number;
  hits: number;
  maxId: number | null;
  status: number;
  tag: string;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

function toHit(x: LookupResult, step: string): Hit {
  return {
    id: x.trackId!,
    kind: x.kind,
    name: x.trackName,
    releaseDate: x.releaseDate,
    currentVersionReleaseDate: x.currentVersionReleaseDate,
    step,
  };
}

const trackIds = (rs: LookupResult[]) => rs.map((r) => r.trackId).filter((n): n is number => typeof n === "number");
const median = <T>(xs: T[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : undefined);

export async function runSpike(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const seedArg = argValue(args, "--seed");
  mkdirSync(RAW_DIR, { recursive: true });

  const statusCounts: Record<string, number> = {};
  const callsPath = join(OUT_DIR, "calls.jsonl");
  const client = new LookupClient(cfg, {
    maxLookupCalls: LOOKUP_BUDGET,
    log: (line) => {
      statusCounts[`${line.kind}:${line.status}`] = (statusCounts[`${line.kind}:${line.status}`] ?? 0) + 1;
      const s = JSON.stringify(line);
      console.log(s);
      appendFileSync(callsPath, s + "\n");
    },
  });

  const now = Date.now();
  const out: Record<string, unknown> = {
    startedAt: new Date(now).toISOString(),
    rateLimitPerMin: cfg.rateLimitPerMin,
    lookupBudget: LOOKUP_BUDGET,
  };
  const save = () => writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify(out, null, 2) + "\n");
  const seen = new Map<number, Hit>();
  const rand = mulberry32(20261103);
  let rawSeq = 0;
  let consecutiveFailures = 0;

  /** Every Lookup in the spike goes through here: logs, saves raw, tracks failures. */
  async function look(ids: number[], country: string, step: string) {
    try {
      const r = await client.lookup(ids, country);
      consecutiveFailures = 0;
      const file = `${String(++rawSeq).padStart(3, "0")}-${step}-${country}.json`;
      writeFileSync(
        join(RAW_DIR, file),
        JSON.stringify({ first: ids[0], last: ids.at(-1), count: ids.length, country, status: r.status, body: r.raw }),
      );
      if (country === "us") {
        for (const x of r.results) if (typeof x.trackId === "number" && !seen.has(x.trackId)) seen.set(x.trackId, toHit(x, step));
      }
      return r;
    } catch (e) {
      if (e instanceof RequestFailedError) {
        consecutiveFailures++;
        console.error(`batch failed (${e.message}); consecutive failures: ${consecutiveFailures}`);
        if (consecutiveFailures >= cfg.maxConsecutiveFailures) throw e;
        return null;
      }
      throw e;
    }
  }

  try {
    // ── 1. Seed from public top charts ──────────────────────────────────────
    console.error("\n# 1. Seed");
    const chartApps = new Map<number, { name: string; releaseDate: string; country: string }>();
    const usChartIds: number[] = [];
    const charts: { country: string; feed: string; status: number; count: number }[] = [];
    for (const country of CHART_COUNTRIES) {
      for (const feed of FEEDS) {
        const r = await client.getJson(`${RSS_BASE}/${country}/apps/${feed}/100/apps.json`);
        const results = ((r.body as { feed?: { results?: { id: string; name: string; releaseDate: string }[] } })?.feed?.results ?? []);
        for (const x of results) {
          const id = Number(x.id);
          if (!Number.isFinite(id)) continue;
          if (country === "us") usChartIds.push(id);
          if (!chartApps.has(id)) chartApps.set(id, { name: x.name, releaseDate: x.releaseDate, country });
        }
        charts.push({ country, feed, status: r.status, count: results.length });
      }
    }
    const allChartIds = [...chartApps.keys()];
    const seedFromUsCharts = usChartIds.length ? Math.max(...usChartIds) : null;
    const seed = seedArg ? Number(seedArg) : seedFromUsCharts;
    if (!seed || !Number.isFinite(seed)) throw new Error("No seed found in charts; pass --seed <id>");
    const newest = [...chartApps.entries()].sort((a, b) => b[0] - a[0]).slice(0, 5).map(([id, v]) => ({ id, ...v }));
    out.seed = {
      charts,
      uniqueChartIds: allChartIds.length,
      seedFromUsCharts,
      maxAcrossAllCharts: Math.max(...allChartIds),
      seed,
      seedOverridden: Boolean(seedArg),
      newestChartApps: newest,
    };
    save();

    // ── 2. Max IDs per call ─────────────────────────────────────────────────
    console.error("\n# 2. Max IDs per call");
    const candidates = shuffle(allChartIds, rand);
    const valid: number[] = [];
    let checked = 0;
    for (let i = 0, calls = 0; i < candidates.length && calls < MAX_VALIDATION_CALLS; i += 50, calls++) {
      const chunk = candidates.slice(i, i + 50);
      const r = await look(chunk, "us", "validate");
      checked += chunk.length;
      if (r?.status === 200) {
        const got = new Set(trackIds(r.results));
        for (const id of chunk) if (got.has(id)) valid.push(id);
      }
    }
    const trials: SizeTrial[] = [];
    // Fillers sit far above the frontier, so they should never return anything.
    const fillerBase = seed + 400_000_000;
    let fillerNext = 0;
    sizes: for (const size of SIZES) {
      for (let trial = 0; trial < 2; trial++) {
        const pool = shuffle(valid, rand);
        const included = pool.slice(0, Math.min(size, pool.length));
        const fillers = range(fillerBase + fillerNext, size - included.length);
        fillerNext += fillers.length;
        const ids = shuffle([...included, ...fillers], rand);
        const r = await look(ids, "us", `size${size}`);
        const got = new Set(trackIds(r?.results ?? []));
        trials.push({
          size,
          trial,
          status: r?.status ?? -1,
          resultCount: r?.resultCount ?? 0,
          validIncluded: included.length,
          validReturned: included.filter((id) => got.has(id)).length,
          ms: r?.ms ?? 0,
          urlLength: `https://itunes.apple.com/lookup?id=${ids.join(",")}&country=us`.length,
        });
        if (r && r.status !== 200) break sizes; // e.g. 414 URI too long: larger sizes will fail too
      }
    }
    const chosen = chooseBatchSize(trials);
    const B = chosen ?? 50;
    out.batchSize = { chartIdsChecked: checked, validInUs: valid.length, trials, chosen, usedForProbing: B };
    save();

    // ── 3. Find the frontier ────────────────────────────────────────────────
    console.error(`\n# 3. Frontier (batch ${B})`);
    const probes: Probe[] = [];
    const probe = async (start: number, tag: string): Promise<Probe> => {
      const r = await look(range(start, B), "us", tag);
      const ids = trackIds(r?.results ?? []);
      const p: Probe = { start, end: start + B - 1, hits: ids.length, maxId: ids.length ? Math.max(...ids) : null, status: r?.status ?? -1, tag };
      probes.push(p);
      return p;
    };
    let lastHit = await probe(seed - Math.floor(B / 2), "seed");
    let firstEmpty: Probe | null = null;
    let emptyRun = 0;
    let pos = seed;
    let step = 50_000;
    for (let i = 0; i < MAX_UP_PROBES && emptyRun < 3; i++) {
      pos += step;
      step *= 2;
      const p = await probe(pos, "up");
      if (p.hits > 0) {
        lastHit = p;
        emptyRun = 0;
        firstEmpty = null;
      } else {
        if (emptyRun === 0) firstEmpty = p;
        emptyRun++;
      }
    }
    let lo = lastHit.end;
    let hi = firstEmpty?.start ?? lo;
    const resolution = Math.max(20_000, 10 * B);
    for (let calls = 0; firstEmpty && hi - lo > resolution && calls < MAX_BISECT_CALLS; ) {
      const mid = Math.floor((lo + hi) / 2);
      let p = await probe(mid, "bisect");
      calls++;
      // One empty batch can be a sparse patch, so confirm with the next batch before moving hi down.
      if (p.hits === 0 && hi - mid > 2 * B) {
        const p2 = await probe(mid + B, "bisect-confirm");
        calls++;
        if (p2.hits > 0) p = p2;
      }
      if (p.hits > 0) lo = p.end;
      else hi = mid;
    }
    const hitMaxes = probes.map((p) => p.maxId).filter((n): n is number => n !== null);
    const frontier = Math.max(...hitMaxes);
    out.frontier = {
      probes,
      bracket: [lo, hi],
      frontier,
      highestApp: seen.get(frontier) ?? null,
      aboveSeed: frontier - seed,
    };
    save();

    // ── 4. Density below the frontier ───────────────────────────────────────
    console.error("\n# 4. Density");
    const density: Record<string, unknown>[] = [];
    const densityBatches: { distance: number; ids: number[]; hitIds: number[] }[] = [];
    const lowerEnvelope: { id: number; t: number; distance: number; date: string }[] = [];
    for (const d of DISTANCES) {
      const regionHits: Hit[] = [];
      let idsScanned = 0;
      for (let j = 0; j < 5; j++) {
        const start = frontier - d - j * 10_000 - B;
        const ids = range(start, B);
        const r = await look(ids, "us", `density${d}`);
        const hits = (r?.results ?? []).filter((x) => typeof x.trackId === "number").map((x) => toHit(x, `density${d}`));
        idsScanned += B;
        regionHits.push(...hits);
        densityBatches.push({ distance: d, ids, hitIds: hits.map((h) => h.id) });
      }
      const dates = regionHits.map((h) => h.releaseDate).filter((s): s is string => Boolean(s)).sort();
      const kinds: Record<string, number> = {};
      for (const h of regionHits) kinds[h.kind ?? "?"] = (kinds[h.kind ?? "?"] ?? 0) + 1;
      const ageDays = (s: string) => (now - Date.parse(s)) / DAY_MS;
      const centreId = frontier - d - 20_000 - Math.floor(B / 2);
      density.push({
        distance: d,
        centreId,
        batches: 5,
        idsScanned,
        hits: regionHits.length,
        hitsPer1000: Math.round(hitsPer1000(regionHits.length, idsScanned) * 100) / 100,
        kinds,
        releaseDateMin: dates[0] ?? null,
        releaseDateMedian: median(dates) ?? null,
        releaseDateMax: dates.at(-1) ?? null,
        releasedLast24h: dates.filter((s) => ageDays(s) <= 1).length,
        releasedLast7d: dates.filter((s) => ageDays(s) <= 7).length,
        releasedLast30d: dates.filter((s) => ageDays(s) <= 30).length,
      });
      if (dates[0]) lowerEnvelope.push({ id: centreId, t: Date.parse(dates[0]), distance: d, date: dates[0] });
    }
    out.density = density;
    save();

    // ── 5. IDs minted per day ───────────────────────────────────────────────
    console.error("\n# 5. IDs minted per day");
    const scanned = [...seen.values()].filter((h) => h.releaseDate && !/^(validate|size)/.test(h.step));
    const mintMedian = medianIdsPerDay(scanned.map((h) => ({ id: h.id, t: Date.parse(h.releaseDate!) })), now);
    const leastSquares = fitIdsPerDay(lowerEnvelope);
    const first = lowerEnvelope[0];
    const last = lowerEnvelope.at(-1);
    const pairwise = first && last && first.t !== last.t ? (first.id - last.id) / ((first.t - last.t) / DAY_MS) : null;
    const frontierPath = join(OUT_DIR, "frontier.json");
    let direct: { idsPerDay: number; previous: unknown; days: number } | null = null;
    if (existsSync(frontierPath)) {
      const prev = JSON.parse(readFileSync(frontierPath, "utf8")) as { frontier: number; measuredAt: string };
      const days = (now - Date.parse(prev.measuredAt)) / DAY_MS;
      if (days >= 0.5) direct = { idsPerDay: Math.round((frontier - prev.frontier) / days), previous: prev, days: Math.round(days * 100) / 100 };
    }
    const frontierRecord = { frontier, measuredAt: new Date(now).toISOString(), highestApp: seen.get(frontier) ?? null };
    writeFileSync(frontierPath, JSON.stringify(frontierRecord, null, 2) + "\n");
    appendFileSync(join(OUT_DIR, "frontier-history.jsonl"), JSON.stringify(frontierRecord) + "\n");
    const formula =
      "idsPerDay = Σ(Δtᵢ·Δidᵢ) / Σ(Δtᵢ²) × 86400000 over 250k-ID buckets with ≥20 items released in the last 30 days, where idᵢ = bucket centre and tᵢ = median releaseDate in bucket i; Δ = deviation from the mean. (Lower envelope kept for reference: re-released music carries decades-old dates, so it fails.)";
    console.error(formula);
    console.error(`median method: ${mintMedian.idsPerDay === null ? "n/a" : Math.round(mintMedian.idsPerDay)} IDs/day`);
    out.mintRate = {
      medianIdsPerDay: mintMedian.idsPerDay === null ? null : Math.round(mintMedian.idsPerDay),
      medianBuckets: mintMedian.buckets,
      lowerEnvelope,
      leastSquaresIdsPerDay: leastSquares === null ? null : Math.round(leastSquares),
      pairwiseIdsPerDay: pairwise === null ? null : Math.round(pairwise),
      direct,
      formula,
    };
    save();

    // ── 6. Date precision ───────────────────────────────────────────────────
    console.error("\n# 6. Date precision");
    const recent = [...seen.values()].filter((h) => h.releaseDate).sort((a, b) => b.id - a.id).slice(0, 20);
    for (const h of recent) console.error(`${h.id}  release=${h.releaseDate}  current=${h.currentVersionReleaseDate}  ${h.name}`);
    const all = [...seen.values()];
    out.datePrecision = {
      sample: recent.map((h) => ({ id: h.id, releaseDate: h.releaseDate, currentVersionReleaseDate: h.currentVersionReleaseDate })),
      releaseDate: datePrecision(all.map((h) => h.releaseDate).filter((s): s is string => Boolean(s))),
      currentVersionReleaseDate: datePrecision(all.map((h) => h.currentVersionReleaseDate).filter((s): s is string => Boolean(s))),
    };
    save();

    // ── 7. Storefront us vs pl ──────────────────────────────────────────────
    console.error("\n# 7. Storefront us vs pl");
    const sample = densityBatches.filter((b) => b.hitIds.length > 0).sort((a, b) => b.hitIds.length - a.hitIds.length).slice(0, 5);
    const storefront: Record<string, unknown>[] = [];
    for (const b of sample) {
      const r = await look(b.ids, "pl", `storefront${b.distance}`);
      const us = new Set(b.hitIds);
      const pl = new Set(trackIds(r?.results ?? []));
      storefront.push({
        distance: b.distance,
        first: b.ids[0],
        us: us.size,
        pl: pl.size,
        both: [...us].filter((id) => pl.has(id)).length,
        usOnly: [...us].filter((id) => !pl.has(id)).length,
        plOnly: [...pl].filter((id) => !us.has(id)).length,
      });
    }
    out.storefront = storefront;
    save();

    // ── Capacity ────────────────────────────────────────────────────────────
    const idsPerDay = direct?.idsPerDay ?? (mintMedian.idsPerDay && mintMedian.idsPerDay > 0 ? Math.round(mintMedian.idsPerDay) : null);
    if (idsPerDay && idsPerDay > 0) {
      out.capacity = capacity({ ratePerMin: cfg.rateLimitPerMin, hours: 6, batchSize: B, idsPerDay, storefronts: cfg.storefronts.length });
    }
  } catch (e) {
    if (e instanceof BudgetExceededError || e instanceof RequestFailedError) {
      out.aborted = e.message;
      console.error(`Aborted cleanly: ${e.message}`);
    } else {
      out.error = String(e);
      throw e;
    }
  } finally {
    out.lookupCalls = client.lookupCalls;
    out.statusCounts = statusCounts;
    out.finishedAt = new Date().toISOString();
    save();
    console.error(`\nDone. ${client.lookupCalls} lookup calls. Status counts: ${JSON.stringify(statusCounts)}`);
    console.error(`Results: ${join(OUT_DIR, "results.json")}`);
  }
}
