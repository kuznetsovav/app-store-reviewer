import { describe, expect, it } from "vitest";
import { isDayLevel, isRecentRelease, pacificDate } from "../src/scan/dates.js";

describe("isDayLevel", () => {
  it("recognises midnight Pacific in PDT and PST", () => {
    expect(isDayLevel("2026-07-15T07:00:00Z")).toBe(true);
    expect(isDayLevel("2026-11-03T08:00:00Z")).toBe(true);
    expect(isDayLevel("2026-11-03T18:06:52Z")).toBe(false);
    expect(isDayLevel("2026-11-03T12:00:00Z")).toBe(false);
  });
});

describe("pacificDate", () => {
  it("converts across the date line", () => {
    expect(pacificDate(Date.parse("2026-11-04T05:00:00Z"))).toBe("2026-11-03"); // 21:00 PST
    expect(pacificDate(Date.parse("2026-07-15T12:00:00Z"))).toBe("2026-07-15"); // 05:00 PDT
  });
});

describe("isRecentRelease", () => {
  it("treats day-level values as a Pacific calendar day (PST)", () => {
    const now = Date.parse("2026-11-04T05:00:00Z"); // Nov 3, 21:00 PST
    expect(isRecentRelease("2026-11-03T08:00:00Z", now)).toBe(true); // today
    expect(isRecentRelease("2026-11-02T08:00:00Z", now)).toBe(true); // the day 24h ago
    expect(isRecentRelease("2026-11-01T07:00:00Z", now)).toBe(false);
  });

  it("treats day-level values as a Pacific calendar day (PDT)", () => {
    const now = Date.parse("2026-07-15T12:00:00Z"); // Jul 15, 05:00 PDT
    expect(isRecentRelease("2026-07-15T07:00:00Z", now)).toBe(true);
    expect(isRecentRelease("2026-07-14T07:00:00Z", now)).toBe(true);
    expect(isRecentRelease("2026-07-13T07:00:00Z", now)).toBe(false);
  });

  it("treats precise values as an instant within 24h", () => {
    const now = Date.parse("2026-11-04T00:00:00Z");
    expect(isRecentRelease("2026-11-03T18:06:52Z", now)).toBe(true);
    expect(isRecentRelease("2026-11-02T23:59:00Z", now)).toBe(false);
    expect(isRecentRelease("2026-11-05T10:00:00Z", now)).toBe(false); // future
  });

  it("rejects missing or broken values", () => {
    expect(isRecentRelease(null, Date.now())).toBe(false);
    expect(isRecentRelease("not a date", Date.now())).toBe(false);
  });
});
