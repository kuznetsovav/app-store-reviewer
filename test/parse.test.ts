import { describe, expect, it } from "vitest";
import { isApp, parseApp } from "../src/lookup/parse.js";
import { fixture } from "./helpers.js";

describe("parseApp", () => {
  it("maps recorded app results to rows", () => {
    const rows = fixture("lookup-apps.json").results.map(parseApp);
    expect(rows.every(Boolean)).toBe(true);
    const row = rows[0]!;
    expect(row.trackId).toBe(505488770);
    expect(row.name).toEqual(expect.any(String));
    expect(row.bundleId).toEqual(expect.any(String));
    expect(row.sellerName).toEqual(expect.any(String));
    expect(row.genres.length).toBeGreaterThan(0);
    expect(row.releaseDate).toBe("2015-03-27T08:53:21Z");
    expect(row.trackViewUrl).toMatch(/^https:\/\/apps\.apple\.com\//);
    expect(row.raw.trackId).toBe(505488770);
  });

  it("keeps only iOS apps out of a mixed music batch", () => {
    const results = fixture("lookup-mixed.json").results;
    expect(results.length).toBe(6);
    const apps = results.map(parseApp).filter((r) => r !== null);
    expect(apps.map((a) => a.trackId)).toEqual([6829315824]);
    expect(apps[0]!.releaseDate).toBe("2026-11-03T18:06:52Z");
    expect(results.filter((r) => !isApp(r)).map((r) => r.kind ?? r.wrapperType)).toEqual(["song", "song", "song", "ebook", "collection"]);
  });

  it("rejects Mac apps and results without a trackId", () => {
    expect(parseApp({ kind: "mac-software", trackId: 1 })).toBeNull();
    expect(parseApp({ kind: "software" })).toBeNull();
  });
});
