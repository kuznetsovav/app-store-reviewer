const DAY_MS = 86_400_000;

/**
 * About half of app releaseDates carry only a day: Apple stamps them at midnight US
 * Pacific, i.e. T07:00:00Z (PDT) or T08:00:00Z (PST). Their UTC date part is the
 * Pacific calendar date.
 */
export function isDayLevel(iso: string): boolean {
  return /T0[78]:00:00Z$/.test(iso);
}

/** YYYY-MM-DD in America/Los_Angeles. */
export function pacificDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/**
 * True when an app counts as "released in the last 24h" at `now`.
 * Day-level values: their Pacific day is today or the day 24h ago (Pacific).
 * Precise values: within the last 24h as an instant.
 */
export function isRecentRelease(releaseDate: string | null | undefined, now: number): boolean {
  if (!releaseDate) return false;
  const t = Date.parse(releaseDate);
  if (Number.isNaN(t)) return false;
  if (isDayLevel(releaseDate)) {
    const day = releaseDate.slice(0, 10);
    return day >= pacificDate(now - DAY_MS) && day <= pacificDate(now);
  }
  return t <= now && now - t <= DAY_MS;
}
