import { describe, expect, it } from "vitest";
import { matchWatchlist } from "../src/report/watchlist.js";

const app = {
  name: "Gift Ideas Pro",
  primary_genre: "Shopping",
  genres: JSON.stringify(["Shopping", "Lifestyle"]),
  raw: JSON.stringify({ description: "Keep a shared WISHLIST for birthdays." }),
};

describe("matchWatchlist", () => {
  it("matches keywords in the name or description, case-insensitively", () => {
    expect(matchWatchlist(app, { keywords: ["wishlist", "gift"], genres: [] })).toEqual(['keyword "wishlist"', 'keyword "gift"']);
  });
  it("matches substrings (gift → Gifted)", () => {
    expect(matchWatchlist({ ...app, name: "Gifted", raw: "{}" }, { keywords: ["gift"], genres: [] })).toEqual(['keyword "gift"']);
  });
  it("matches genres against the primary genre or any listed genre", () => {
    expect(matchWatchlist(app, { keywords: [], genres: ["lifestyle"] })).toEqual(["genre lifestyle"]);
    expect(matchWatchlist(app, { keywords: [], genres: ["Shopping"] })).toEqual(["genre Shopping"]);
  });
  it("returns nothing when no term matches", () => {
    expect(matchWatchlist({ ...app, name: "Calculator", raw: "{}" }, { keywords: ["wishlist", "gift"], genres: ["Games"] })).toEqual([]);
  });
  it("ignores empty terms and broken JSON", () => {
    expect(matchWatchlist({ ...app, raw: "not json", genres: "nope" }, { keywords: [""], genres: [""] })).toEqual([]);
  });
});
