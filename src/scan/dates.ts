const DAY_MS = 86_400_000;

/** Single definition of the report window. Scanner (`new_releases`) and reports both use it. */
export type WindowMode = "mixed" | "rolling24h" | "days";
export const WINDOW_MODES: readonly WindowMode[] = ["mixed", "rolling24h", "days"];
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

/**
 * About half of app releaseDates carry only a day: Apple stamps them at midnight US
 * Pacific, i.e. T07:00:00Z (PDT) or T08:00:00Z (PST). Their UTC date part is the
 * Pacific calendar date.
 */
export function isDayLevel(iso: string): boolean {
  return /T0[78]:00:00Z$/.test(iso);
}

/** YYYY-MM-DD in the given IANA time zone. */
export function zonedDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** YYYY-MM-DD in America/Los_Angeles. */
export const pacificDate = (ms: number) => zonedDate(ms, DEFAULT_TIME_ZONE);

/** The calendar day a release belongs to: the stamped date for day-level values, else its date in `timeZone`. */
function releaseDay(iso: string, t: number, timeZone: string): string {
  return isDayLevel(iso) ? iso.slice(0, 10) : zonedDate(t, timeZone);
}

/**
 * Is `releaseDate` inside the window that ends at `end`?
 * - rolling24h: as an instant in [end − 24h, end].
 * - days: its day is today or yesterday in `timeZone` (yesterday = the day of end − 24h).
 * - mixed (default): day-level values by `days`, precise values by `rolling24h`.
 */
export function inWindow(
  releaseDate: string | null | undefined,
  end: number,
  mode: WindowMode = "mixed",
  timeZone: string = DEFAULT_TIME_ZONE,
): boolean {
  if (!releaseDate) return false;
  const t = Date.parse(releaseDate);
  if (Number.isNaN(t)) return false;
  const rolling = () => t <= end && end - t <= DAY_MS;
  const days = () => {
    const day = releaseDay(releaseDate, t, timeZone);
    return day >= zonedDate(end - DAY_MS, timeZone) && day <= zonedDate(end, timeZone);
  };
  if (mode === "rolling24h") return rolling();
  if (mode === "days") return days();
  return isDayLevel(releaseDate) ? days() : rolling();
}

/** "Released in the last 24h" as the scanner counts it: mixed mode, Pacific days. */
export function isRecentRelease(releaseDate: string | null | undefined, now: number): boolean {
  return inWindow(releaseDate, now, "mixed", DEFAULT_TIME_ZONE);
}

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Plain-words description of the window, for report headers. */
export function describeWindow(end: number, mode: WindowMode, timeZone: string): string {
  const d1 = zonedDate(end - DAY_MS, timeZone);
  const d2 = zonedDate(end, timeZone);
  if (mode === "rolling24h") return `released in the 24 h before ${utc(end)}`;
  if (mode === "days") return `release date ${d1} or ${d2} (${timeZone})`;
  return `released in the 24 h before ${utc(end)}; date-only release dates count if they are ${d1} or ${d2} (${timeZone})`;
}
