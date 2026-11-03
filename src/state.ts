import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "./db/index.js";
import { lastFrontier, type RunRow } from "./db/repo.js";
import type { Seed } from "./scan/run.js";

/**
 * state/state.json, committed after every CI run. If the cached DB is lost, the next
 * run seeds its frontier from here instead of re-discovering it.
 */
export interface StateFile {
  frontier: { max_hit_id: number; observed_at: string } | null;
  lastRun: Pick<RunRow, "id" | "run_date" | "status" | "phase" | "calls" | "hits" | "new_releases" | "next_id" | "finished_at" | "error"> | null;
  /** Date of the report written with this state, and how many apps it listed. */
  reportDate: string;
  newApps: number;
  updatedAt: string;
}

export function buildState(db: Db, run: RunRow | null, reportDate: string, newApps: number, now = Date.now()): StateFile {
  const f = lastFrontier(db);
  return {
    frontier: f ? { max_hit_id: f.max_hit_id, observed_at: f.observed_at } : null,
    lastRun: run
      ? {
          id: run.id,
          run_date: run.run_date,
          status: run.status,
          phase: run.phase,
          calls: run.calls,
          hits: run.hits,
          new_releases: run.new_releases,
          next_id: run.next_id,
          finished_at: run.finished_at,
          error: run.error,
        }
      : null,
    reportDate,
    newApps,
    updatedAt: new Date(now).toISOString(),
  };
}

export function writeState(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function readState(path: string): StateFile | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as StateFile;
}

/** The frontier from state.json as a seed, or undefined if there is none. */
export function seedFromState(path: string): (Seed & { source: string }) | undefined {
  const f = readState(path)?.frontier;
  return f ? { id: f.max_hit_id, observedAt: f.observed_at, source: path } : undefined;
}
