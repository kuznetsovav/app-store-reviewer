import { existsSync, readFileSync } from "node:fs";
import { loadConfig, type Config } from "../config.js";
import { openDb, type Db } from "../db/index.js";
import { countApps, knownIdsBetween, lastFrontier, latestRunForDate, recentRuns } from "../db/repo.js";
import { daysBetween, estimate } from "./plan.js";
import { seedFromState } from "../state.js";
import { runScan, type ScanResult, type Seed } from "./run.js";

const SPIKE_FRONTIER = "data/spike/frontier.json";
const fmt = (n: number) => n.toLocaleString("en-US");

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function argNumber(args: string[], name: string): number | undefined {
  const v = argValue(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} needs a non-negative integer, got ${v}`);
  return n;
}

/**
 * Only used while the frontier table is empty: --seed, then state/state.json (committed by
 * CI, survives a lost DB cache), then the spike's frontier.
 */
function resolveSeed(args: string[], cfg: Config): (Seed & { source: string }) | undefined {
  const seed = argNumber(args, "--seed");
  if (seed !== undefined) return { id: seed, observedAt: new Date().toISOString(), source: "--seed" };
  const fromState = seedFromState(cfg.statePath);
  if (fromState) return fromState;
  if (existsSync(SPIKE_FRONTIER)) {
    const f = JSON.parse(readFileSync(SPIKE_FRONTIER, "utf8")) as { frontier: number; measuredAt: string };
    return { id: f.frontier, observedAt: f.measuredAt, source: SPIKE_FRONTIER };
  }
  return undefined;
}

export async function scanCommand(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    if (args.includes("--dry-run")) {
      dryRun(db, cfg, resolveSeed(args, cfg), argNumber(args, "--max-calls"));
      return;
    }

    const res = await scanWithCli(db, cfg, args);
    if (!res.skipped && res.run.status === "aborted") process.exitCode = res.run.error === "SIGINT" ? 130 : 1;
  } finally {
    db.close();
  }
}

/** Runs a scan with CLI flags and Ctrl+C handling, and prints the summary. Shared by `scan` and `run`. */
export async function scanWithCli(db: Db, cfg: Config, args: string[]): Promise<ScanResult> {
  const seed = resolveSeed(args, cfg);
  const maxCalls = argNumber(args, "--max-calls");
  let stopRequested = false;
  const onSigint = () => {
    if (stopRequested) {
      console.error("Second Ctrl+C: exiting now (the last committed batch is saved).");
      process.exit(130);
    }
    stopRequested = true;
    console.error("Ctrl+C: finishing the current batch, then saving. Press again to quit immediately.");
  };
  process.on("SIGINT", onSigint);
  let res: ScanResult;
  try {
    res = await runScan({ db, cfg, seed, maxCalls, forceNew: args.includes("--new"), shouldStop: () => stopRequested });
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (res.skipped) {
    console.error(res.skipped);
    return res;
  }
  {
    const r = res.run;
    console.error(
      [
        `Run #${r.id} ${res.resumed ? "(resumed) " : ""}finished: ${r.status}${r.error ? ` (${r.error})` : ""}`,
        `  phase ${r.phase}, next_id ${fmt(r.next_id)}, calls ${fmt(r.calls)}, app hits ${fmt(r.hits)}, new releases ${fmt(r.new_releases)}`,
        `  apps stored this invocation: ${res.inserted.length}; apps in db: ${fmt(countApps(db))}`,
        `  frontier: ${fmt(lastFrontier(db)?.max_hit_id ?? 0)} (extend high-water ${fmt(r.extend_max_hit)})`,
        r.failed_ranges !== "[]" ? `  failed ranges left: ${r.failed_ranges}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return res;
}

function dryRun(db: Db, cfg: Config, seed: (Seed & { source: string }) | undefined, maxCalls?: number): void {
  const dbFrontier = lastFrontier(db);
  const frontier = dbFrontier ?? (seed && { max_hit_id: seed.id, observed_at: seed.observedAt });
  if (!frontier) throw new Error("No frontier in the database. Pass --seed <id> or run `spike` first.");
  const source = dbFrontier ? "database" : seed!.source;
  const now = Date.now();
  const today = latestRunForDate(db, new Date(now).toISOString().slice(0, 10));
  const top = frontier.max_hit_id;
  const bottom = Math.max(0, top - cfg.lookbackIds);
  const knownSkipped = knownIdsBetween(db, bottom, top).size;
  const days = daysBetween(frontier.observed_at, now);
  const e = estimate({
    daysSinceFrontier: days,
    idsPerDay: cfg.idsPerDayEstimate,
    lookbackIds: top - bottom,
    knownSkipped,
    batchSize: cfg.batchSize,
    storefronts: cfg.storefronts.length,
    emptyBatchesToStop: cfg.emptyBatchesToStop,
    ratePerMin: cfg.rateLimitPerMin,
  });
  const cap = Math.min(maxCalls ?? cfg.maxCallsPerRun, Math.floor(cfg.maxMinutesPerRun * cfg.rateLimitPerMin));
  const lines = [
    "Dry run (no API calls)",
    `  Frontier:    ${fmt(top)} from ${source}, observed ${frontier.observed_at} (${days.toFixed(2)} days ago)`,
    `  Extend:      upward from ${fmt(top + 1)} until ${cfg.emptyBatchesToStop} empty batches; ~${fmt(e.extendIds)} new IDs at ${fmt(cfg.idsPerDayEstimate)}/day → ${fmt(e.extendCalls)} calls`,
    `  Rescan:      ${fmt(top)} down to ${fmt(bottom)} (${fmt(top - bottom + 1)} IDs, ${fmt(knownSkipped)} known apps skipped) → ${fmt(e.rescanCalls)} calls`,
    `  Batch size:  ${cfg.batchSize}; storefronts: ${cfg.storefronts.join(", ")}`,
    `  Expected:    ${fmt(e.calls)} calls ≈ ${e.minutes} min at ${cfg.rateLimitPerMin}/min`,
    `  Budget:      ${fmt(cap)} calls (maxCallsPerRun ${fmt(maxCalls ?? cfg.maxCallsPerRun)}, maxMinutesPerRun ${cfg.maxMinutesPerRun})`,
  ];
  if (e.calls > cap) {
    const rescanCallsLeft = Math.max(0, cap - e.extendCalls);
    const reach = Math.max(bottom, top - Math.floor(rescanCallsLeft / cfg.storefronts.length) * cfg.batchSize);
    lines.push(
      e.extendCalls >= cap
        ? `  → Budget runs out during the extend phase; no rescan this run.`
        : `  → Budget runs out during the rescan, around ID ${fmt(reach)} (${fmt(top - reach)} of ${fmt(top - bottom)} lookback IDs covered).`,
    );
  } else lines.push("  → Fits in the budget.");
  if (today) lines.push(`  Today's run #${today.id} is ${today.status} (phase ${today.phase}, next_id ${fmt(today.next_id)}, calls ${fmt(today.calls)}).`);
  console.log(lines.join("\n"));
}

export function statusCommand(): void {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    const f = lastFrontier(db);
    console.log(f ? `Frontier: ${fmt(f.max_hit_id)} (observed ${f.observed_at})` : "Frontier: none yet");
    console.log(`Apps stored: ${fmt(countApps(db))}`);
    const runs = recentRuns(db, 5);
    if (runs.length === 0) {
      console.log("No runs yet.");
      return;
    }
    console.log("\n  id  date        status   phase   calls  app hits  new  next_id          error");
    for (const r of runs) {
      console.log(
        `  ${String(r.id).padStart(2)}  ${r.run_date}  ${r.status.padEnd(7)}  ${r.phase.padEnd(6)}  ${String(r.calls).padStart(5)}  ${String(r.hits).padStart(8)}  ${String(r.new_releases).padStart(3)}  ${fmt(r.next_id).padEnd(15)}  ${r.error ?? ""}`,
      );
    }
  } finally {
    db.close();
  }
}
