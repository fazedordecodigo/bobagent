import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { Vault } from "../src/vault";
import { DaemonClient, startDaemon, tmp, waitForExit } from "./helpers";

test.each([
  ["invalid JSON", "CorruptSecretSentinelJson"],
  [
    "invalid kind",
    JSON.stringify({
      kind: "CorruptSecretSentinelKind",
      value: "CorruptSecretSentinelValue",
    }),
  ],
])("credential RPC safely omits %s without logging secrets", async (_label, corrupt) => {
  const dataDir = tmp("vmcred-e2e-");
  const key = "ab".repeat(32);
  writeFileSync(join(dataDir, "vault.key"), key);
  const db = openDatabase(dataDir);
  try {
    new Vault(db, dataDir).set("vmcred.codex", corrupt, []);
  } finally {
    db.close();
  }

  const token = crypto.randomUUID();
  const daemon = await startDaemon(dataDir, tmp("vmcred-agents-"), token, {
    BOTO_VAULT_KEY: key,
  });
  const stderr = new Response(daemon.proc.stderr as ReadableStream<Uint8Array>).text();
  let client: DaemonClient | undefined;
  try {
    client = await DaemonClient.connect(daemon.port, token);
    expect(await client.request("vmCredentials.list")).toEqual([]);
    expect(await client.request("vault.list")).toEqual([]);
    const saved = await client.request("vmCredentials.set", {
      provider: "claude",
      kind: "api_key",
      value: "CorruptSecretSentinelValidKey",
    });
    expect(await client.request("vmCredentials.list")).toEqual([saved]);
    expect(saved).toMatchObject({ provider: "claude", kind: "api_key" });
    expect(JSON.stringify(saved)).not.toContain("CorruptSecretSentinel");
    await client.request("vmCredentials.delete", { provider: "codex" });
    expect(await client.request("vmCredentials.list")).toEqual([saved]);
  } finally {
    client?.close();
    daemon.proc.kill("SIGTERM");
    await waitForExit(daemon.proc, 5000);
  }
  const logs = await stderr;
  expect(logs).not.toContain("CorruptSecretSentinel");
  expect(logs).toContain("Boto could not read");
});
