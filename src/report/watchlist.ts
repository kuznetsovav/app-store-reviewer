import type { Watchlist } from "../config.js";
import type { AppDbRow } from "../db/repo.js";
import { descriptionOf } from "./raw.js";

/**
 * Watchlist terms an app matches, e.g. ['keyword "gift"', "genre Shopping"].
 * Keywords: case-insensitive substrings of the name or description.
 * Genres: case-insensitive equality with the primary genre or any listed genre.
 */
export function matchWatchlist(app: Pick<AppDbRow, "name" | "primary_genre" | "genres" | "raw">, wl: Watchlist): string[] {
  const matched: string[] = [];
  if (wl.keywords.length) {
    const haystack = `${app.name ?? ""}\n${descriptionOf(app) ?? ""}`.toLowerCase();
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
