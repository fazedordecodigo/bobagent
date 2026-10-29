import type { Database } from "bun:sqlite";
import type { z } from "zod";

export class InvalidSettingError extends Error {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`invalid value stored in settings.${key}: ${reason}`);
    this.name = "InvalidSettingError";
  }
}

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
  let value: unknown;
  try {
    value = JSON.parse(r.value);
  } catch {
    throw new InvalidSettingError(key, "malformed JSON");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const reason = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new InvalidSettingError(key, reason);
  }
  return result.data;
}

export function hasSetting(db: Database, key: string): boolean {
  return db.query("SELECT 1 FROM settings WHERE key = ?").get(key) !== null;
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
