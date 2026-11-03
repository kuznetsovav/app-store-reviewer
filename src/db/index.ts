import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

/** Index i holds the SQL that takes user_version from i to i + 1. */
const MIGRATIONS = [
  readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"),
  // 2: where the extend phase stopped (next_id is reset to the old frontier when the rescan starts).
  "ALTER TABLE runs ADD COLUMN extend_end INTEGER;",
];

export function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Opens (creating if needed) and migrates the database. Use ":memory:" in tests. */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
