/** Statuses worth retrying: throttling (403/429), server errors, and network failures (0). */
export function isRetryable(status: number): boolean {
  return status === 403 || status === 429 || status >= 500 || status === 0;
}

/**
 * Full-jitter exponential backoff: random in [0, min(cap, base * 2^attempt)].
 * attempt starts at 0. A floor keeps the delay above the limiter interval.
 */
export function backoffMs(
  attempt: number,
  { baseMs = 5_000, capMs = 120_000, floorMs = 3_500, rand = Math.random } = {},
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.max(floorMs, Math.round(rand() * ceiling));
}
