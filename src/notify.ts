/**
 * Optional webhook notification. Plain fetch on purpose: the "every network call goes
 * through src/lookup/client.ts" rule is about Apple's API, not this.
 * The URL is a secret: it is never logged, and error messages never include it.
 */

const MAX_TEXT = 3_000;

/** Headline plus the watchlist section of a Markdown report. */
export function notificationText(md: string): string {
  const lines = md.split("\n");
  const headline = (lines[0] ?? "").replace(/^#\s*/, "").trim();
  const start = lines.findIndex((l) => l.trim() === "## Watchlist");
  let watchlist = "";
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    watchlist = (end >= 0 ? rest.slice(0, end) : rest).join("\n").trim();
  }
  let text = watchlist ? `${headline}\n\nWatchlist\n${watchlist}` : headline;
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 15).trimEnd() + "\n…(truncated)";
  return text;
}

export type NotifyOutcome = "skipped" | "sent" | "failed";

export async function sendNotification(opts: {
  url: string | undefined;
  text: string;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<NotifyOutcome> {
  const log = opts.log ?? ((m) => console.error(m));
  if (!opts.url || !opts.url.trim()) return "skipped";
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.url.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: opts.text }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) {
      log(`Notification failed: HTTP ${res.status}.`);
      return "failed";
    }
    log("Notification sent.");
    return "sent";
  } catch (e) {
    // Only the error's type: messages and causes from fetch can contain the host.
    log(`Notification failed: ${e instanceof Error ? e.name : "unknown error"}.`);
    return "failed";
  }
}
