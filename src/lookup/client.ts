import type { Config } from "../config.js";
import { backoffMs, isRetryable } from "./backoff.js";
import { RateLimiter } from "./limiter.js";

/** One result from the iTunes Lookup API. Only the fields we use are typed. */
export interface LookupResult {
  trackId?: number;
  wrapperType?: string;
  kind?: string;
  trackName?: string;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
  [key: string]: unknown;
}

export interface LookupResponse {
  status: number;
  resultCount: number;
  results: LookupResult[];
  ms: number;
  attempts: number;
  raw: unknown;
}

export interface CallLog {
  ts: string;
  kind: "lookup" | "rss";
  country?: string;
  ids?: number;
  range?: [number, number];
  hits?: number;
  status: number;
  ms: number;
  attempt: number;
  url?: string;
}

export class BudgetExceededError extends Error {
  constructor(public readonly budget: number) {
    super(`Lookup call budget of ${budget} exhausted`);
  }
}

export class RequestFailedError extends Error {
  constructor(public readonly status: number, public readonly attempts: number) {
    super(`Request failed with status ${status} after ${attempts} attempts`);
  }
}

export interface ClientOptions {
  /** Hard cap on Lookup HTTP requests, retries included. */
  maxLookupCalls?: number;
  log?: (line: CallLog) => void;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
}

const LOOKUP_URL = "https://itunes.apple.com/lookup";

/** The only place that talks to the network. One shared limiter for every request. */
export class LookupClient {
  lookupCalls = 0;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ua: string;

  constructor(private readonly cfg: Config, private readonly opts: ClientOptions = {}) {
    this.limiter = opts.limiter ?? new RateLimiter(cfg.rateLimitPerMin);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Apple's RSS CDN rejects UAs naming placeholder domains such as example.com, so the
    // contact part is only added once a real URL is configured.
    this.ua = cfg.contactUrl ? `${cfg.userAgent} (+${cfg.contactUrl})` : cfg.userAgent;
  }

  async lookup(ids: number[], country: string): Promise<LookupResponse> {
    if (ids.length === 0) throw new Error("lookup needs at least one id");
    const url = `${LOOKUP_URL}?id=${ids.join(",")}&country=${encodeURIComponent(country)}`;
    const sorted = [...ids].sort((a, b) => a - b);
    const meta = { kind: "lookup" as const, country, ids: ids.length, range: [sorted[0]!, sorted.at(-1)!] as [number, number] };
    const r = await this.request(url, meta, true);
    const body = r.body as { resultCount?: number; results?: LookupResult[] } | null;
    const results = Array.isArray(body?.results) ? body!.results : [];
    return { status: r.status, resultCount: body?.resultCount ?? results.length, results, ms: r.ms, attempts: r.attempts, raw: r.body };
  }

  /** Plain JSON GET (e.g. Apple's RSS charts). Rate-limited like everything else. */
  async getJson(url: string): Promise<{ status: number; body: unknown; ms: number }> {
    const r = await this.request(url, { kind: "rss" as const, url }, false);
    return { status: r.status, body: r.body, ms: r.ms };
  }

  private async request(
    url: string,
    meta: Omit<CallLog, "ts" | "status" | "ms" | "attempt" | "hits">,
    countsTowardBudget: boolean,
  ): Promise<{ status: number; body: unknown; ms: number; attempts: number }> {
    for (let attempt = 0; ; attempt++) {
      if (countsTowardBudget) {
        const budget = this.opts.maxLookupCalls ?? Infinity;
        if (this.lookupCalls >= budget) throw new BudgetExceededError(budget);
        this.lookupCalls++;
      }
      await this.limiter.acquire();
      const started = Date.now();
      let status = 0;
      let body: unknown = null;
      try {
        const res = await this.fetchImpl(url, {
          headers: { "User-Agent": this.ua, Accept: "application/json" },
          signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
        });
        status = res.status;
        const text = await res.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      } catch {
        status = 0; // network error or timeout
      }
      const ms = Date.now() - started;
      const hits = (body as { results?: unknown[] } | null)?.results?.length ?? 0;
      this.opts.log?.({ ts: new Date().toISOString(), ...meta, hits, status, ms, attempt });

      if (!isRetryable(status)) return { status, body, ms, attempts: attempt + 1 };
      if (attempt >= this.cfg.maxRetries) throw new RequestFailedError(status, attempt + 1);
      await this.sleep(backoffMs(attempt));
    }
  }
}
