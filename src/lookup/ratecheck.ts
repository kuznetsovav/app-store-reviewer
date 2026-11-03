/**
 * Rate-limit proof: replays a run's JSON log (one line per HTTP request, written by
 * LookupClient's call log) and finds the busiest 60-second window.
 */

export interface RateCheck {
  calls: number;
  /** Most requests seen in any window [t, t + windowMs). */
  max: number;
  /** Start of that window (ISO), or null when there were no calls. */
  worstWindowStart: string | null;
  ok: boolean;
}

/** Request start times (ms) from log text. Lines that aren't request logs are ignored. */
export function callStarts(logText: string): number[] {
  const starts: number[] = [];
  for (const line of logText.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const j = JSON.parse(s) as { kind?: string; start?: string };
      if ((j.kind === "lookup" || j.kind === "rss") && typeof j.start === "string") {
        const t = Date.parse(j.start);
        if (!Number.isNaN(t)) starts.push(t);
      }
    } catch {
      /* not JSON: ignore */
    }
  }
  return starts;
}

export function maxInWindow(starts: number[], windowMs = 60_000): { max: number; at: number | null } {
  const t = [...starts].sort((a, b) => a - b);
  let max = 0;
  let at: number | null = null;
  for (let i = 0, j = 0; j < t.length; j++) {
    while (t[j]! - t[i]! >= windowMs) i++;
    if (j - i + 1 > max) {
      max = j - i + 1;
      at = t[i]!;
    }
  }
  return { max, at };
}

export function checkRateLog(logText: string, ratePerMin: number): RateCheck {
  const starts = callStarts(logText);
  const { max, at } = maxInWindow(starts);
  return { calls: starts.length, max, worstWindowStart: at === null ? null : new Date(at).toISOString(), ok: max <= ratePerMin };
}
