import { describe, expect, it } from "vitest";
import { capacity } from "../src/spike-math.js";
import { estimate, extendBatch, nextRescanBatch, rescanBatches } from "../src/scan/plan.js";

const none = new Set<number>();

describe("nextRescanBatch", () => {
  it("goes down from `from`, inclusive", () => {
    expect(nextRescanBatch({ from: 10, bottom: 0, known: none, batchSize: 4 })).toEqual([10, 9, 8, 7]);
  });
  it("skips known IDs and still fills the batch, even on a boundary", () => {
    expect(nextRescanBatch({ from: 10, bottom: 0, known: new Set([7]), batchSize: 4 })).toEqual([10, 9, 8, 6]);
    expect(nextRescanBatch({ from: 10, bottom: 0, known: new Set([10]), batchSize: 2 })).toEqual([9, 8]);
  });
  it("clamps a negative bottom to 0", () => {
    expect(nextRescanBatch({ from: 2, bottom: -5, known: none, batchSize: 10 })).toEqual([2, 1, 0]);
  });
  it("handles top = bottom and returns null when nothing is left", () => {
    expect(nextRescanBatch({ from: 5, bottom: 5, known: none, batchSize: 10 })).toEqual([5]);
    expect(nextRescanBatch({ from: 4, bottom: 5, known: none, batchSize: 10 })).toBeNull();
  });
  it("returns null when every remaining ID is known", () => {
    expect(nextRescanBatch({ from: 3, bottom: 0, known: new Set([0, 1, 2, 3]), batchSize: 10 })).toBeNull();
  });
});

describe("rescanBatches", () => {
  it("ends with a partial batch", () => {
    expect([...rescanBatches({ from: 10, bottom: 0, known: none, batchSize: 4 })]).toEqual([
      [10, 9, 8, 7],
      [6, 5, 4, 3],
      [2, 1, 0],
    ]);
  });
  it("resumes from a checkpoint", () => {
    expect([...rescanBatches({ from: 6, bottom: 0, known: none, batchSize: 4 })]).toEqual([
      [6, 5, 4, 3],
      [2, 1, 0],
    ]);
  });
  it("covers every unknown ID exactly once", () => {
    const known = new Set([3, 50, 51, 99]);
    const all = [...rescanBatches({ from: 100, bottom: 0, known, batchSize: 7 })].flat();
    expect(all).toHaveLength(101 - known.size);
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((id) => known.has(id))).toBe(false);
  });
});

describe("extendBatch", () => {
  it("is consecutive and ascending", () => {
    expect(extendBatch(1001, 3)).toEqual([1001, 1002, 1003]);
  });
});

describe("estimate", () => {
  it("matches the spike's capacity math for one day of new IDs", () => {
    const e = estimate({
      daysSinceFrontier: 1,
      idsPerDay: 391_000,
      lookbackIds: 820_000,
      knownSkipped: 0,
      batchSize: 200,
      storefronts: 1,
      emptyBatchesToStop: 50,
      ratePerMin: 18,
    });
    expect(e.extendCalls).toBe(1_955 + 50);
    expect(e.rescanCalls).toBe(4_101);
    expect(e.calls).toBe(6_106);
    expect(e.minutes).toBeCloseTo(339.2, 1);
    // Same budget seen from the spike side: 340 min covers ~1.22M IDs.
    expect(capacity({ ratePerMin: 18, hours: 340 / 60, batchSize: 200, idsPerDay: 391_000, storefronts: 1 }).idsCoveredPerStorefront).toBe(1_224_000);
  });
  it("doubles calls per storefront and subtracts known IDs", () => {
    const e = estimate({ daysSinceFrontier: 0, idsPerDay: 0, lookbackIds: 999, knownSkipped: 200, batchSize: 200, storefronts: 2, emptyBatchesToStop: 0, ratePerMin: 18 });
    expect(e.rescanCalls).toBe(8);
  });
});
