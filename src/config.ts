import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Config {
  rateLimitPerMin: number;
  userAgent: string;
  contactUrl: string;
  storefronts: string[];
  /** IDs per Lookup call. Measured max is 200; above that Apple silently drops results. */
  batchSize: number;
  /** How far below the previous frontier each run rescans; sized with the upward extension to fit 340 min (see CLAUDE.md Decisions). */
  lookbackIds: number;
  maxRetries: number;
  maxConsecutiveFailures: number;
  requestTimeoutMs: number;
}

const CONFIG_PATH = fileURLToPath(new URL("../config.json", import.meta.url));

/** Env overrides: APPSTORE_<UPPER_SNAKE_KEY>, e.g. APPSTORE_RATE_LIMIT_PER_MIN=12. */
export function applyEnv(base: Config, env: NodeJS.ProcessEnv): Config {
  const out: Config = { ...base };
  const num = (k: string) => (env[k] !== undefined ? Number(env[k]) : undefined);
  out.rateLimitPerMin = num("APPSTORE_RATE_LIMIT_PER_MIN") ?? out.rateLimitPerMin;
  out.maxRetries = num("APPSTORE_MAX_RETRIES") ?? out.maxRetries;
  out.maxConsecutiveFailures = num("APPSTORE_MAX_CONSECUTIVE_FAILURES") ?? out.maxConsecutiveFailures;
  out.requestTimeoutMs = num("APPSTORE_REQUEST_TIMEOUT_MS") ?? out.requestTimeoutMs;
  out.userAgent = env.APPSTORE_USER_AGENT ?? out.userAgent;
  out.contactUrl = env.APPSTORE_CONTACT_URL ?? out.contactUrl;
  if (env.APPSTORE_STOREFRONTS) out.storefronts = env.APPSTORE_STOREFRONTS.split(",").map((s) => s.trim());
  out.batchSize = num("APPSTORE_BATCH_SIZE") ?? out.batchSize;
  out.lookbackIds = num("APPSTORE_LOOKBACK_IDS") ?? out.lookbackIds;
  if (!(out.batchSize > 0 && out.batchSize <= 200)) {
    throw new Error(`batchSize must be in (0, 200], got ${out.batchSize}`);
  }
  if (!(out.rateLimitPerMin > 0 && out.rateLimitPerMin <= 20)) {
    throw new Error(`rateLimitPerMin must be in (0, 20], got ${out.rateLimitPerMin}`);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  return applyEnv(base, env);
}
