import type { Db } from "./index.js";
import { lastFrontier } from "./repo.js";

const DAY_MS = 86_400_000;

/**
 * Keeps the DB small: drops the raw Lookup JSON for apps that will never be rescanned
 * (below latest frontier − lookbackIds) and whose release is outside every report window
 * (older than 3 days). The structured columns stay; only `raw` becomes '{}'.
 */
export function pruneRaw(db: Db, lookbackIds: number, now = Date.now()): { pruned: number; belowId: number | null } {
  const f = lastFrontier(db);
  if (!f) return { pruned: 0, belowId: null };
  const belowId = f.max_hit_id - lookbackIds;
  const cutoff = new Date(now - 3 * DAY_MS).toISOString();
  const info = db
    .prepare("UPDATE apps SET raw = '{}' WHERE track_id < ? AND raw <> '{}' AND (release_date IS NULL OR release_date < ?)")
    .run(belowId, cutoff);
  db.exec("VACUUM");
  return { pruned: info.changes, belowId };
}
