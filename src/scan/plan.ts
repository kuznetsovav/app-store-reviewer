import { range } from "../spike-math.js";

const DAY_MS = 86_400_000;

/** Extend phase: the next consecutive ascending batch starting at nextId. */
export function extendBatch(nextId: number, batchSize: number): number[] {
  return range(nextId, batchSize);
}

/**
 * Rescan phase: the next batch going DOWN from `from` (inclusive) to `bottom` (inclusive),
 * skipping known IDs. Returns null when nothing is left. Batches hold up to `batchSize`
 * IDs and are consecutive except where known IDs were removed.
 */
export function nextRescanBatch(opts: { from: number; bottom: number; known: Set<number>; batchSize: number }): number[] | null {
  const bottom = Math.max(0, opts.bottom);
  const ids: number[] = [];
  for (let id = opts.from; id >= bottom && ids.length < opts.batchSize; id--) {
    if (!opts.known.has(id)) ids.push(id);
  }
  return ids.length ? ids : null;
}

/** Every rescan batch from `from` down to `bottom`. Used by tests and dry-run counting. */
export function* rescanBatches(opts: { from: number; bottom: number; known: Set<number>; batchSize: number }): Generator<number[]> {
  let from = opts.from;
  for (;;) {
    const ids = nextRescanBatch({ ...opts, from });
    if (!ids) return;
    yield ids;
    from = ids.at(-1)! - 1;
  }
}

export interface EstimateInput {
  /** Days since the last frontier was observed. */
  daysSinceFrontier: number;
  idsPerDay: number;
  lookbackIds: number;
  knownSkipped: number;
  batchSize: number;
  storefronts: number;
  emptyBatchesToStop: number;
  ratePerMin: number;
}

/** Expected calls and minutes for one full run, same formula as the spike's capacity(). */
export function estimate(e: EstimateInput) {
  const extendIds = Math.max(0, Math.round(e.daysSinceFrontier * e.idsPerDay));
  const extendCalls = (Math.ceil(extendIds / e.batchSize) + e.emptyBatchesToStop) * e.storefronts;
  const rescanIds = Math.max(0, e.lookbackIds + 1 - e.knownSkipped);
  const rescanCalls = Math.ceil(rescanIds / e.batchSize) * e.storefronts;
  const calls = extendCalls + rescanCalls;
  return { extendIds, extendCalls, rescanIds, rescanCalls, calls, minutes: Math.round((calls / e.ratePerMin) * 10) / 10 };
}

export const daysBetween = (fromIso: string, toMs: number) => Math.max(0, (toMs - Date.parse(fromIso)) / DAY_MS);
