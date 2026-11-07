/** Fields read from an app's stored Lookup JSON (`apps.raw`). Pruned rows hold '{}'. */

export function parseRaw(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The App Store description, or null when it isn't stored (pruned or missing). */
export function descriptionOf(app: { raw: string }): string | null {
  const d = parseRaw(app.raw).description;
  return typeof d === "string" && d.trim() !== "" ? d : null;
}

/** First `max` characters of the description on one line, with "…" when cut. */
export function descriptionSnippet(description: string | null, max: number): string {
  if (!description) return "";
  const s = description.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}
