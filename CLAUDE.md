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

## Measured facts (fill in after the spike)
- Max IDs per call: TBD
- Hits per 1,000 IDs near the frontier: TBD
- IDs minted per day (approx.): TBD
- Current ID frontier (approx.): TBD
- releaseDate precision: TBD
