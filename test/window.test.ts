import { describe, expect, it } from "vitest";
import { describeWindow, inWindow } from "../src/scan/dates.js";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);

describe("inWindow — rolling24h", () => {
  const end = at("2026-11-04T06:00:00Z");
  it("includes exactly end − 24h and end, excludes 1 s outside", () => {
    expect(inWindow("2026-11-03T06:00:00Z", end, "rolling24h")).toBe(true);
    expect(inWindow("2026-11-04T06:00:00Z", end, "rolling24h")).toBe(true);
    expect(inWindow("2026-11-03T05:59:59Z", end, "rolling24h")).toBe(false);
    expect(inWindow("2026-11-04T06:00:01Z", end, "rolling24h")).toBe(false);
  });
  it("treats day-level values as instants too", () => {
    expect(inWindow("2026-11-03T08:00:00Z", end, "rolling24h")).toBe(true); // 22 h before
    expect(inWindow("2026-11-02T08:00:00Z", end, "rolling24h")).toBe(false); // 46 h before
  });
});

describe("inWindow — mixed (default)", () => {
  it("uses the 24 h rule for precise values", () => {
    const end = at("2026-11-04T06:00:00Z");
    expect(inWindow("2026-11-03T06:00:00Z", end)).toBe(true);
    expect(inWindow("2026-11-03T05:59:59Z", end)).toBe(false);
    expect(inWindow("2026-11-04T07:00:01Z", end)).toBe(false); // future
  });
  it("uses Pacific days for day-level values (PST), on both sides of midnight", () => {
    // Nov 3, 22:00 PST: today Nov 3, yesterday Nov 2.
    const before = at("2026-11-04T06:00:00Z");
    expect(inWindow("2026-11-02T08:00:00Z", before)).toBe(true);
    expect(inWindow("2026-11-01T07:00:00Z", before)).toBe(false);
    expect(inWindow("2026-11-04T08:00:00Z", before)).toBe(false); // tomorrow in Pacific
    // Nov 4, 00:30 PST: today Nov 4, yesterday Nov 3.
    const after = at("2026-11-04T08:30:00Z");
    expect(inWindow("2026-11-04T08:00:00Z", after)).toBe(true);
    expect(inWindow("2026-11-02T08:00:00Z", after)).toBe(false);
  });
  it("uses Pacific days for day-level values (PDT)", () => {
    const end = at("2026-07-15T06:30:00Z"); // Jul 14, 23:30 PDT
    expect(inWindow("2026-07-13T07:00:00Z", end)).toBe(true);
    expect(inWindow("2026-07-14T07:00:00Z", end)).toBe(true);
    expect(inWindow("2026-07-15T07:00:00Z", end)).toBe(false);
    expect(inWindow("2026-07-12T07:00:00Z", end)).toBe(false);
  });
});

describe("inWindow — days", () => {
  const end = at("2026-11-04T06:00:00Z"); // UTC: Nov 4 / Nov 3. LA: Nov 3 / Nov 2.
  it("compares calendar days in the configured zone", () => {
    expect(inWindow("2026-11-02T20:00:00Z", end, "days", "UTC")).toBe(false);
    expect(inWindow("2026-11-02T20:00:00Z", end, "days", LA)).toBe(true);
    expect(inWindow("2026-11-04T08:00:00Z", end, "days", "UTC")).toBe(true);
    expect(inWindow("2026-11-04T08:00:00Z", end, "days", LA)).toBe(false);
  });
  it("counts a whole day, not 24 h", () => {
    expect(inWindow("2026-11-03T00:00:01Z", end, "days", "UTC")).toBe(true); // 30 h before end
    expect(inWindow("2026-11-02T23:59:59Z", end, "days", "UTC")).toBe(false);
  });
});

describe("describeWindow", () => {
  const end = at("2026-11-04T06:12:00Z");
  it("says which rule applies in plain words", () => {
    expect(describeWindow(end, "rolling24h", LA)).toBe("released in the 24 h before 2026-11-04 06:12 UTC");
    expect(describeWindow(end, "days", "UTC")).toBe("release date 2026-11-03 or 2026-11-04 (UTC)");
    expect(describeWindow(end, "mixed", LA)).toContain("date-only release dates count if they are 2026-11-02 or 2026-11-03 (America/Los_Angeles)");
  });
});
