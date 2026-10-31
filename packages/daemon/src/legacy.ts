import type { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

// Only default homes migrate; custom workspace roots remain untouched.
export function migrateLegacyHome(
  db: Database,
  agentsRoot: string,
  log: (...args: unknown[]) => void,
  home = homedir(),
): void {
  const root = dirname(agentsRoot);
  if (root !== join(home, "Boto")) return;
  for (const name of ["UpBot", "BobAgent"]) {
    const legacy = join(home, name);
    if (!existsSync(root) && existsSync(legacy)) {
      renameSync(legacy, root);
      log(`moved ${legacy} to ${root}`);
    }
    // Never merge two existing homes or repoint paths to files we did not move.
    if (existsSync(legacy) || !existsSync(root)) continue;
    const legacyPrefix = `${legacy}${sep}`;
    const res = db
      .query(
        "UPDATE agents SET workspace_path = ?1 || substr(workspace_path, ?2) WHERE substr(workspace_path, 1, ?3) = ?4",
      )
      .run(root, legacyPrefix.length, legacyPrefix.length, legacyPrefix);
    if (res.changes) log(`repointed ${res.changes} workspace path(s) to ${root}`);
  }
}
