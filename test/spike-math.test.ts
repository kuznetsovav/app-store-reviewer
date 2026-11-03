import { describe, expect, it } from "vitest";
import { DAY_MS, capacity, chooseBatchSize, datePrecision, fitIdsPerDay, medianIdsPerDay, type SizeTrial } from "../src/spike-math.js";

const trial = (size: number, ok: boolean, status = 200): SizeTrial => ({
  size,
  trial: 0,
  status,
  resultCount: 0,
  validIncluded: 10,
  validReturned: ok ? 10 : 9,
  ms: 0,
  urlLength: 0,
});

describe("chooseBatchSize", () => {
  it("picks the largest size before the first failure", () => {
    expect(chooseBatchSize([trial(50, true), trial(100, true), trial(200, false), trial(300, true)])).toBe(100);
    expect(chooseBatchSize([trial(50, true), trial(100, true, 414)])).toBe(50);
    expect(chooseBatchSize([trial(50, false)])).toBeNull();
  });
});

describe("fitIdsPerDay", () => {
  it("recovers a linear mint rate", () => {
    const pts = [0, 10, 20, 30].map((d) => ({ id: 6_000_000_000 + d * 40_000, t: d * DAY_MS }));
    expect(fitIdsPerDay(pts)).toBeCloseTo(40_000);
  });
});

describe("medianIdsPerDay", () => {
  it("ignores old re-releases and recovers the mint rate from recent items", () => {
    const now = 40 * DAY_MS;
    const items = [];
    for (let day = 0; day < 20; day++) {
      for (let k = 0; k < 30; k++) items.push({ id: 6_000_000_000 + day * 400_000 + k * 1000, t: (20 + day) * DAY_MS });
      items.push({ id: 6_000_000_000 + day * 400_000 + 500, t: 0 }); // catalog re-release, dated decades ago
    }
    const r = medianIdsPerDay(items, now, { bucketSize: 400_000 });
    expect(r.idsPerDay).toBeCloseTo(400_000, -3);
  });
});

describe("datePrecision", () => {
  it("flags day-level timestamps", () => {
    expect(datePrecision(["2026-11-01T07:00:00Z", "2026-11-02T07:00:00Z"]).dayLevel).toBe(true);
    expect(datePrecision(["2026-11-01T07:00:00Z", "2026-11-02T13:21:09Z"]).dayLevel).toBe(false);
  });
});

describe("capacity", () => {
  it("computes lookback days for a 6-hour run", () => {
    const c = capacity({ ratePerMin: 18, hours: 6, batchSize: 200, idsPerDay: 40_000, storefronts: 1 });
    expect(c.calls).toBe(6480);
    expect(c.daysOfLookback).toBe(32.4);
  });
});
