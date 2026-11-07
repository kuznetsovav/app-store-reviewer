import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { descriptionOf, descriptionSnippet } from "../src/report/raw.js";
import { readHistory } from "../src/report/write.js";
import {
  DESCRIPTION_LEAD,
  MIN_BASELINE_APPS,
  SIGNALS,
  THEMES,
  countTags,
  formatChange,
  hasNonLatinLetter,
  marketLine,
  marketStats,
  signalsNote,
  signalsOf,
  summarizeSignals,
  summarizeThemes,
  themesNote,
  themesOf,
  type TagHistory,
} from "../src/report/themes.js";

const app = (name: string | null, description?: string | null) => ({ name, description });

describe("themesOf", () => {
  it("tags names, several themes per app allowed", () => {
    expect(themesOf(app("Kintaire: Mahjong Solitaire"))).toEqual(["puzzle"]);
    expect(themesOf(app("GLP-1 Dose Tracker AI: Shorty"))).toEqual(expect.arrayContaining(["ai", "tracker", "health"]));
    expect(themesOf(app("Quran Tilawah, Doa & Dzikir"))).toEqual(["faith"]);
    expect(themesOf(app("Zipcrate"))).toEqual([]);
    expect(themesOf(app(null))).toEqual([]);
  });

  it("matches AI only as a capitalised word", () => {
    expect(themesOf(app("Cataloger.AI"))).toContain("ai");
    expect(themesOf(app("Overseer Agents"))).toContain("ai");
    expect(themesOf(app("Ai no Uta"))).not.toContain("ai");
    expect(themesOf(app("Said & Done"))).not.toContain("ai");
    expect(themesOf(app("AIRPORT"))).not.toContain("ai");
  });

  it("uses the description lead with stricter phrases", () => {
    expect(themesOf(app("Zipcrate", "Zipcrate is a habit tracker for your plants."))).toContain("tracker");
    expect(themesOf(app("Keelmark", "An IPTV player for your M3U playlists."))).toContain("remote");
    // Words that name a feature, not the app's kind, don't count in the description.
    expect(themesOf(app("Anywave", "Tracks come from open catalogs. No tracking. Log ind for more."))).toEqual([]);
    expect(themesOf(app("Aura Clash", "An anime trading card game."))).not.toContain("finance");
  });

  it("ignores the description after the lead", () => {
    const late = "x".repeat(DESCRIPTION_LEAD) + " A habit tracker.";
    expect(themesOf(app("Zipcrate", late))).toEqual([]);
  });
});

describe("signalsOf", () => {
  it("reads the whole description", () => {
    const d = "Plan trips. ".repeat(80) + "No account, no ads, no tracking. Works offline. Syncs with iCloud.";
    expect(signalsOf(app("X", d))).toEqual(expect.arrayContaining(["no_account", "no_ads", "no_tracking", "offline", "icloud"]));
  });

  it("tells subscriptions from 'no subscription'", () => {
    expect(signalsOf(app("X", "Pro is an auto-renewable subscription, monthly or yearly."))).toContain("subscription");
    const once = signalsOf(app("X", "One payment. No subscription, ever."));
    expect(once).toContain("one_time");
    expect(once).not.toContain("subscription");
    expect(signalsOf(app("X", "See the cost per year of your bike."))).not.toContain("subscription");
  });

  it("needs a description", () => {
    expect(signalsOf(app("No ads: the game"))).toEqual([]);
  });
});

describe("summarizeThemes", () => {
  const apps = [app("Block Puzzle"), app("Sudoku Daily"), app("Habit Tracker"), app("Zipcrate")];

  it("counts, sorts by count and keeps examples in input order", () => {
    const s = summarizeThemes(apps);
    expect(s.rows[0]).toMatchObject({ id: "puzzle", count: 2, share: 0.5, previousShare: null, examples: ["Block Puzzle", "Sudoku Daily"] });
    expect(s.rows.map((r) => r.id)).toEqual(["puzzle", "tracker"]);
    expect(s.unmatched).toBe(1);
    expect(s.baselineApps).toBe(0);
  });

  it("compares with the pooled share of earlier reports counted the same way", () => {
    const history: TagHistory[] = [
      { count: 60, described: 0, themes: { puzzle: 3 } },
      { count: 60, described: 0, themes: { puzzle: 9, tracker: 6 } },
      { count: 500, described: 500, themes: { puzzle: 400 } }, // counted with descriptions: not comparable
      { count: 500 }, // no theme counts: ignored
    ];
    const s = summarizeThemes(apps, history);
    expect(s.baselineApps).toBe(120);
    expect(s.baselineReports).toBe(2);
    expect(s.rows.find((r) => r.id === "puzzle")!.previousShare).toBeCloseTo(0.1);
    expect(formatChange(0.5, 0.1)).toBe("+40.0 pp");
    expect(themesNote(s, false)).toContain("previous 2 comparable reports (120 apps)");
    expect(themesNote(s, false)).toContain("app names only");

    const described = summarizeThemes([app("Block Puzzle", "A puzzle game.")], history);
    expect(described.baselineApps).toBe(500);
    expect(themesNote(described, true)).toContain(`first ${DESCRIPTION_LEAD} characters`);
  });

  it("does not compare against a tiny baseline", () => {
    const s = summarizeThemes(apps, [{ count: MIN_BASELINE_APPS - 1, themes: { puzzle: 50 } }]);
    expect(s.rows[0]!.previousShare).toBeNull();
    expect(themesNote(s, false)).toContain("No comparison yet");
  });
});

describe("summarizeSignals", () => {
  it("counts only apps with a description, against described apps of earlier reports", () => {
    const apps = [app("A", "No ads here."), app("B", "Free trial, then a monthly subscription."), app("C", null)];
    const s = summarizeSignals(apps, [{ count: 300, described: 200, signals: { no_ads: 20 } }, { count: 50, described: 0, signals: {} }]);
    expect(s.total).toBe(2);
    expect(s.rows.find((r) => r.id === "no_ads")).toMatchObject({ count: 1, share: 0.5, previousShare: 0.1 });
    expect(signalsNote(s, 3)).toContain("2 of 3 apps");
  });
});

describe("formatChange", () => {
  it("signs and rounds", () => {
    expect(formatChange(0.03, null)).toBe("—");
    expect(formatChange(0.03, 0.033)).toBe("−0.3 pp");
    expect(formatChange(0.03, 0.03)).toBe("0.0 pp");
  });
});

describe("marketStats", () => {
  it("counts single-app sellers, non-Latin names and the median paid price", () => {
    const m = marketStats([
      { name: "纸上折景", seller_name: "A", price: 0, currency: "USD" },
      { name: "عين الأذكار - Ain Adhkar", seller_name: "A", price: 2.99, currency: "USD" },
      { name: "Café Órale", seller_name: "B", price: 0.99, currency: "USD" },
      { name: "Plain", seller_name: "C", price: 9.99, currency: "USD" },
    ]);
    expect(m).toMatchObject({ paid: 3, medianPaidPrice: 2.99, sellers: 3, singleAppSellers: 2, nonLatinNames: 2 });
    expect(marketLine(m, 4)).toBe("2 of 3 sellers released a single app · 50.0% of names use a non-Latin script · median paid price 2.99 USD.");
  });

  it("skips the median when paid apps mix currencies", () => {
    const m = marketStats([
      { name: "a", seller_name: "A", price: 1, currency: "USD" },
      { name: "b", seller_name: "B", price: 2, currency: "EUR" },
    ]);
    expect(m.medianPaidPrice).toBeNull();
    expect(marketLine(m, 2)).not.toContain("median");
  });

  it("treats accented Latin as Latin", () => {
    expect(hasNonLatinLetter("Autoškola – testy na vodičák")).toBe(false);
    expect(hasNonLatinLetter("교환일기 Exchange Diary")).toBe(true);
  });
});

describe("raw helpers", () => {
  it("reads the description and makes one-line snippets", () => {
    expect(descriptionOf({ raw: JSON.stringify({ description: "Hello\n\nworld" }) })).toBe("Hello\n\nworld");
    expect(descriptionOf({ raw: "{}" })).toBeNull();
    expect(descriptionOf({ raw: "not json" })).toBeNull();
    expect(descriptionSnippet("Hello\n\nworld", 50)).toBe("Hello world");
    expect(descriptionSnippet("abcdefghij", 5)).toBe("abcd…");
    expect(descriptionSnippet(null, 5)).toBe("");
  });
});

describe("readHistory", () => {
  it("adds theme and signal counts from each earlier report's names and descriptions", () => {
    const dir = mkdtempSync(join(tmpdir(), "reports-"));
    const rows = [
      { name: "Word Puzzle", description: "No ads." },
      { name: "Notes", description: null },
      { name: null }, // written before descriptions existed
    ];
    writeFileSync(join(dir, "2026-11-03.json"), JSON.stringify(rows));
    writeFileSync(join(dir, "2026-11-04.json"), JSON.stringify([{ name: "Today only" }]));
    const apps = rows.map((r) => ({ name: r.name, description: r.description ?? null }));
    expect(readHistory(dir, "2026-11-04")).toEqual([
      { date: "2026-11-03", count: 3, described: 1, themes: countTags(THEMES, apps), signals: countTags(SIGNALS, [apps[0]!]) },
    ]);
  });
});
