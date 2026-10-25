import type { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// BobAgent -> UpBot: move ~/BobAgent to ~/UpBot (only for the default root) and
// repoint stored workspace paths.
export function migrateLegacyHome(
  db: Database,
  agentsRoot: string,
  log: (...args: unknown[]) => void,
  home = homedir(),
): void {
  const root = dirname(agentsRoot);
  if (root !== join(home, "UpBot")) return;
  const legacy = join(home, "BobAgent");
  if (!existsSync(legacy)) return;
  if (!existsSync(root)) {
    try {
      renameSync(legacy, root);
      log(`moved ${legacy} to ${root}`);
    } catch (e) {
      log("could not move legacy BobAgent folder", e);
      return;
    }
  }
  if (existsSync(legacy)) return;
  const res = db
    .query(
      "UPDATE agents SET workspace_path = ?1 || substr(workspace_path, ?2) WHERE substr(workspace_path, 1, ?3) = ?4",
    )
    .run(root, legacy.length + 1, legacy.length + 1, `${legacy}/`);
  if (res.changes) log(`repointed ${res.changes} workspace path(s) to ${root}`);
}
