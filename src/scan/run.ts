import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import {
  DENSITY_BUCKET,
  addWarning,
  createRun,
  denseBuckets,
  finishRun,
  getRun,
  insertFrontier,
  knownIdsBetween,
  lastFrontier,
  latestRunForDate,
  recordDensity,
  saveProgress,
  setExtendEnd,
  upsertApps,
  type Phase,
  type RunProgress,
  type RunRow,
  type RunStatus,
} from "../db/repo.js";
import { BudgetExceededError, LookupClient, RequestFailedError, type CallLog, type ClientOptions, type LookupResult } from "../lookup/client.js";
import { parseApp, type AppRow } from "../lookup/parse.js";
import { emptyStats, invalidShare, validateResults } from "../lookup/schema.js";
import { range } from "../spike-math.js";
import { isRecentRelease } from "./dates.js";
import { extendBatch, nextRescanBatch } from "./plan.js";

export interface Seed {
  id: number;
  observedAt: string;
  /** Where the seed came from (e.g. state/state.json), for the report warning. */
  source?: string;
}

export interface ScanOptions {
  db: Db;
  cfg: Config;
  now?: () => number;
  /** Checked between batches; true finishes the run as aborted/SIGINT so the next scan resumes. */
  shouldStop?: () => boolean;
  /** Used only when the frontier table is empty. */
  seed?: Seed;
  /** Start a new run even if today's run exists (and abandon an interrupted one). */
  forceNew?: boolean;
  /** Start a new run if today's run already finished (done/budget); resume it if it was interrupted. */
  restartFinished?: boolean;
  /** Overrides cfg.maxCallsPerRun. */
  maxCalls?: number;
  clientOptions?: Omit<ClientOptions, "maxLookupCalls" | "log" | "now">;
  /** One line per batch / event. */
  log?: (line: Record<string, unknown>) => void;
  /** One line per HTTP request (used for the rate-limit check). */
  callLog?: (line: CallLog) => void;
}

export interface ScanResult {
  run: RunRow;
  resumed: boolean;
  /** Apps stored for the first time during this invocation. */
  inserted: AppRow[];
  /** Set when nothing ran because today's run is already finished. */
  skipped?: string;
}

type Merged = { row: AppRow; storefronts: string[] };
type BatchOutcome =
  | { kind: "ok"; hitIds: number[]; maxHit: number | null; apps: Merged[] }
  | { kind: "failed"; error: string }
  | { kind: "budget" };

/** Any result counts as a hit: apps, songs, albums (collectionId), artists. */
const idOf = (x: LookupResult): number | null => {
  for (const k of ["trackId", "collectionId", "artistId"] as const) if (typeof x[k] === "number") return x[k] as number;
  return null;
};

export async function runScan(o: ScanOptions): Promise<ScanResult> {
  const { db, cfg } = o;
  const now = o.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const t0 = now();
  const today = new Date(t0).toISOString().slice(0, 10);
  const maxCalls = o.maxCalls ?? cfg.maxCallsPerRun;
  const log = o.log ?? ((line) => console.log(JSON.stringify(line)));

  // ── Pick up today's run or start a new one ────────────────────────────────
  let run = latestRunForDate(db, today);
  const interrupted = run !== undefined && (run.status === "running" || run.status === "aborted");
  const resumable = interrupted && !o.forceNew;
  if (run && !resumable && !o.forceNew && !o.restartFinished) {
    return { run, resumed: false, inserted: [], skipped: `Today's run #${run.id} already finished (${run.status}). Use --new to start another.` };
  }
  if (!resumable) {
    let frontier = lastFrontier(db);
    let seededWarning: string | null = null;
    if (!frontier) {
      if (!o.seed) throw new Error("No frontier in the database. Pass --seed <id> or run `spike` first (data/spike/frontier.json).");
      insertFrontier(db, o.seed.id, o.seed.observedAt);
      frontier = { max_hit_id: o.seed.id, observed_at: o.seed.observedAt };
      seededWarning =
        `The database was empty, so this run started from ${o.seed.source ?? "the given seed"} ` +
        `(frontier ${o.seed.id.toLocaleString("en-US")}, observed ${o.seed.observedAt}). ` +
        `Apps stored by earlier runs are not available, so releases they would have contributed may be missing.`;
    }
    const top = frontier.max_hit_id;
    run = createRun(db, {
      run_date: today,
      started_at: iso(),
      range_to: top,
      range_from: Math.max(0, top - cfg.lookbackIds),
      next_id: top + 1,
      extend_max_hit: top,
    });
    if (seededWarning) {
      addWarning(db, run.id, seededWarning);
      log({ ts: iso(), run: run.id, event: "warning", message: seededWarning });
    }
  }
  const r = run!;
  const runId = r.id;
  const top = r.range_to;
  const bottom = r.range_from;

  const p: RunProgress = {
    status: "running",
    phase: r.phase,
    next_id: r.next_id,
    extend_max_hit: r.extend_max_hit,
    empty_streak: r.empty_streak,
    calls: r.calls,
    hits: r.hits,
    new_releases: r.new_releases,
    error: null,
    failed: JSON.parse(r.failed_ranges),
  };
  saveProgress(db, runId, p);

  // Hard cap at the HTTP level too, so retries can't push past the budget.
  const client = new LookupClient(cfg, {
    ...o.clientOptions,
    now,
    log: o.callLog,
    maxLookupCalls: Math.max(0, maxCalls - p.calls),
  });
  const inserted: AppRow[] = [];
  let known = p.phase === "rescan" ? knownIdsBetween(db, bottom, top) : new Set<number>();
  let consecutiveFailures = 0;
  const ctl: { stop: { status: RunStatus; error: string | null } | null } = { stop: null };
  const sf = cfg.storefronts.length;
  const schema = emptyStats();
  // Ranges that earlier runs found dense: a long empty streak there means we're being blocked.
  const dense = cfg.denseEmptyBatchesToAbort > 0 ? denseBuckets(db, cfg.denseMinHitsPer1000) : new Set<number>();
  let denseEmptyStreak = 0;

  const outOfTime = (keepMs = 0) => now() - t0 + keepMs >= cfg.maxMinutesPerRun * 60_000;
  /**
   * Main loop keeps calls (and the time to make them) back so failed batches still get their
   * retry (~8 calls to split one). Runs usually end on time, so a calls-only reserve was not enough.
   */
  const reserve = () => Math.min(p.failed.length * 8, 40) * sf;
  const intervalMs = Math.ceil(60_000 / cfg.rateLimitPerMin);
  const mainLoopOutOfBudget = () => p.calls + sf + reserve() > maxCalls || outOfTime(reserve() * intervalMs);
  const outOfBudget = () => p.calls + sf > maxCalls || outOfTime();

  /** Looks up one batch in every storefront. Nothing is written here. */
  async function lookupBatch(ids: number[], retryServerErrors = true): Promise<BatchOutcome> {
    const merged = new Map<number, Merged>();
    const anyKind = new Set<number>();
    const before = client.lookupCalls;
    try {
      for (const s of cfg.storefronts) {
        const res = await client.lookup(ids, s, { retryServerErrors });
        if (res.status !== 200) return { kind: "failed", error: `status ${res.status}` };
        for (const x of validateResults(res.results, schema)) {
          const id = idOf(x);
          if (id === null) continue;
          anyKind.add(id);
          const app = parseApp(x);
          if (!app) continue;
          const m = merged.get(app.trackId);
          if (m) m.storefronts.push(s);
          else merged.set(app.trackId, { row: app, storefronts: [s] });
        }
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) return { kind: "budget" };
      if (e instanceof RequestFailedError) return { kind: "failed", error: e.message };
      throw e;
    } finally {
      p.calls += client.lookupCalls - before;
    }
    const hitIds = [...anyKind];
    return { kind: "ok", hitIds, maxHit: hitIds.length ? Math.max(...hitIds) : null, apps: [...merged.values()] };
  }

  /** Upserts apps, density and the checkpoint in one transaction. */
  function commit(ids: number[], out: Extract<BatchOutcome, { kind: "ok" }>): AppRow[] {
    return db.transaction(() => {
      const ins = upsertApps(db, out.apps, iso());
      recordDensity(db, ids, out.hitIds, iso());
      p.hits += out.apps.length;
      p.new_releases += ins.filter((a) => isRecentRelease(a.releaseDate, now())).length;
      saveProgress(db, runId, p);
      inserted.push(...ins);
      return ins;
    })();
  }

  function logBatch(phase: Phase, ids: number[], started: number, out: BatchOutcome, ins: AppRow[] = []) {
    log({
      ts: iso(),
      run: runId,
      phase,
      first: ids[0],
      last: ids.at(-1),
      ids: ids.length,
      hits: out.kind === "ok" ? out.hitIds.length : 0,
      apps: out.kind === "ok" ? out.apps.length : 0,
      new: ins.length,
      status: out.kind === "ok" ? "ok" : out.kind,
      ...(out.kind === "failed" ? { error: out.error } : {}),
      ms: now() - started,
      calls: p.calls,
    });
  }

  function onFailure(phase: Phase, ids: number[], error: string) {
    consecutiveFailures++;
    p.failed.push({ phase, first: Math.min(...ids), last: Math.max(...ids) });
    if (consecutiveFailures >= cfg.maxConsecutiveFailures) {
      ctl.stop = { status: "aborted", error: `${consecutiveFailures} consecutive failed batches (last: ${error})` };
    }
  }

  /** Quiet-failure guards, checked after every successful batch. */
  function checkGuards(ids: number[], out: Extract<BatchOutcome, { kind: "ok" }>) {
    if (schema.results >= 200 && invalidShare(schema) > cfg.maxInvalidShare) {
      ctl.stop = {
        status: "aborted",
        error: `response drift: ${(invalidShare(schema) * 100).toFixed(1)}% of ${schema.results} results failed validation (${schema.samples[0] ?? "see log"})`,
      };
      return;
    }
    if (dense.size === 0) return;
    if (out.hitIds.length > 0) denseEmptyStreak = 0;
    else if (dense.has(Math.floor(ids[0]! / DENSITY_BUCKET))) {
      denseEmptyStreak++;
      if (denseEmptyStreak >= cfg.denseEmptyBatchesToAbort) {
        ctl.stop = {
          status: "aborted",
          error: `silent blocking suspected: ${denseEmptyStreak} consecutive empty batches in ID ranges that earlier runs found dense`,
        };
      }
    }
  }

  /**
   * One more try for batches that failed earlier in this run. Apple sometimes answers 500
   * for the same batch every time (one ID in it seems to break the response), so a range
   * that fails again is split in halves, up to 3 levels deep, without retrying 5xx. That
   * recovers most of the batch and narrows the failure down. Leftovers stay in failed_ranges.
   */
  async function retryFailed() {
    const pending = p.failed;
    p.failed = [];
    const attempt = async (phase: Phase, ids: number[], depth: number): Promise<void> => {
      if (o.shouldStop?.() || outOfBudget()) {
        p.failed.push({ phase, first: Math.min(...ids), last: Math.max(...ids) });
        return;
      }
      const started = now();
      // The original batch already had its full retries; here one attempt per piece is enough.
      const out = await lookupBatch(ids, false);
      if (out.kind === "ok") {
        logBatch(phase, ids, started, out, commit(ids, out));
        return;
      }
      logBatch(phase, ids, started, out);
      if (out.kind === "failed" && ids.length > 1 && depth < 3) {
        const mid = Math.ceil(ids.length / 2);
        await attempt(phase, ids.slice(0, mid), depth + 1);
        await attempt(phase, ids.slice(mid), depth + 1);
        return;
      }
      p.failed.push({ phase, first: Math.min(...ids), last: Math.max(...ids) });
    };
    for (const f of pending) {
      const ids = range(f.first, f.last - f.first + 1).filter((id) => !known.has(id));
      if (ids.length) await attempt(f.phase, ids, 0);
    }
    saveProgress(db, runId, p);
  }

  // ── Canary: known-released apps must come back, or Apple is answering empty ──
  async function canary(): Promise<void> {
    if (cfg.canaryIds.length === 0) return;
    const before = client.lookupCalls;
    let found = 0;
    let error: string | null = null;
    try {
      const res = await client.lookup(cfg.canaryIds, cfg.storefronts[0]!);
      const want = new Set(cfg.canaryIds);
      found = validateResults(res.results, schema).filter((x) => x.kind === "software" && typeof x.trackId === "number" && want.has(x.trackId)).length;
      if (res.status !== 200) error = `status ${res.status}`;
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        ctl.stop = { status: "budget", error: null };
        return;
      }
      if (!(e instanceof RequestFailedError)) throw e;
      error = e.message;
    } finally {
      p.calls += client.lookupCalls - before;
    }
    log({ ts: iso(), run: runId, event: "canary", found, of: cfg.canaryIds.length, ...(error ? { error } : {}) });
    if (error || found < cfg.canaryMinFound) {
      ctl.stop = {
        status: "aborted",
        error: `canary failed: ${found}/${cfg.canaryIds.length} known apps returned (need ${cfg.canaryMinFound})${error ? `; ${error}` : ""}`,
      };
    }
    saveProgress(db, runId, p);
  }

  await canary();

  // ── Main loop: extend upward, then rescan downward ────────────────────────
  while (!ctl.stop) {
    if (o.shouldStop?.()) {
      ctl.stop = { status: "aborted", error: "SIGINT" };
      break;
    }
    if (mainLoopOutOfBudget()) {
      ctl.stop = { status: "budget", error: null };
      break;
    }

    if (p.phase === "extend") {
      if (p.empty_streak >= cfg.emptyBatchesToStop) {
        db.transaction(() => {
          insertFrontier(db, p.extend_max_hit, iso());
          setExtendEnd(db, runId, p.next_id - 1);
          p.phase = "rescan";
          p.next_id = top;
          p.empty_streak = 0;
          saveProgress(db, runId, p);
        })();
        known = knownIdsBetween(db, bottom, top);
        log({ ts: iso(), run: runId, event: "frontier", max_hit_id: p.extend_max_hit, previous: top });
        continue;
      }
      const ids = extendBatch(p.next_id, cfg.batchSize);
      const started = now();
      const out = await lookupBatch(ids);
      if (out.kind === "budget") {
        ctl.stop = { status: "budget", error: null };
        break;
      }
      p.next_id += cfg.batchSize;
      if (out.kind === "failed") {
        onFailure("extend", ids, out.error);
        saveProgress(db, runId, p);
        logBatch("extend", ids, started, out);
        continue;
      }
      consecutiveFailures = 0;
      p.empty_streak = out.hitIds.length === 0 ? p.empty_streak + 1 : 0;
      if (out.maxHit !== null) p.extend_max_hit = Math.max(p.extend_max_hit, out.maxHit);
      logBatch("extend", ids, started, out, commit(ids, out));
      checkGuards(ids, out);
    } else {
      const ids = nextRescanBatch({ from: p.next_id, bottom, known, batchSize: cfg.batchSize });
      if (!ids) {
        ctl.stop = { status: "done", error: null };
        break;
      }
      const started = now();
      const out = await lookupBatch(ids);
      if (out.kind === "budget") {
        ctl.stop = { status: "budget", error: null };
        break;
      }
      p.next_id = ids.at(-1)! - 1;
      if (out.kind === "failed") {
        onFailure("rescan", ids, out.error);
        saveProgress(db, runId, p);
        logBatch("rescan", ids, started, out);
        continue;
      }
      consecutiveFailures = 0;
      logBatch("rescan", ids, started, out, commit(ids, out));
      checkGuards(ids, out);
    }
  }

  // Failed batches get their retry when the run ends normally (done or out of budget),
  // using the calls the main loop kept in reserve. Not after an abort: the cause may persist.
  const stop = ctl.stop!;
  if ((stop.status === "done" || stop.status === "budget") && p.failed.length) await retryFailed();

  if (schema.results > 0) {
    log({ ts: iso(), run: runId, event: "schema", results: schema.results, invalid: schema.invalid, unknownFields: schema.unknownFields, missingFields: schema.missingFields, samples: schema.samples });
    const unknown = Object.keys(schema.unknownFields);
    const missing = Object.keys(schema.missingFields);
    if (unknown.length || missing.length) {
      addWarning(
        db,
        runId,
        `Apple's response format changed: ${unknown.length ? `new fields ${unknown.join(", ")}` : ""}${unknown.length && missing.length ? "; " : ""}${missing.length ? `missing fields ${missing.join(", ")}` : ""}.`,
      );
    }
  }

  p.status = stop.status;
  p.error = stop.error;
  // Stopped while still extending: keep what we learned, or after a long outage every
  // daily budget would be spent re-extending the same IDs and the frontier would never move.
  // (A same-day resume continues from the run row; this only affects the next new run.)
  if (p.phase === "extend" && p.extend_max_hit > top) insertFrontier(db, p.extend_max_hit, iso());
  finishRun(db, runId, p, iso());
  return { run: getRun(db, runId), resumed: resumable, inserted };
}
