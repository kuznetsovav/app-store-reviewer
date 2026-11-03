import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WINDOW_MODES, type WindowMode } from "./scan/dates.js";

export interface Watchlist {
  /** Case-insensitive substrings matched against app name and description. */
  keywords: string[];
  /** Case-insensitive genre names matched against primary and all genres. */
  genres: string[];
}

export interface Config {
  /** How "released in the last 24h" is decided; see inWindow() in src/scan/dates.ts. */
  windowMode: WindowMode;
  /** Time zone for calendar-day comparisons. Apple stamps date-only releases at Pacific midnight. */
  windowTimeZone: string;
  reportsDir: string;
  /** Reports show times in UTC and in this zone. */
  displayTimeZone: string;
  /** Long-lived app IDs looked up at the start of every run to detect silent blocking. */
  canaryIds: number[];
  /** Fewer canary apps than this returned → the run aborts ("canary failed"). */
  canaryMinFound: number;
  /** Consecutive empty batches inside previously dense ranges before the run aborts. */
  denseEmptyBatchesToAbort: number;
  /** A 100k-ID bucket counts as dense at this many hits (any kind) per 1,000 IDs. */
  denseMinHitsPer1000: number;
  /** Share of results failing schema validation that aborts the run. */
  maxInvalidShare: number;
  /** Small committed file (frontier + last run) so a lost DB cache only costs re-discovery. */
  statePath: string;
  watchlist: Watchlist;
  rateLimitPerMin: number;
  userAgent: string;
  contactUrl: string;
  storefronts: string[];
  /** IDs per Lookup call. Measured max is 200; above that Apple silently drops results. */
  batchSize: number;
  /** How far below the previous frontier each run rescans; sized with the upward extension to fit 340 min (see CLAUDE.md Decisions). */
  lookbackIds: number;
  /** Consecutive batches with no result of any kind before the upward extension stops. */
  emptyBatchesToStop: number;
  /** Lookup HTTP requests per run (retries included), summed across resumes on the same day. */
  maxCallsPerRun: number;
  /** Wall-clock minutes per process invocation. */
  maxMinutesPerRun: number;
  /** Used only by `scan --dry-run` to estimate how many new IDs appeared since the last frontier. */
  idsPerDayEstimate: number;
  dbPath: string;
  maxRetries: number;
  maxConsecutiveFailures: number;
  requestTimeoutMs: number;
}

const CONFIG_PATH = fileURLToPath(new URL("../config.json", import.meta.url));

const NUMERIC_KEYS = [
  "rateLimitPerMin",
  "batchSize",
  "lookbackIds",
  "emptyBatchesToStop",
  "maxCallsPerRun",
  "maxMinutesPerRun",
  "idsPerDayEstimate",
  "maxRetries",
  "maxConsecutiveFailures",
  "requestTimeoutMs",
  "canaryMinFound",
  "denseEmptyBatchesToAbort",
  "denseMinHitsPer1000",
  "maxInvalidShare",
] as const;
const STRING_KEYS = ["userAgent", "contactUrl", "dbPath", "windowTimeZone", "displayTimeZone", "reportsDir", "statePath"] as const;
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** rateLimitPerMin → APPSTORE_RATE_LIMIT_PER_MIN */
export const envName = (key: string) => "APPSTORE_" + key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

/** Env overrides: APPSTORE_<UPPER_SNAKE_KEY>, e.g. APPSTORE_MAX_CALLS_PER_RUN=30. */
export function applyEnv(base: Config, env: NodeJS.ProcessEnv): Config {
  const out: Config = { ...base };
  // An empty value means "not set": scheduled CI runs pass empty workflow inputs.
  const get = (name: string) => {
    const v = env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };
  for (const key of NUMERIC_KEYS) {
    const v = get(envName(key));
    if (v !== undefined) out[key] = Number(v);
  }
  for (const key of STRING_KEYS) {
    const v = get(envName(key));
    if (v !== undefined) out[key] = v;
  }
  const sf = get(envName("storefronts"));
  if (sf) out.storefronts = list(sf);
  const mode = get(envName("windowMode"));
  if (mode !== undefined) out.windowMode = mode as WindowMode;
  out.watchlist = { keywords: [...(base.watchlist?.keywords ?? [])], genres: [...(base.watchlist?.genres ?? [])] };
  const kw = get("APPSTORE_WATCHLIST_KEYWORDS");
  if (kw !== undefined) out.watchlist.keywords = list(kw);
  const gn = get("APPSTORE_WATCHLIST_GENRES");
  if (gn !== undefined) out.watchlist.genres = list(gn);

  if (!WINDOW_MODES.includes(out.windowMode)) {
    throw new Error(`windowMode must be one of ${WINDOW_MODES.join(", ")}, got ${out.windowMode}`);
  }
  for (const key of ["windowTimeZone", "displayTimeZone"] as const) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: out[key] });
    } catch {
      throw new Error(`${key} is not a valid IANA time zone: ${out[key]}`);
    }
  }
  if (!Array.isArray(out.canaryIds) || out.canaryIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("canaryIds must be a list of positive integer app IDs");
  }
  if (out.canaryMinFound > out.canaryIds.length) {
    throw new Error(`canaryMinFound (${out.canaryMinFound}) is larger than the number of canaryIds (${out.canaryIds.length})`);
  }
  if (!(out.maxInvalidShare >= 0 && out.maxInvalidShare <= 1)) throw new Error("maxInvalidShare must be between 0 and 1");

  if (!(out.batchSize > 0 && out.batchSize <= 200)) {
    throw new Error(`batchSize must be in (0, 200], got ${out.batchSize}`);
  }
  if (!(out.rateLimitPerMin > 0 && out.rateLimitPerMin <= 20)) {
    throw new Error(`rateLimitPerMin must be in (0, 20], got ${out.rateLimitPerMin}`);
  }
  for (const key of NUMERIC_KEYS) {
    if (!Number.isFinite(out[key]) || out[key] < 0) throw new Error(`${key} must be a non-negative number, got ${out[key]}`);
  }
  if (out.storefronts.length === 0) throw new Error("storefronts must not be empty");
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  return applyEnv(base, env);
}
