import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPlacement, RemoteHost } from "@boto/protocol";
import { openDatabase } from "../src/db";
import { VmCredentials } from "../src/remote/credentials";
import { remoteLaunch } from "../src/remote/hosts";
import { Vault } from "../src/vault";
import { tmp } from "./helpers";

const host: RemoteHost = {
  id: "h1",
  name: "vps",
  target: "me@vps",
  port: 22,
  identityFile: null,
  root: "/home/me/.boto",
  preflight: null,
  createdAt: 0,
};
const placement = (isolation: AgentPlacement["isolation"]): AgentPlacement => ({
  agentId: "a1",
  hostId: "h1",
  isolation,
  vcpus: 2,
  memMib: 2048,
});

describe("microVM credentials", () => {
  const prevSsh = process.env.BOTO_SSH_COMMAND;
  const prevKey = process.env.BOTO_VAULT_KEY;
  process.env.BOTO_VAULT_KEY = "ab".repeat(32);
  const dataDir = tmp("vmcred-");
  const db = openDatabase(dataDir);
  const vault = new Vault(db, dataDir);
  const creds = new VmCredentials(vault);

  afterAll(() => {
    if (prevSsh === undefined) delete process.env.BOTO_SSH_COMMAND;
    else process.env.BOTO_SSH_COMMAND = prevSsh;
    if (prevKey === undefined) delete process.env.BOTO_VAULT_KEY;
    else process.env.BOTO_VAULT_KEY = prevKey;
  });

  test("stores logins hidden from the vault and maps them to provider env", () => {
    creds.set("claude", "oauth_token", "sk-ant-oat01-test");
    creds.set("codex", "api_key", "sk-proj-test");
    expect(vault.list().map((e) => e.name)).toEqual([]);
    const list = creds.list();
    expect(list.map((c) => [c.provider, c.kind])).toEqual([
      ["claude", "oauth_token"],
      ["codex", "api_key"],
    ]);
    expect(JSON.stringify(list)).not.toContain("sk-");
    expect(creds.env("claude")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" });
    expect(creds.env("codex")).toEqual({
      OPENAI_API_KEY: "sk-proj-test",
      CODEX_API_KEY: "sk-proj-test",
    });
    creds.set("gemini", "api_key", "gm-test-key");
    creds.set("cursor", "api_key", "cur-test-key");
    expect(creds.env("gemini")).toEqual({ GEMINI_API_KEY: "gm-test-key" });
    expect(creds.env("cursor")).toEqual({ CURSOR_API_KEY: "cur-test-key" });
    expect(() => creds.set("gemini", "oauth_token", "x-token-123")).toThrow();
    creds.delete("gemini");
    creds.delete("cursor");
    expect(creds.env("devin")).toEqual({});
    expect(() => creds.set("codex", "oauth_token", "x".repeat(10))).toThrow();
    creds.delete("codex");
    expect(creds.env("codex")).toEqual({});
  });

  async function specFor(isolation: AgentPlacement["isolation"]) {
    const out = join(tmp("vmcred-ssh-"), "spec.json");
    process.env.BOTO_SSH_COMMAND = JSON.stringify(["sh", "-c", `head -n 1 > ${out}`, "fake-ssh"]);
    const launch = remoteLaunch(host, placement(isolation), 0, creds.env("claude"));
    const child = launch.spawn(["claude", "--verbose"], { NO_COLOR: "1" });
    child.stdin?.end();
    await new Promise((r) => child.on("close", r));
    return {
      launch,
      spec: JSON.parse(readFileSync(out, "utf8")) as { env: Record<string, string> },
    };
  }

  test.skipIf(process.platform === "win32")(
    "injects credentials into microVM run specs only",
    async () => {
      const vm = await specFor("firecracker");
      expect(vm.spec.env).toEqual({ NO_COLOR: "1", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" });
      expect(vm.launch.credentials.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test");
      const proc = await specFor("none");
      expect(proc.spec.env).toEqual({ NO_COLOR: "1" });
      expect(proc.launch.credentials).toEqual({});
    },
  );

  test("logs and reads corrupt or undecryptable stored entries as absent", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(creds.env("codex")).toEqual({});
      expect(err).not.toHaveBeenCalled();

      vault.set("vmcred.codex", "corrupt-json-secret-sentinel", []);
      expect(creds.env("codex")).toEqual({});
      expect(creds.list().map((c) => c.provider)).not.toContain("codex");
      expect(err.mock.calls).toEqual([
        [
          "Boto could not read a stored microVM credential",
          { provider: "codex", reason: "invalid_entry" },
        ],
        [
          "Boto could not read a stored microVM credential",
          { provider: "codex", reason: "invalid_entry" },
        ],
      ]);
      err.mockClear();

      vault.set(
        "vmcred.codex",
        JSON.stringify({ kind: "corrupt-kind-secret-sentinel", value: "x" }),
        [],
      );
      expect(creds.env("codex")).toEqual({});
      expect(err.mock.calls).toEqual([
        [
          "Boto could not read a stored microVM credential",
          { provider: "codex", reason: "invalid_entry" },
        ],
      ]);
      err.mockClear();

      db.query("UPDATE vault SET data = ? WHERE name = ?").run("AAAA", "vmcred.codex");
      expect(creds.env("codex")).toEqual({});
      expect(err.mock.calls).toEqual([
        [
          "Boto could not read a stored microVM credential",
          { provider: "codex", reason: "invalid_entry" },
        ],
      ]);
    } finally {
      err.mockRestore();
      creds.delete("codex");
    }
  });
});
