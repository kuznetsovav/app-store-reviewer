import { openSqlite, type Db } from "../db/index.js";

/**
 * The trends database (data/trends.db), separate from the scanner's: it only grows by daily
 * snapshots, which Apple can't backfill, so it gets its own cache key and a longer backup.
 * Dates are YYYY-MM-DD (UTC day of the collecting run); timestamps are ISO-8601 UTC.
 */
const MIGRATIONS = [
  `CREATE TABLE apps (
     track_id      INTEGER PRIMARY KEY,
     name          TEXT,
     seller        TEXT,
     genre         TEXT,
     release_date  TEXT,
     price         REAL,
     currency      TEXT,
     url           TEXT,
     artwork       TEXT,
     first_charted TEXT,  -- snap date of the first chart it appeared in
     last_charted  TEXT,
     discovered_on TEXT,  -- date of the new-apps report that listed it
     updated_at    TEXT NOT NULL
   );

   CREATE TABLE chart_snapshots (
     snap_date  TEXT NOT NULL,
     country    TEXT NOT NULL,
     chart      TEXT NOT NULL,     -- topfree | toppaid | topgrossing
     genre_id   INTEGER NOT NULL,  -- 0 = all apps
     genre_name TEXT,
     fetched_at TEXT NOT NULL,
     entries    INTEGER NOT NULL,
     PRIMARY KEY (snap_date, country, chart, genre_id)
   );

   CREATE TABLE chart_entries (
     snap_date TEXT NOT NULL,
     country   TEXT NOT NULL,
     chart     TEXT NOT NULL,
     genre_id  INTEGER NOT NULL,
     rank      INTEGER NOT NULL,  -- 1-based
     track_id  INTEGER NOT NULL,
     PRIMARY KEY (snap_date, country, chart, genre_id, rank)
   ) WITHOUT ROWID;
   CREATE INDEX chart_entries_track ON chart_entries (track_id, snap_date);

   -- rating_count NULL = looked up that day but Apple returned nothing (delisted or not out yet).
   CREATE TABLE rating_snapshots (
     snap_date    TEXT NOT NULL,
     country      TEXT NOT NULL,
     track_id     INTEGER NOT NULL,
     rating_count INTEGER,
     avg_rating   REAL,
     PRIMARY KEY (snap_date, country, track_id)
   ) WITHOUT ROWID;

   CREATE TABLE trend_runs (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     snap_date     TEXT NOT NULL,
     started_at    TEXT NOT NULL,
     finished_at   TEXT,
     status        TEXT NOT NULL CHECK (status IN ('running', 'done', 'budget', 'aborted')),
     chart_calls   INTEGER NOT NULL DEFAULT 0,
     lookup_calls  INTEGER NOT NULL DEFAULT 0,
     charts_ok     INTEGER NOT NULL DEFAULT 0,
     charts_failed INTEGER NOT NULL DEFAULT 0,
     apps_tracked  INTEGER NOT NULL DEFAULT 0,
     error         TEXT
   );`,
];

export function openTrendsDb(path: string): Db {
  return openSqlite(path, MIGRATIONS);
}
