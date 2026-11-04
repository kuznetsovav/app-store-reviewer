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
  /** When the request was sent (after the limiter let it through). Rate checks use this. */
  start?: string;
  /** A 200 whose body was not Lookup JSON; treated as a retryable failure. */
  badBody?: boolean;
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
  now?: () => number;
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

  /**
   * `retryServerErrors: false` fails fast on 5xx (403/429 and network errors are still
   * retried with backoff). Used when bisecting a batch that Apple 500s on every time.
   */
  async lookup(ids: number[], country: string, opts: { retryServerErrors?: boolean } = {}): Promise<LookupResponse> {
    if (ids.length === 0) throw new Error("lookup needs at least one id");
    const url = `${LOOKUP_URL}?id=${ids.join(",")}&country=${encodeURIComponent(country)}`;
    const sorted = [...ids].sort((a, b) => a - b);
    const meta = { kind: "lookup" as const, country, ids: ids.length, range: [sorted[0]!, sorted.at(-1)!] as [number, number] };
    const r = await this.request(url, meta, true, opts.retryServerErrors ?? true);
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
    retryServerErrors = true,
  ): Promise<{ status: number; body: unknown; ms: number; attempts: number }> {
    for (let attempt = 0; ; attempt++) {
      if (countsTowardBudget) {
        const budget = this.opts.maxLookupCalls ?? Infinity;
        if (this.lookupCalls >= budget) throw new BudgetExceededError(budget);
        this.lookupCalls++;
      }
      await this.limiter.acquire();
      const now = this.opts.now ?? Date.now;
      const started = now();
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
      const ms = now() - started;
      const hits = (body as { results?: unknown[] } | null)?.results?.length ?? 0;
      // A 200 whose body isn't Lookup JSON (truncated page, HTML from a proxy) must not
      // count as "no results": that would silently mark 200 IDs as scanned.
      const badBody = countsTowardBudget && status === 200 && !Array.isArray((body as { results?: unknown } | null)?.results);
      this.opts.log?.({
        ts: new Date(now()).toISOString(),
        start: new Date(started).toISOString(),
        ...meta,
        hits,
        status,
        ms,
        attempt,
        ...(badBody ? { badBody: true } : {}),
      });

      if (!badBody && !isRetryable(status)) return { status, body, ms, attempts: attempt + 1 };
      // Apple 500s on ~3% of 200-ID batches every time (measured 2026-11-04), so 5xx gets
      // few retries: the run moves on and retryFailed() splits the batch at the end.
      const serverErrorRetries = retryServerErrors ? Math.min(this.cfg.maxRetries, this.cfg.maxServerErrorRetries) : 0;
      const limit = status >= 500 ? serverErrorRetries : this.cfg.maxRetries;
      if (attempt >= limit) throw new RequestFailedError(badBody ? 200 : status, attempt + 1);
      await this.sleep(backoffMs(attempt));
    }
  }
}
