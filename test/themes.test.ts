import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHistory } from "../src/report/write.js";
import {
  MIN_BASELINE_APPS,
  countThemes,
  formatChange,
  hasNonLatinLetter,
  marketLine,
  marketStats,
  summarizeThemes,
  themesNote,
  themesOf,
  type ThemeHistory,
} from "../src/report/themes.js";

describe("themesOf", () => {
  it("tags names, several themes per app allowed", () => {
    expect(themesOf("Kintaire: Mahjong Solitaire")).toEqual(["puzzle"]);
    expect(themesOf("GLP-1 Dose Tracker AI: Shorty")).toEqual(expect.arrayContaining(["ai", "tracker", "health"]));
    expect(themesOf("Quran Tilawah, Doa & Dzikir")).toEqual(["faith"]);
    expect(themesOf("Zipcrate")).toEqual([]);
    expect(themesOf(null)).toEqual([]);
  });

  it("matches AI only as a capitalised word", () => {
    expect(themesOf("Cataloger.AI")).toContain("ai");
    expect(themesOf("Mediatrends AI")).toContain("ai");
    expect(themesOf("Overseer Agents")).toContain("ai");
    expect(themesOf("Ai no Uta")).not.toContain("ai");
    expect(themesOf("Said & Done")).not.toContain("ai");
    expect(themesOf("AIRPORT")).not.toContain("ai");
  });
});

describe("summarizeThemes", () => {
  const apps = [{ name: "Block Puzzle" }, { name: "Sudoku Daily" }, { name: "Habit Tracker" }, { name: "Zipcrate" }];

  it("counts, sorts by count and keeps examples in input order", () => {
    const s = summarizeThemes(apps);
    expect(s.rows[0]).toMatchObject({ id: "puzzle", count: 2, share: 0.5, previousShare: null, examples: ["Block Puzzle", "Sudoku Daily"] });
    expect(s.rows.map((r) => r.id)).toEqual(["puzzle", "tracker"]);
    expect(s.unmatched).toBe(1);
    expect(s.baselineApps).toBe(0);
  });

  it("compares with the pooled share of earlier reports once they have enough apps", () => {
    const history: ThemeHistory[] = [
      { count: 60, themes: { puzzle: 3 } },
      { count: 60, themes: { puzzle: 9, tracker: 6 } },
      { count: 500 }, // no theme counts: ignored
    ];
    const s = summarizeThemes(apps, history);
    expect(s.baselineApps).toBe(120);
    expect(s.baselineReports).toBe(2);
    expect(s.rows.find((r) => r.id === "puzzle")!.previousShare).toBeCloseTo(0.1);
    expect(formatChange(0.5, 0.1)).toBe("+40.0 pp");
    expect(themesNote(s, 4)).toContain("previous 2 reports (120 apps)");
  });

  it("does not compare against a tiny baseline", () => {
    const s = summarizeThemes(apps, [{ count: MIN_BASELINE_APPS - 1, themes: { puzzle: 50 } }]);
    expect(s.rows[0]!.previousShare).toBeNull();
    expect(themesNote(s, 4)).toContain("No comparison yet");
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

describe("readHistory", () => {
  it("adds theme counts from each earlier report's names", () => {
    const dir = mkdtempSync(join(tmpdir(), "reports-"));
    writeFileSync(join(dir, "2026-11-03.json"), JSON.stringify([{ name: "Word Puzzle" }, { name: "Notes" }, { name: null }]));
    writeFileSync(join(dir, "2026-11-04.json"), JSON.stringify([{ name: "Today only" }]));
    expect(readHistory(dir, "2026-11-04")).toEqual([{ date: "2026-11-03", count: 3, themes: countThemes(["Word Puzzle", "Notes"]) }]);
  });
});
