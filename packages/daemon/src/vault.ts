import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VaultEntry } from "@upbot/protocol";
import { resolveCommand } from "./env/login-path";

// Encrypted secret store (AES-256-GCM). The key uses the macOS Keychain, Windows DPAPI,
// or Linux Secret Service where available, with a warned plaintext-file fallback.
// UPBOT_VAULT_KEY (64 hex chars) overrides it for tests. Each secret has an agent
// allowlist; agents read allowed secrets with the vault_get bridge tool.

export const VAULT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

type Row = { name: string; iv: string; data: string; agent_ids: string; updated_at: number };

function keychainKey(): Buffer | null {
  if (process.platform !== "darwin") return null;
  const find = (service: string) => {
    const r = Bun.spawnSync(
      ["security", "find-generic-password", "-s", service, "-a", "vault-key", "-w"],
      { stderr: "ignore" },
    );
    const v = r.stdout.toString().trim();
    return r.exitCode === 0 && /^[0-9a-f]{64}$/.test(v) ? v : null;
  };
  const existing = find("UpBot");
  if (existing) return Buffer.from(existing, "hex");
  // vaults created before the rename keep their key under the old service name
  const hex = find("BobAgent") ?? randomBytes(32).toString("hex");
  const add = Bun.spawnSync(
    ["security", "add-generic-password", "-s", "UpBot", "-a", "vault-key", "-U", "-w", hex],
    { stdout: "ignore", stderr: "ignore" },
  );
  return add.exitCode === 0 ? Buffer.from(hex, "hex") : null;
}

function keyFromHex(value: string): Buffer | null {
  return /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : null;
}

function runSecretTool(command: string, args: string[], input?: string) {
  return spawnSync(command, args, {
    input,
    encoding: "utf8",
    windowsHide: process.platform === "win32",
    maxBuffer: 1024 * 1024,
  });
}

function secretServiceKey(dataDir: string): Buffer | null {
  const tool = resolveCommand("secret-tool");
  const marker = join(dataDir, "vault.key.location");
  if (!tool) {
    if (existsSync(marker)) {
      throw new Error(
        "The UpBot vault key is stored in Secret Service, but secret-tool is unavailable.",
      );
    }
    return null;
  }

  const lookup = () => {
    const result = runSecretTool(tool, ["lookup", "service", "UpBot", "account", "vault-key"]);
    return result.status === 0 ? keyFromHex(result.stdout.trim()) : null;
  };
  const existing = lookup();
  if (existing) {
    writeFileSync(marker, "secret-service\n", { mode: 0o600 });
    return existing;
  }
  if (existsSync(marker)) {
    throw new Error(
      "The UpBot vault key could not be read from Secret Service. Unlock or restore the keyring before starting UpBot.",
    );
  }

  const hex = randomBytes(32).toString("hex");
  const stored = runSecretTool(
    tool,
    ["store", "--label=UpBot vault key", "service", "UpBot", "account", "vault-key"],
    `${hex}\n`,
  );
  if (stored.status !== 0) return null;
  if (lookup()?.toString("hex") !== hex) return null;
  writeFileSync(marker, "secret-service\n", { mode: 0o600 });
  return Buffer.from(hex, "hex");
}

function protectWithDpapi(hex: string): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$hex = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [byte[]]::new([int]($hex.Length / 2))",
    "for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }",
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: hex,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw result.error ?? new Error(result.stderr.trim() || "Windows DPAPI encryption failed");
  }
  return result.stdout.trim();
}

function unprotectWithDpapi(value: string): Buffer {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$base64 = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($base64)",
    "$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToHexString($plain).ToLowerInvariant()",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: value,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr.trim() || "Windows DPAPI decryption failed");
  }
  const key = keyFromHex(result.stdout.trim());
  if (!key) throw new Error("Windows DPAPI returned an invalid UpBot vault key.");
  return key;
}

export function loadVaultKey(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): Buffer {
  const env = process.env.UPBOT_VAULT_KEY;
  if (env && /^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, "hex");

  if (platform === "darwin") {
    const key = keychainKey();
    if (key) return key;
  }

  const file = join(dataDir, "vault.key");
  if (existsSync(file)) {
    const key = keyFromHex(readFileSync(file, "utf8").trim());
    if (!key) throw new Error("The UpBot vault key file is invalid.");
    return key;
  }

  mkdirSync(dataDir, { recursive: true });
  if (platform === "win32") {
    const protectedFile = join(dataDir, "vault.key.dpapi");
    if (existsSync(protectedFile)) {
      try {
        return unprotectWithDpapi(readFileSync(protectedFile, "utf8").trim());
      } catch (error) {
        throw new Error("The UpBot vault key could not be decrypted with Windows DPAPI.", {
          cause: error,
        });
      }
    }
    const key = randomBytes(32);
    try {
      writeFileSync(protectedFile, protectWithDpapi(key.toString("hex")), { mode: 0o600 });
      return key;
    } catch {
      console.error(
        "UpBot could not use Windows DPAPI; storing the vault key in a plaintext file.",
      );
      writeFileSync(file, key.toString("hex"), { mode: 0o600 });
      return key;
    }
  }

  if (platform === "linux") {
    const key = secretServiceKey(dataDir);
    if (key) return key;
  }

  console.error(
    "UpBot could not use the platform secure store; storing the vault key in a plaintext file.",
  );
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  return key;
}

export class Vault {
  private cachedKey: Buffer | null = null;

  constructor(
    private db: Database,
    private dataDir: string,
  ) {}

  private key(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    this.cachedKey = loadVaultKey(this.dataDir);
    return this.cachedKey;
  }

  private row(name: string): Row | null {
    return this.db.query("SELECT * FROM vault WHERE name = ?").get(name) as Row | null;
  }

  list(): VaultEntry[] {
    const rows = this.db
      .query(
        "SELECT * FROM vault WHERE name NOT LIKE 'gateway.%' AND name NOT LIKE 'team.%' AND name NOT LIKE 'vmcred.%' AND name NOT LIKE 'email.%' AND name NOT LIKE 'app.%' ORDER BY name ASC",
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
