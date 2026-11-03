import type { Watchlist } from "../config.js";
import type { AppDbRow } from "../db/repo.js";

/**
 * Watchlist terms an app matches, e.g. ['keyword "gift"', "genre Shopping"].
 * Keywords: case-insensitive substrings of the name or description.
 * Genres: case-insensitive equality with the primary genre or any listed genre.
 */
export function matchWatchlist(app: Pick<AppDbRow, "name" | "primary_genre" | "genres" | "raw">, wl: Watchlist): string[] {
  const matched: string[] = [];
  if (wl.keywords.length) {
    let description = "";
    try {
      const raw = JSON.parse(app.raw) as { description?: unknown };
      if (typeof raw.description === "string") description = raw.description;
    } catch {
      /* raw is always JSON from the scanner; ignore anything else */
    }
    const haystack = `${app.name ?? ""}\n${description}`.toLowerCase();
    for (const k of wl.keywords) if (k && haystack.includes(k.toLowerCase())) matched.push(`keyword "${k}"`);
  }
  if (wl.genres.length) {
    let genres: string[] = [];
    try {
      genres = JSON.parse(app.genres) as string[];
    } catch {
      genres = [];
    }
    const own = new Set([app.primary_genre ?? "", ...genres].map((g) => g.toLowerCase()));
    for (const g of wl.genres) if (g && own.has(g.toLowerCase())) matched.push(`genre ${g}`);
  }
  return matched;
}
