# Spike findings — 2026-11-03

**Verdict: the approach works mechanically but does not fit the 6-hour budget.**
App Store IDs share one namespace with music, podcasts and books. About 391k IDs
are minted per day, and apps reach first release a median of about 13 days after
their ID is created. A 6-hour run at 18 calls/min covers about 3.3 days of IDs,
which would catch roughly 1 in 8 new apps. Options are at the end.

Run: `npx tsx src/cli.ts spike`, 2026-11-03 19:18–19:26 UTC. 89 Lookup calls of a
300 budget, plus 16 RSS chart calls. No 403 or 429 responses. Raw numbers are in
`data/spike/results.json`, and raw responses in `data/spike/raw/` (gitignored).

## Measured numbers

| Fact | Value | How measured | Confidence |
| --- | --- | --- | --- |
| Max IDs per call | **200** | 709 known-valid chart apps, 2 trials per size. 50/100/200 returned every valid ID. **300 returned only 210 of 300, with status 200 and no error.** 500 → 502 on all 12 attempts. 1000 → 400. | High |
| ID frontier (highest released item) | **~6,830,316,023** at 2026-11-03 19:25 UTC | Probed up from seed 6,828,015,363 (newest US chart app) in doubling steps, then bisected with a confirm batch on each empty probe. Bracket 6,830,316,041–6,830,328,396. The top item is a podcast, not an app. | Medium (±~15k IDs) |
| Hits per 1,000 IDs, all content | 89 (0–50k below), 247 (200k), 280 (1M), 440 (3M) | 5 × 200-ID batches per distance | Medium |
| Hits per 1,000 IDs, apps only | **~0.5** | 4 apps in 7,800 sequentially scanned IDs. The rest were 1,472 songs, ~750 untyped music items, 64 ebooks, 8 podcasts and 8 music videos. | Low (n = 4) |
| IDs minted per day | **~391,000** | Median releaseDate of items released in the last 30 days, per 250k-ID bucket (8 buckets, 30–305 items each), with a least-squares fit of ID against date. Formula in `results.json`. | Medium |
| App release lag (ID creation → first release) | median **~13 days** (p25 6, p75 22) | 30 chart apps released in the last 30 days. Their ID's creation date is extrapolated from the frontier at 391k/day. Only 4 of 30 released within 3 days, 18 of 30 within 14 days, 26 of 30 within 30 days. | Low–medium (chart apps are a biased sample; extrapolation beyond the measured 3M-ID span) |
| releaseDate precision | **Mixed** | About half of app values are exactly midnight US Pacific (`T07:00:00Z` in summer time, `T08:00:00Z` in winter time), so they only give the day. The rest are exact to the second. `currentVersionReleaseDate` is always exact to the second. | High |
| Storefront `us` vs `pl` | `pl` added **0** unique hits | 5 batches: 465 us hits, 442 pl hits, all pl hits also in us. 23 were us-only. These were almost all songs, so this says little about apps. | Low for apps |
| Throttling | 0 × 403, 0 × 429 at 18 calls/min | Did not stress-test. 18 × 502 were all on the 500-ID trials. 6 × 500 hit one 200-ID probe, which was lost after its retries. 1 RSS timeout recovered. | High |

Two surprises:

- **Lookup truncates silently above 200 IDs.** The response stays 200 OK and simply drops results, so a batch size above 200 would lose apps without any error.
- **The lower-envelope method for the mint rate fails.** Re-released music carries its original release date (1992, 2005, 2011), so the earliest release per region says nothing about when its IDs were minted. The spike now uses the median of recent releases instead (`medianIdsPerDay` in `src/spike-math.ts`). The first run's numbers were recomputed from the saved raw data, with no extra calls.

Apple's RSS chart CDN returns 403 when the User-Agent contains `example.com`. The Lookup API does not. `config.json` therefore ships with an empty `contactUrl`, and the UA leaves out the contact part until a real URL is set (`APPSTORE_CONTACT_URL` or `config.json`).

## Capacity math

```
calls per run       = 18 calls/min × 60 × 6 h            = 6,480
IDs covered per run = 6,480 × 200 IDs/call               = 1,296,000
lookback that fits  = 1,296,000 ÷ 391,000 IDs/day        ≈ 3.3 days
calls for L days    = L × 391,000 ÷ 200                  ≈ 1,955 × L
```

| Lookback | Calls/day | Hours at 18/min | Apps caught (by lag sample) |
| --- | --- | --- | --- |
| 3.3 days | 6,480 | 6.0 | ~13% |
| 7 days | 13,700 | 12.7 | ~37% |
| 14 days | 27,400 | 25.3 | ~60% |
| 30 days | 58,700 | 54.3 | ~87% |

A full rescan of 14 days or more does not fit in 24 hours at 18 calls/min, let alone 6.

## Options

1. **Tiered rescans (recommended).** Scan the newest ~3.3 days daily, days 4–14 every 3 days, and days 15–45 weekly. That costs roughly 6.5k + 7.2k + 8.7k ≈ 22k calls/day (~21 h). Late finds still carry their real `releaseDate`, so the report gains a "found late" section instead of losing them.
2. **Never rescan non-app IDs.** An ID that returned a song, book or podcast will never become an app. Those are 9–44% of IDs depending on distance, so dropping them saves the same share of rescans. This combines with option 1.
3. **Run longer than 6 hours.** The job is I/O-bound at 3.3 s per call, so a 20–24 h run with checkpointing is cheap to host. It's the simplest lever, with 24 h giving about 13 days of lookback.
4. **Accept partial coverage.** Keep 6 h and 3.3 days, and label the report as "new apps that went live within ~3 days of creation".
5. **A second source for long-lag apps.** This needs its own spike and a terms-of-use check, and is not assumed here.

Also, `entity=software` on Lookup was not tested. It might trim response size but would not reduce the number of calls.

**Decision (2026-11-03): option 4.** Keep the 6 h run and label the report's coverage. See `CLAUDE.md` → Decisions.

## Recommended config

| Key | Value | Why |
| --- | --- | --- |
| `batchSize` | 200 | Largest size that returned every valid ID; anything above truncates silently |
| `storefronts` | `["us"]` | `pl` added nothing unique (weak evidence, music-heavy sample) |
| `lookbackIds` | 820,000 | Below the *previous* frontier. With ~391k new IDs/day from the upward extension, that's ~1.22M IDs ≈ 6,100 calls ≈ 340 min. |
| `rateLimitPerMin` | 18 | No throttling seen; there's no reason to go closer to Apple's ~20 |

## To confirm

- Run `npx tsx src/cli.ts spike` again at least 12 h later. It reads `data/spike/frontier.json` and reports a direct IDs-per-day measurement, which should replace the ~391k estimate.
- The app lag distribution rests on 30 chart apps. The first real scans will give an unbiased sample.
