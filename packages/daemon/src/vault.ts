import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VaultEntry } from "@bobagent/protocol";

// Encrypted secret store (AES-256-GCM). The key lives in the macOS Keychain (service
// "BobAgent", account "vault-key"), or <data-dir>/vault.key (0600) elsewhere;
// BOBAGENT_VAULT_KEY (64 hex chars) overrides it for tests. Each secret has an agent
// allowlist; agents read allowed secrets with the vault_get bridge tool.

export const VAULT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

type Row = { name: string; iv: string; data: string; agent_ids: string; updated_at: number };

function keychainKey(): Buffer | null {
  if (process.platform !== "darwin") return null;
  const find = Bun.spawnSync(
    ["security", "find-generic-password", "-s", "BobAgent", "-a", "vault-key", "-w"],
    {
      stderr: "ignore",
    },
  );
  const existing = find.stdout.toString().trim();
  if (find.exitCode === 0 && /^[0-9a-f]{64}$/.test(existing)) return Buffer.from(existing, "hex");
  const hex = randomBytes(32).toString("hex");
  const add = Bun.spawnSync(
    ["security", "add-generic-password", "-s", "BobAgent", "-a", "vault-key", "-U", "-w", hex],
    { stdout: "ignore", stderr: "ignore" },
  );
  return add.exitCode === 0 ? Buffer.from(hex, "hex") : null;
}

export class Vault {
  private cachedKey: Buffer | null = null;

  constructor(
    private db: Database,
    private dataDir: string,
  ) {}

  private key(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    const env = process.env.BOBAGENT_VAULT_KEY;
    if (env && /^[0-9a-fA-F]{64}$/.test(env)) {
      this.cachedKey = Buffer.from(env, "hex");
      return this.cachedKey;
    }
    const kc = keychainKey();
    if (kc) {
      this.cachedKey = kc;
      return kc;
    }
    const file = join(this.dataDir, "vault.key");
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
    this.cachedKey = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    return this.cachedKey;
  }

  private row(name: string): Row | null {
    return this.db.query("SELECT * FROM vault WHERE name = ?").get(name) as Row | null;
  }

  list(): VaultEntry[] {
    const rows = this.db
      .query(
        "SELECT * FROM vault WHERE name NOT LIKE 'gateway.%' AND name NOT LIKE 'team.%' AND name NOT LIKE 'vmcred.%' ORDER BY name ASC",
      )
      .all() as Row[];
    return rows.map((r) => ({
      name: r.name,
      agentIds: JSON.parse(r.agent_ids) as string[],
      updatedAt: r.updated_at,
    }));
  }

  set(name: string, value: string, agentIds: string[]): void {
    if (!VAULT_NAME.test(name))
      throw new Error("secret names use letters, digits, '.', '_' or '-'");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([c.update(value, "utf8"), c.final(), c.getAuthTag()]).toString(
      "base64",
    );
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO vault (name, iv, data, agent_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, data = excluded.data, agent_ids = excluded.agent_ids, updated_at = excluded.updated_at`,
      )
      .run(name, iv.toString("hex"), data, JSON.stringify([...new Set(agentIds)]), now, now);
  }

  setAccess(name: string, agentIds: string[]): boolean {
    return (
      this.db
        .query("UPDATE vault SET agent_ids = ?, updated_at = ? WHERE name = ?")
        .run(JSON.stringify([...new Set(agentIds)]), Date.now(), name).changes > 0
    );
  }

  delete(name: string): boolean {
    return this.db.query("DELETE FROM vault WHERE name = ?").run(name).changes > 0;
  }

  allowed(agentId: string): string[] {
    return this.list()
      .filter((e) => e.agentIds.includes(agentId))
      .map((e) => e.name);
  }

  /** Daemon-internal secrets under `prefix` (names and timestamps only). */
  internalEntries(prefix: string): { name: string; updatedAt: number }[] {
    return (
      this.db
        .query("SELECT name, updated_at FROM vault WHERE substr(name, 1, ?) = ? ORDER BY name")
        .all(prefix.length, prefix) as { name: string; updated_at: number }[]
    ).map((r) => ({ name: r.name, updatedAt: r.updated_at }));
  }

  /** Decrypted value for daemon-internal use (gateway tokens); throws when missing. */
  revealInternal(name: string): string {
    const r = this.row(name);
    if (!r) throw new Error(`vault secret "${name}" is missing`);
    return this.decrypt(r);
  }

  private decrypt(r: Row): string {
    const buf = Buffer.from(r.data, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(r.iv, "hex"));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8");
  }

  /** Decrypted value if `agentId` is on the secret's allowlist, else throws. */
  reveal(name: string, agentId: string): string {
    const r = this.row(name);
    if (!r || !(JSON.parse(r.agent_ids) as string[]).includes(agentId)) {
      throw new Error(
        `no vault secret "${name}" is shared with you (ask the user to grant access)`,
      );
    }
    return this.decrypt(r);
  }
}
