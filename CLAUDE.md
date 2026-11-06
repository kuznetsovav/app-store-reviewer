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
- Every Apple API call goes through `src/lookup/client.ts`. (The optional webhook in
  `src/notify.ts` is the one other network call; it must never log its URL.)
- Tests never hit the network: use recorded fixtures in `test/fixtures/`.
- Log one JSON line per batch (range, ids, hits, status, ms).
- When a measured number changes a default, update `config.json` and this file.

## Scanner
- `npx tsx src/cli.ts scan [--dry-run] [--max-calls N] [--seed ID] [--new]` and `status`.
- A run extends upward from the last frontier until `emptyBatchesToStop` empty
  batches (empty = no result of any kind), records the new frontier, then rescans
  down to `previous frontier − lookbackIds`, skipping apps already stored.
- Checkpoint after every batch (one SQLite transaction). Today's `running`/`aborted`
  run resumes; a `done`/`budget` run is not restarted without `--new` (abandons an
  interrupted run too) or `--restart-finished` (new run only if today's finished).
- `maxCallsPerRun` counts HTTP requests incl. retries, summed across resumes of the
  day's run; `maxMinutesPerRun` is per invocation. `maxConsecutiveFailures` (10)
  failed batches → `aborted`. A 5xx gets only `maxServerErrorRetries` (1) retries;
  403/429/network keep `maxRetries` (5). Failed batches go to `failed_ranges`; when the
  run ends as done or budget they are retried once, split in halves (≤3 levels, no 5xx
  retries) because Apple 500s on some batches every time. The main loop reserves 8 calls
  per failed range (max 40) and the time to make them (runs usually end on time).
- A 200 whose body is not Lookup JSON is a failed batch, never an empty one.
- A hit is any result with a trackId, collectionId or artistId.
- `isRecentRelease()` (scanner's `new_releases` counter) = `inWindow(…, "mixed")`;
  reports use `inRange()` with the discovery rule below. All in `src/scan/dates.ts`.

## Quiet-failure guards (all abort with status `aborted` and a reason)
- Canary: every invocation first looks up `canaryIds` (20 long-lived US apps); fewer
  than `canaryMinFound` (18) apps back → "canary failed". Refresh the list if apps
  get delisted.
- Dense ranges: per-100k-ID hit counts live in the `density` table. 300
  (`denseEmptyBatchesToAbort`) consecutive empty batches inside buckets that earlier
  runs found dense (≥ 20 hits per 1,000 IDs) → "silent blocking suspected".
- Response drift: every result is validated with zod (`src/lookup/schema.ts`).
  Unknown/missing app fields are counted, logged and added as a run warning; over
  5% invalid results (after ≥ 200) → "response drift".
- Rate limit proof: the client logs one JSON line per request with its start time;
  `check-log FILE` fails if any 60 s window exceeds `rateLimitPerMin` (CI runs it).
  The limiter interval is rounded up to whole ms (3,334 ms at 18/min).
- First run with an empty DB seeds the frontier from `data/spike/frontier.json`.
- A run that stops while still extending saves its highest hit as a frontier row,
  so the next day continues upward instead of re-extending the same IDs.

## Reports
- `report [--date YYYY-MM-DD]` builds `reports/YYYY-MM-DD.{csv,json,md}` + `latest.md`
  from the DB only (no API). `run [scan flags]` = scan then report; exit 0 on
  done/budget, 1 on aborted (the report is still written).
- Discovery rule (`selectForReport` in `src/report/query.ts`), so consecutive
  reports never lose or repeat an app: start = finish of the last run of an earlier
  date, end = this run's finish. A second run on the same date rewrites that date's
  report with a window spanning both runs (coverage names the earlier run). Listed: apps first stored in (start, end] released since start − 24h,
  plus apps stored earlier (pre-orders) whose release date arrived in (start, end].
  A fixed "24 h before finish" window lost apps that went live after their ID was
  scanned. Release dates compare by `windowMode`: `mixed` (default: precise as
  instants, date-only by calendar day in `windowTimeZone`), `rolling24h`, or `days`.
  `windowTimeZone` is America/Los_Angeles (Apple stamps date-only at Pacific midnight).
- The report queries the whole `apps` table, not just this run's hits.
- Times are stored as UTC ISO strings; reports show UTC plus `displayTimeZone`
  (Europe/Warsaw).
- Anomaly line at the top when the count is < 50% or > 200% of the median of the
  last 7 reports (needs ≥ 3; read from `reports/*.json`).
- Coverage names skipped ID ranges on budget/aborted runs, run warnings, and the
  ~3-day scope. `latest.md` is only replaced by the newest date (backfills keep it).
- Idempotent: `state.json` `updatedAt` is the run's finish time, so a repeated `run`
  on a finished day rewrites identical files and CI makes no second commit.
- CSV: RFC 4180 quoting, `storefronts` as `us;pl`, and a leading `'` on text that
  starts with `= + - @` (formula guard). JSON keeps raw values.
- Reports built from scratch/test DBs are never committed to `reports/`.

## Daily job
- `.github/workflows/daily.yml`: 05:17 UTC + manual dispatch (`maxCallsPerRun`,
  `lookbackIds` inputs, passed via env; empty env values mean "unset"). Scheduled
  runs pass `--restart-finished` (a re-run of a failed job resumes); manual runs
  resume today's run. `APPSTORE_CONTACT_URL` = the repository URL. `check-log` runs
  after the scan. Checkout takes the branch tip at job start (a run queued behind
  another must see its commit). Push: `pull --rebase -X theirs`, then this run's
  `reports/` + `state/` restored whole (they are newest), retried 3 times.
- DB lives in the Actions cache (`db-<run_id>-<attempt>`, restore prefix `db-`) with a
  7-day artifact backup. `state/state.json` (frontier + last run) is committed every
  run; an empty DB seeds from it (`--seed` → state.json → spike frontier) and the
  run records a warning that the report shows.
- After `run`: `prune` (raw JSON → '{}' for apps below frontier − lookbackIds released
  over 3 days ago, then VACUUM), `notify`, commit `reports/` + `state/`.
- Lint the workflow with `actionlint` before changing it.

## Decisions
- 2026-11-03 — Coverage: keep the 6h daily run and accept partial coverage (findings
  option 4). No tiered rescans, no runs longer than 6h.
  - Per run (revised in the Prompt 6 hardening pass): maxMinutesPerRun 325 × 18
    calls/min = 5,850 calls. A healthy day needs ~2,005 extend calls (~391k new IDs
    + 50 empty batches) + 3,701 rescan calls (`lookbackIds` 740,000) + 1 canary
    ≈ 5,707, leaving ~140 calls for retries so a normal run ends `done`. Window ≈
    1.13M IDs ≈ 2.9 days below the new frontier. 325 min + ~6 min retry tail +
    setup/post-steps stays under the 350-minute job timeout.
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
- Some 200-ID batches get HTTP 500 on every attempt, hours apart (seen 2026-11-03:
  6,830,318,424–623, narrowed by splitting to 6,830,318,424–448). Likely one bad ID.
  First full run (2026-11-04): ~100 of ~3,700 batches (~3%), all still 500 hours later
  while neighbours returned 200. With 5 retries and backoff they cost ~80 s each, ~2.2 h
  of the 5.4 h run (3,866 calls instead of 5,850), hence `maxServerErrorRetries` 1.
