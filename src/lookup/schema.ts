import { z } from "zod";
import type { LookupResult } from "./client.js";

/**
 * Response-drift guard. Every Lookup result is checked against a schema; apps strictly.
 * Unknown and missing fields are counted (not fatal); results that fail validation are
 * counted and, past cfg.maxInvalidShare, abort the run (see src/scan/run.ts).
 */

const isoUtc = z.iso.datetime(); // Apple sends e.g. 2026-11-03T18:06:52Z

/** Any result: songs, albums, artists, books, podcasts, apps. Only the shape we rely on. */
export const BaseResult = z.looseObject({
  wrapperType: z.string().optional(),
  kind: z.string().optional(),
  trackId: z.number().int().positive().optional(),
  collectionId: z.number().int().positive().optional(),
  artistId: z.number().int().positive().optional(),
  releaseDate: isoUtc.optional(),
});

/** iOS app results: the fields the scanner stores and reports. */
export const SoftwareResult = z.looseObject({
  wrapperType: z.literal("software"),
  kind: z.literal("software"),
  trackId: z.number().int().positive(),
  trackName: z.string(),
  bundleId: z.string(),
  sellerName: z.string(),
  artistId: z.number().int().positive(),
  primaryGenreName: z.string(),
  genres: z.array(z.string()),
  price: z.number().nonnegative(),
  currency: z.string(),
  releaseDate: isoUtc,
  currentVersionReleaseDate: isoUtc,
  version: z.string(),
  trackViewUrl: z.url(),
  description: z.string(),
});

/** Fields seen on app results in the spike (docs/spike-findings.md). Anything else is "unknown". */
export const KNOWN_SOFTWARE_FIELDS = new Set([
  "advisories", "appletvScreenshotUrls", "artistId", "artistName", "artistViewUrl", "artworkUrl100", "artworkUrl512",
  "artworkUrl60", "averageUserRating", "averageUserRatingForCurrentVersion", "bundleId", "contentAdvisoryRating",
  "currency", "currentVersionReleaseDate", "description", "features", "fileSizeBytes", "formattedPrice", "genreIds",
  "genres", "ipadScreenshotUrls", "isGameCenterEnabled", "isVppDeviceBasedLicensingEnabled", "kind",
  "languageCodesISO2A", "minimumOsVersion", "price", "primaryGenreId", "primaryGenreName", "releaseDate",
  "releaseNotes", "screenshotUrls", "sellerName", "sellerUrl", "supportedDevices", "trackCensoredName",
  "trackContentRating", "trackId", "trackName", "trackViewUrl", "userRatingCount",
  "userRatingCountForCurrentVersion", "version", "wrapperType",
]);

const REQUIRED_SOFTWARE_FIELDS = Object.keys(SoftwareResult.shape);

export interface SchemaStats {
  results: number;
  invalid: number;
  /** field → count, for app results only */
  unknownFields: Record<string, number>;
  missingFields: Record<string, number>;
  /** a few examples of validation errors, for the log */
  samples: string[];
}

export const emptyStats = (): SchemaStats => ({ results: 0, invalid: 0, unknownFields: {}, missingFields: {}, samples: [] });

const bump = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1);

/** Validates results, updates `stats`, and returns only the results that passed. */
export function validateResults(results: unknown[], stats: SchemaStats): LookupResult[] {
  const ok: LookupResult[] = [];
  for (const r of results) {
    stats.results++;
    const base = BaseResult.safeParse(r);
    if (!base.success) {
      stats.invalid++;
      if (stats.samples.length < 5) stats.samples.push(base.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      continue;
    }
    if (base.data.kind === "software") {
      const obj = r as Record<string, unknown>;
      for (const k of Object.keys(obj)) if (!KNOWN_SOFTWARE_FIELDS.has(k)) bump(stats.unknownFields, k);
      for (const k of REQUIRED_SOFTWARE_FIELDS) if (!(k in obj)) bump(stats.missingFields, k);
      const sw = SoftwareResult.safeParse(r);
      if (!sw.success) {
        stats.invalid++;
        if (stats.samples.length < 5) stats.samples.push(`app ${String(obj.trackId)}: ${sw.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        continue;
      }
    }
    ok.push(r as LookupResult);
  }
  return ok;
}

export const invalidShare = (s: SchemaStats) => (s.results === 0 ? 0 : s.invalid / s.results);
