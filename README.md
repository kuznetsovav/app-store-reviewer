# appstore-new-apps

A daily list of iOS apps first released on the US App Store in the last 24 hours,
built only from Apple's public [iTunes Lookup API](https://performance-partners.apple.com/search-api).
Each day GitHub Actions scans recent App Store IDs and commits
`reports/YYYY-MM-DD.{csv,json,md}` plus `reports/latest.md`.

## How it works

App Store IDs are assigned roughly in creation order. Each run:

1. **Extends** upward from the last known frontier (highest ID with any result) until
   50 batches in a row return nothing, and records the new frontier.
2. **Rescans** 820,000 IDs below the previous frontier, newest first, skipping apps
   already stored.
3. **Reports** every stored app whose release date falls in the window, from the whole
   database rather than just today's hits.

It looks up 200 IDs per call at 18 calls per minute, with one shared rate limiter,
exponential backoff on 403/429/5xx, and a checkpoint after every batch. Details and
measurements are in [docs/spike-findings.md](docs/spike-findings.md).

## Coverage caveats

- **Partial by design.** A 6-hour run covers about 3 days of newly created IDs.
  The median app is released ~13 days after its App Store record is created, so the
  daily list mostly catches apps that went live soon after creation. Each report's
  Coverage section states the ID range scanned and anything skipped.
- **IDs are shared** with songs, podcasts and books (~391k new IDs a day across the
  catalog). Apps are about 0.5 per 1,000 IDs. Only `kind = software` (iOS apps) is
  stored.
- **US storefront only.** A spike sample found nothing in `pl` that `us` didn't have.
- **Release dates are mixed.** About half are date-only, stamped at midnight US Pacific.
  The default window counts those by Pacific calendar day and exact timestamps by the
  last 24 h (see `windowMode`).
- **Shared IPs.** GitHub-hosted runners share IP addresses, so Apple may throttle them
  more than a home connection. The client backs off and the run stops cleanly after
  10 failed batches in a row.

## Run locally

```bash
npm ci && npx tsx src/cli.ts run
```

| Command | What it does |
| --- | --- |
| `scan --dry-run` | Planned ranges, expected calls and minutes; no API calls |
| `scan [--max-calls N] [--seed ID] [--new]` | Scan only. Resumes today's run if it was interrupted |
| `report [--date YYYY-MM-DD]` | Write reports from the database; no API calls |
| `run [scan options]` | Scan, report, write `state/state.json`. Exit 1 if the scan aborted |
| `status` | Last 5 runs and the frontier |
| `prune` | Drop raw JSON of old apps and compact the database |
| `notify [--date YYYY-MM-DD]` | POST headline + watchlist to `NOTIFY_WEBHOOK_URL` (no-op if unset) |
| `spike` | Re-measure the ID space (see docs/spike-findings.md) |

Every command is `npx tsx src/cli.ts <command>`. Ctrl+C finishes the current batch
and saves, so the next `scan` resumes. `npm test` runs the test suite with no network
access.

## Configuration

All settings live in `config.json`. Each one can be overridden by an environment
variable; an empty value means "use config.json".

| Key | Default | Env variable | Meaning |
| --- | --- | --- | --- |
| `rateLimitPerMin` | 18 | `APPSTORE_RATE_LIMIT_PER_MIN` | Lookup calls per minute (max 20) |
| `batchSize` | 200 | `APPSTORE_BATCH_SIZE` | IDs per call. Max 200: above that Apple silently drops results |
| `lookbackIds` | 820000 | `APPSTORE_LOOKBACK_IDS` | IDs rescanned below the previous frontier |
| `emptyBatchesToStop` | 50 | `APPSTORE_EMPTY_BATCHES_TO_STOP` | Empty batches that end the upward extension |
| `maxCallsPerRun` | 6100 | `APPSTORE_MAX_CALLS_PER_RUN` | Call budget per day, retries included |
| `maxMinutesPerRun` | 340 | `APPSTORE_MAX_MINUTES_PER_RUN` | Wall-clock limit per invocation |
| `storefronts` | `["us"]` | `APPSTORE_STOREFRONTS` (comma list) | Storefronts looked up for each batch |
| `windowMode` | `mixed` | `APPSTORE_WINDOW_MODE` | `mixed`, `rolling24h` or `days` |
| `windowTimeZone` | `America/Los_Angeles` | `APPSTORE_WINDOW_TIME_ZONE` | Time zone for calendar-day comparisons |
| `watchlist.keywords` | `["wishlist","gift"]` | `APPSTORE_WATCHLIST_KEYWORDS` (comma list) | Matched in name or description |
| `watchlist.genres` | `[]` | `APPSTORE_WATCHLIST_GENRES` (comma list) | Matched against the app's genres |
| `userAgent` | `appstore-new-apps/0.1` | `APPSTORE_USER_AGENT` | Sent with every request |
| `contactUrl` | empty | `APPSTORE_CONTACT_URL` | Appended to the User-Agent. Don't use `example.com`: Apple's CDN rejects it |
| `dbPath` | `data/appstore.db` | `APPSTORE_DB_PATH` | SQLite database (not committed) |
| `reportsDir` | `reports` | `APPSTORE_REPORTS_DIR` | Where reports are written |
| `statePath` | `state/state.json` | `APPSTORE_STATE_PATH` | Committed frontier and last-run summary |
| `idsPerDayEstimate` | 391000 | `APPSTORE_IDS_PER_DAY_ESTIMATE` | Used by `--dry-run` and the coverage note |
| `maxRetries` | 5 | `APPSTORE_MAX_RETRIES` | Retries per request on 403/429/5xx |
| `maxConsecutiveFailures` | 10 | `APPSTORE_MAX_CONSECUTIVE_FAILURES` | Failed batches in a row before the run aborts |
| `requestTimeoutMs` | 30000 | `APPSTORE_REQUEST_TIMEOUT_MS` | Per-request timeout |

## Daily job (GitHub Actions)

[.github/workflows/daily.yml](.github/workflows/daily.yml) runs every day at 05:17 UTC
and can also be started by hand. It never runs two scans at once, and it times out
after 350 minutes.

**Manual run:** in the repository go to Actions → **daily** → **Run workflow**.
Optionally set `maxCallsPerRun` (e.g. `30` for a quick test) and `lookbackIds`. With the
GitHub CLI:

```bash
gh workflow run daily.yml -f maxCallsPerRun=30
```

**State between runs:**
- The SQLite database is kept in the Actions cache. The newest cache wins, and a copy
  is uploaded as the `db` artifact (kept 7 days).
- `state/state.json` is committed after every run with the frontier and a summary of
  the last run. If the cache is lost, the next run starts from it and the report
  carries a warning. Only rediscovery is lost, not the frontier.
- `prune` runs after each report to keep the database small.

**Commits:** `github-actions[bot]` commits `reports/` and `state/` as
"report YYYY-MM-DD: N new apps", only when files changed, even when the run hit its
budget or aborted. A branch-protection rule that blocks bot pushes will stop this step.

**Notification (optional):** add a repository secret `NOTIFY_WEBHOOK_URL`, for example
a Slack incoming webhook. The job POSTs `{"text": "<headline + watchlist>"}` to it. With
no secret set it does nothing, and the URL is never printed.

**Costs and limits:**
- A daily run of up to ~340 minutes is ~10,000 Actions minutes a month. That's free
  on a **public** repository but well over GitHub Free's 2,000 included minutes for a
  **private** one.
- GitHub disables scheduled workflows after 60 days without repository activity. The
  daily commit counts as activity.
- Scheduled runs can start several minutes late at busy times.
