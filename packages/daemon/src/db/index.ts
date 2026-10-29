import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrations } from "./migrations";

export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "upbot.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Database): void {
  const row = db.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as {
    v: number;
  };
  const applied = row.v;
  for (let i = applied; i < migrations.length; i++) {
    const version = i + 1;
    const sql = migrations[i]!;
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        Date.now(),
      );
    })();
  }
}
