# appstore-new-apps

## Goal
A daily job that lists iOS apps first released on the App Store in the last 24 hours,
using only Apple's public iTunes Lookup API (https://itunes.apple.com/lookup).
Output: a CSV and a Markdown report per day, committed to the repo.

## How it works
- App Store IDs are assigned roughly in creation order. We batch-look-up a rolling
  window of recent IDs (`lookup?id=1,2,3...&country=us`) and keep results whose
  `releaseDate` is within the last 24h.
- Most IDs in a range return nothing. Do not treat empty results as errors.
- An ID is assigned at record creation; the release can come weeks later, so each
  run rescans a lookback window of ID range, not just new IDs.

## Hard rules
- Never exceed the configured rate limit (default 18 calls/min, Apple documents ~20).
  One global rate limiter; no parallel clients; no proxies or IP rotation.
- Exponential backoff with jitter on 403, 429 and 5xx. Stop the run cleanly after
  N consecutive failures and save the checkpoint.
- Every run must be resumable: persist progress after every batch.
- Set a descriptive User-Agent with a contact URL from config.
- No secrets in the repo. Config via `config.json` + env overrides.

## Stack
- TypeScript, Node 20+, ESM, `tsx` for running, `vitest` for tests.
- SQLite via `better-sqlite3`. No ORM.
- Native `fetch`. No HTTP client library unless needed.
- CLI entry: `src/cli.ts` with subcommands (`spike`, `scan`, `report`, `run`).

## Conventions
- Small modules, pure functions where possible, I/O at the edges.
- Every network call goes through `src/lookup/client.ts`.
- Tests never hit the network: use recorded fixtures in `test/fixtures/`.
- Log one JSON line per batch (range, ids, hits, status, ms).
- When a measured number changes a default, update `config.json` and this file.

## Scanner
- `npx tsx src/cli.ts scan [--dry-run] [--max-calls N] [--seed ID] [--new]` and `status`.
- A run extends upward from the last frontier until `emptyBatchesToStop` empty
  batches (empty = no result of any kind), records the new frontier, then rescans
  down to `previous frontier − lookbackIds`, skipping apps already stored.
- Checkpoint after every batch (one SQLite transaction). Today's `running`/`aborted`
  run resumes; a `done`/`budget` run is not restarted without `--new`.
- `maxCallsPerRun` counts HTTP requests incl. retries, summed across resumes of the
  day's run; `maxMinutesPerRun` is per invocation. `maxConsecutiveFailures` (10)
  failed batches → `aborted`. Failed batches go to `failed_ranges` and get one retry
  at the end of the rescan.
- `isRecentRelease()` in `src/scan/dates.ts` is the single definition of "released
  in the last 24h". Reports must use it.
- First run with an empty DB seeds the frontier from `data/spike/frontier.json`.

## Decisions
- 2026-11-03 — Coverage: keep the 6h daily run and accept partial coverage (findings
  option 4). No tiered rescans, no runs longer than 6h.
  - Per run: maxMinutesPerRun 340 × 18 calls/min ≈ 6,100 calls ≈ 1.22M IDs in total.
    That budget covers both the upward extension (~391k new IDs/day) and the
    rescan below the previous frontier, so `lookbackIds` = 820,000. Together they
    give a window of ~3.1 days of IDs below the new frontier.
  - Reports must say so, in words like "Apps first released in the last 24h whose
    App Store record was created within the last ~3 days. Apps that sat
    unreleased for longer are not covered (most apps: median lag ~13 days)."
  - Store only results with `kind === "software"`; everything else is music,
    books, podcasts.
  - "Last 24h" must treat day-level releaseDates (`T07:00:00Z` / `T08:00:00Z`) as
    a US Pacific calendar day, not an instant.

## Measured facts (spike 2026-11-03, details in docs/spike-findings.md)
- Max IDs per call: 200. Above 200, Lookup silently drops results (300 → 210 back,
  still 200 OK); 500 → 502, 1000 → 400. Never raise `batchSize` above 200.
- Hits per 1,000 IDs near the frontier: ~90 (all content) rising to ~440 at 3M below.
  Apps only ~0.5 per 1,000: IDs are shared with songs, podcasts, ebooks, music videos.
  Filter on `kind === "software"`.
- IDs minted per day (approx.): ~391,000 (all content; medium confidence). Re-run
  `spike` 12h+ later for a direct measurement from data/spike/frontier.json.
- Current ID frontier (approx.): 6,830,316,023 on 2026-11-03 19:25 UTC.
- releaseDate precision: mixed. ~Half of apps are day-level, stamped midnight US
  Pacific (`T07:00:00Z` PDT / `T08:00:00Z` PST); the rest are to the second.
  `currentVersionReleaseDate` is always to the second.
- App release lag (ID creation → first release): median ~13 days (p25 6, p75 22;
  30 chart apps, low–medium confidence). A 6h run covers ~3.3 days of IDs, so a
  plain daily rescan catches only ~13% of new apps; see options in the findings.
- Storefront: `pl` added no unique hits over `us` (music-heavy sample). Scan `us`.
- Apple's RSS CDN 403s any User-Agent containing `example.com`; keep `contactUrl`
  empty or real.
