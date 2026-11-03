import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import {
  createRun,
  finishRun,
  getRun,
  insertFrontier,
  knownIdsBetween,
  lastFrontier,
  latestRunForDate,
  saveProgress,
  setExtendEnd,
  upsertApps,
  type Phase,
  type RunProgress,
  type RunRow,
  type RunStatus,
} from "../db/repo.js";
import { BudgetExceededError, LookupClient, RequestFailedError, type ClientOptions } from "../lookup/client.js";
import { parseApp, type AppRow } from "../lookup/parse.js";
import { range } from "../spike-math.js";
import { isRecentRelease } from "./dates.js";
import { extendBatch, nextRescanBatch } from "./plan.js";

export interface Seed {
  id: number;
  observedAt: string;
}

export interface ScanOptions {
  db: Db;
  cfg: Config;
  now?: () => number;
  /** Checked between batches; true finishes the run as aborted/SIGINT so the next scan resumes. */
  shouldStop?: () => boolean;
  /** Used only when the frontier table is empty. */
  seed?: Seed;
  /** Start a new run even if today's run exists. */
  forceNew?: boolean;
  /** Overrides cfg.maxCallsPerRun. */
  maxCalls?: number;
  clientOptions?: Omit<ClientOptions, "maxLookupCalls">;
  log?: (line: Record<string, unknown>) => void;
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
  | { kind: "ok"; anyKindHits: number; maxHit: number | null; apps: Merged[] }
  | { kind: "failed"; error: string }
  | { kind: "budget" };

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
  const resumable = run !== undefined && (run.status === "running" || run.status === "aborted") && !o.forceNew;
  if (run && !resumable && !o.forceNew) {
    return { run, resumed: false, inserted: [], skipped: `Today's run #${run.id} already finished (${run.status}). Use --new to start another.` };
  }
  if (!resumable) {
    let frontier = lastFrontier(db);
    if (!frontier) {
      if (!o.seed) throw new Error("No frontier in the database. Pass --seed <id> or run `spike` first (data/spike/frontier.json).");
      insertFrontier(db, o.seed.id, o.seed.observedAt);
      frontier = { max_hit_id: o.seed.id, observed_at: o.seed.observedAt };
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
  const client = new LookupClient(cfg, { ...o.clientOptions, maxLookupCalls: Math.max(0, maxCalls - p.calls) });
  const inserted: AppRow[] = [];
  let known = p.phase === "rescan" ? knownIdsBetween(db, bottom, top) : new Set<number>();
  let consecutiveFailures = 0;
  const ctl: { stop: { status: RunStatus; error: string | null } | null } = { stop: null };

  const outOfBudget = () => p.calls + cfg.storefronts.length > maxCalls || now() - t0 >= cfg.maxMinutesPerRun * 60_000;

  /** Looks up one batch in every storefront. Nothing is written here. */
  async function lookupBatch(ids: number[]): Promise<BatchOutcome> {
    const merged = new Map<number, Merged>();
    const anyKind = new Set<number>();
    const before = client.lookupCalls;
    try {
      for (const sf of cfg.storefronts) {
        const res = await client.lookup(ids, sf);
        if (res.status !== 200) return { kind: "failed", error: `status ${res.status}` };
        for (const x of res.results) {
          if (typeof x.trackId !== "number") continue;
          anyKind.add(x.trackId);
          const app = parseApp(x);
          if (!app) continue;
          const m = merged.get(app.trackId);
          if (m) m.storefronts.push(sf);
          else merged.set(app.trackId, { row: app, storefronts: [sf] });
        }
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) return { kind: "budget" };
      if (e instanceof RequestFailedError) return { kind: "failed", error: e.message };
      throw e;
    } finally {
      p.calls += client.lookupCalls - before;
    }
    return { kind: "ok", anyKindHits: anyKind.size, maxHit: anyKind.size ? Math.max(...anyKind) : null, apps: [...merged.values()] };
  }

  /** Upserts apps and saves the checkpoint in one transaction. */
  function commit(apps: Merged[]): AppRow[] {
    return db.transaction(() => {
      const ins = upsertApps(db, apps, iso());
      p.hits += apps.length;
      p.new_releases += ins.filter((a) => isRecentRelease(a.releaseDate, now())).length;
      saveProgress(db, runId, p);
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
      hits: out.kind === "ok" ? out.anyKindHits : 0,
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

  const collect = (ins: AppRow[]) => {
    inserted.push(...ins);
    return ins;
  };

  /** One more try for batches that failed earlier in this run. Leftovers stay in failed_ranges. */
  async function retryFailed() {
    const pending = p.failed;
    p.failed = [];
    for (const f of pending) {
      if (o.shouldStop?.() || outOfBudget()) {
        p.failed.push(f);
        continue;
      }
      const ids = range(f.first, f.last - f.first + 1).filter((id) => !known.has(id));
      if (ids.length === 0) continue;
      const started = now();
      const out = await lookupBatch(ids);
      if (out.kind === "ok") logBatch(f.phase, ids, started, out, collect(commit(out.apps)));
      else {
        p.failed.push(f);
        logBatch(f.phase, ids, started, out);
      }
    }
    saveProgress(db, runId, p);
  }

  // ── Main loop: extend upward, then rescan downward ────────────────────────
  while (!ctl.stop) {
    if (o.shouldStop?.()) {
      ctl.stop = { status: "aborted", error: "SIGINT" };
      break;
    }
    if (outOfBudget()) {
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
      p.empty_streak = out.anyKindHits === 0 ? p.empty_streak + 1 : 0;
      if (out.maxHit !== null) p.extend_max_hit = Math.max(p.extend_max_hit, out.maxHit);
      logBatch("extend", ids, started, out, collect(commit(out.apps)));
    } else {
      const ids = nextRescanBatch({ from: p.next_id, bottom, known, batchSize: cfg.batchSize });
      if (!ids) {
        await retryFailed();
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
      logBatch("rescan", ids, started, out, collect(commit(out.apps)));
    }
  }

  p.status = ctl.stop!.status;
  p.error = ctl.stop!.error;
  finishRun(db, runId, p, iso());
  return { run: getRun(db, runId), resumed: resumable, inserted };
}
