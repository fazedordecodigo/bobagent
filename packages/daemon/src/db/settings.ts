import type { Database } from "bun:sqlite";
import type { z } from "zod";

// Access layer for the `settings` key/value table (values stored as JSON).
// Reads validate the parsed value against a zod schema so a corrupt or
// legacy-format row fails with an error naming the key, instead of a bare
// SyntaxError or a silently mistyped object reaching the services.

export function getSetting<S extends z.ZodType>(
  db: Database,
  key: string,
  schema: S,
  fallback: z.output<S>,
): z.output<S> {
  const r = db.query("SELECT value FROM settings WHERE key = ?").get(key) as {
    value: string;
  } | null;
  if (!r) return fallback;
  try {
    return schema.parse(JSON.parse(r.value));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid value stored in settings.${key}: ${reason}`);
  }
}

export function setSetting(db: Database, key: string, value: unknown): void {
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    JSON.stringify(value),
  );
}

export function deleteSetting(db: Database, key: string): void {
  db.query("DELETE FROM settings WHERE key = ?").run(key);
}
