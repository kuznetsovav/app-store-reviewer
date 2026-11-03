-- Migration 1. Timestamps are ISO-8601 UTC strings; run_date is YYYY-MM-DD (UTC).

-- Only kind = "software" results are stored here.
CREATE TABLE apps (
  track_id                     INTEGER PRIMARY KEY,
  bundle_id                    TEXT,
  name                         TEXT,
  seller_name                  TEXT,
  artist_id                    INTEGER,
  primary_genre                TEXT,
  genres                       TEXT NOT NULL DEFAULT '[]',  -- JSON array of names
  price                        REAL,
  currency                     TEXT,
  release_date                 TEXT,
  current_version_release_date TEXT,
  version                      TEXT,
  track_view_url               TEXT,
  storefronts                  TEXT NOT NULL DEFAULT '[]',  -- JSON array, e.g. ["us"]
  first_seen_at                TEXT NOT NULL,
  last_seen_at                 TEXT NOT NULL,
  raw                          TEXT NOT NULL                -- Lookup result from the first storefront
);
CREATE INDEX apps_release_date ON apps (release_date);
CREATE INDEX apps_first_seen_at ON apps (first_seen_at);

CREATE TABLE runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date       TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('running', 'done', 'aborted', 'budget')),
  phase          TEXT NOT NULL CHECK (phase IN ('extend', 'rescan')),
  range_from     INTEGER NOT NULL,  -- rescan bottom (inclusive)
  range_to       INTEGER NOT NULL,  -- previous frontier: extend starts above it, rescan starts at it
  next_id        INTEGER NOT NULL,  -- checkpoint: next ID to look up (ascending in extend, descending in rescan)
  extend_max_hit INTEGER NOT NULL,  -- highest hit of any kind seen while extending
  empty_streak   INTEGER NOT NULL DEFAULT 0,
  failed_ranges  TEXT NOT NULL DEFAULT '[]',  -- JSON [{phase, first, last}]
  calls          INTEGER NOT NULL DEFAULT 0,  -- Lookup HTTP requests, retries included
  hits           INTEGER NOT NULL DEFAULT 0,  -- app (software) results
  new_releases   INTEGER NOT NULL DEFAULT 0,  -- apps first stored this run and released in the last 24h
  error          TEXT
);
CREATE INDEX runs_run_date ON runs (run_date);

CREATE TABLE frontier (
  observed_at TEXT NOT NULL,
  max_hit_id  INTEGER NOT NULL  -- highest ID with a result of any kind
);
