import type { LookupResult } from "./client.js";

/** One app as stored in the `apps` table (camelCase; repo maps it to columns). */
export interface AppRow {
  trackId: number;
  bundleId: string | null;
  name: string | null;
  sellerName: string | null;
  artistId: number | null;
  primaryGenre: string | null;
  genres: string[];
  price: number | null;
  currency: string | null;
  releaseDate: string | null;
  currentVersionReleaseDate: string | null;
  version: string | null;
  trackViewUrl: string | null;
  raw: LookupResult;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** iOS apps only. IDs are shared with songs, books, podcasts, Mac apps ("mac-software"). */
export function isApp(r: LookupResult): boolean {
  return r.kind === "software" && typeof r.trackId === "number";
}

export function parseApp(r: LookupResult): AppRow | null {
  if (!isApp(r)) return null;
  return {
    trackId: r.trackId!,
    bundleId: str(r.bundleId),
    name: str(r.trackName),
    sellerName: str(r.sellerName),
    artistId: num(r.artistId),
    primaryGenre: str(r.primaryGenreName),
    genres: Array.isArray(r.genres) ? r.genres.filter((g): g is string => typeof g === "string") : [],
    price: num(r.price),
    currency: str(r.currency),
    releaseDate: str(r.releaseDate),
    currentVersionReleaseDate: str(r.currentVersionReleaseDate),
    version: str(r.version),
    trackViewUrl: str(r.trackViewUrl),
    raw: r,
  };
}
