import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resetPathCache } from "../src/env/login-path";
import { loadVaultKey } from "../src/vault";

const originals = new Map<string, string | undefined>();
let root: string;

function setEnv(name: string, value: string | undefined) {
  if (!originals.has(name)) originals.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function testRoot() {
  root = mkdtempSync(join(tmpdir(), "upbot-vault-platform-"));
  return root;
}

function fakeSecretTool(
  directory: string,
  state: string,
  lookupSucceeds = true,
  timeoutOn?: "lookup" | "store",
) {
  const executable = join(directory, "secret-tool");
  const lookup =
    timeoutOn === "lookup"
      ? "exec /bin/sleep 30"
      : lookupSucceeds
        ? `[ -f "$SECRET_TOOL_STATE" ] || exit 1\n    /bin/cat "$SECRET_TOOL_STATE"`
        : "exit 1";
  const store = timeoutOn === "store" ? "exec /bin/sleep 30" : '/bin/cat > "$SECRET_TOOL_STATE"';
  writeFileSync(
    executable,
    `#!/bin/sh\nif [ "$1" = "lookup" ]; then\n  ${lookup}\nelif [ "$1" = "store" ]; then\n  ${store}\nfi\n`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  setEnv("SECRET_TOOL_STATE", state);
  setEnv("UPBOT_VAULT_KEY", undefined);
  setEnv("PATH", directory);
  setEnv("SHELL", "/bin/false");
  setEnv("HOME", directory);
  resetPathCache();
}

afterEach(() => {
  for (const [name, value] of originals) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originals.clear();
  resetPathCache();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Linux Secret Service vault key", () => {
  test.skipIf(process.platform !== "linux")("stores and verifies a key using secret-tool", () => {
    const directory = testRoot();
    const dataDir = join(directory, "data");
    const binDir = join(directory, "bin");
    const state = join(directory, "stored-key");
    const marker = join(dataDir, "vault.key.location");
    const storedKeyPath = join(dataDir, "vault.key");
    mkdirSync(binDir);
    fakeSecretTool(binDir, state);
    const key = loadVaultKey(dataDir, "linux");
    expect(key.toString("hex")).toBe(readFileSync(state, "utf8").trim());
    expect(readFileSync(marker, "utf8").trim()).toBe("secret-service");
    expect(existsSync(storedKeyPath)).toBe(false);
  });

  test.skipIf(process.platform !== "linux")(
    "does not replace a marked key when lookup fails",
    () => {
      const directory = testRoot();
      const dataDir = join(directory, "data");
      const binDir = join(directory, "bin");
      mkdirSync(dataDir);
      mkdirSync(binDir);
      writeFileSync(join(dataDir, "vault.key.location"), "secret-service\n");
      fakeSecretTool(binDir, join(directory, "stored-key"), false);
      expect(() => loadVaultKey(dataDir, "linux")).toThrow("could not be read from Secret Service");
      expect(existsSync(join(dataDir, "vault.key"))).toBe(false);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "does not replace a marked key when lookup times out",
    () => {
      const directory = testRoot();
      const dataDir = join(directory, "data");
      const binDir = join(directory, "bin");
      mkdirSync(dataDir);
      mkdirSync(binDir);
      writeFileSync(join(dataDir, "vault.key.location"), "secret-service\n");
      fakeSecretTool(binDir, join(directory, "stored-key"), true, "lookup");
      expect(() => loadVaultKey(dataDir, "linux")).toThrow("could not be read from Secret Service");
      expect(existsSync(join(dataDir, "vault.key"))).toBe(false);
    },
    15_000,
  );

  test.skipIf(process.platform !== "linux")(
    "falls back when secret-tool store times out",
    () => {
      const directory = testRoot();
      const dataDir = join(directory, "data");
      const binDir = join(directory, "bin");
      mkdirSync(binDir);
      fakeSecretTool(binDir, join(directory, "stored-key"), false, "store");
      const key = loadVaultKey(dataDir, "linux");
      const file = join(dataDir, "vault.key");
      expect(readFileSync(file, "utf8")).toBe(key.toString("hex"));
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
    15_000,
  );

  test.skipIf(process.platform !== "linux")(
    "uses an existing plaintext key without calling secret-tool",
    () => {
      const directory = testRoot();
      const dataDir = join(directory, "data");
      const binDir = join(directory, "bin");
      mkdirSync(dataDir);
      mkdirSync(binDir);
      const key = "a".repeat(64);
      writeFileSync(join(dataDir, "vault.key"), key, { mode: 0o600 });
      fakeSecretTool(binDir, join(directory, "stored-key"));
      expect(loadVaultKey(dataDir, "linux").toString("hex")).toBe(key);
      expect(existsSync(join(directory, "stored-key"))).toBe(false);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "falls back to a 0600 plaintext key without secret-tool",
    () => {
      const directory = testRoot();
      setEnv("UPBOT_VAULT_KEY", undefined);
      const dataDir = join(directory, "data");
      setEnv("PATH", join(directory, "empty-bin"));
      setEnv("SHELL", "/bin/false");
      setEnv("HOME", directory);
      resetPathCache();
      const key = loadVaultKey(dataDir, "linux");
      const file = join(dataDir, "vault.key");
      expect(readFileSync(file, "utf8")).toBe(key.toString("hex"));
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );
});

test.skipIf(process.platform !== "win32")(
  "Windows DPAPI vault key roundtrip",
  () => {
    const dataDir = join(testRoot(), "data");
    setEnv("UPBOT_VAULT_KEY", undefined);
    const first = loadVaultKey(dataDir, "win32");
    const second = loadVaultKey(dataDir, "win32");
    expect(second.equals(first)).toBe(true);
    expect(readFileSync(join(dataDir, "vault.key.dpapi"), "utf8")).not.toContain(
      first.toString("hex"),
    );
    expect(existsSync(join(dataDir, "vault.key.dpapi.tmp"))).toBe(false);
  },
  15_000,
);

test("logs the DPAPI failure cause and falls back to a plaintext key", () => {
  const directory = testRoot();
  const dataDir = join(directory, "data");
  mkdirSync(join(dataDir, "vault.key.dpapi.tmp"), { recursive: true });
  setEnv("UPBOT_VAULT_KEY", undefined);
  if (process.platform !== "win32") {
    mkdirSync(join(directory, "empty-bin"));
    setEnv("PATH", join(directory, "empty-bin"));
  }
  const error = spyOn(console, "error").mockImplementation(() => {});

  try {
    const key = loadVaultKey(dataDir, "win32");
    const keyHex = key.toString("hex");
    const file = join(dataDir, "vault.key");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatch(
      /^UpBot could not use Windows DPAPI \(.+\); storing the vault key in a plaintext file\.$/,
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(keyHex);
    expect(readFileSync(file, "utf8")).toBe(keyHex);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dataDir, "vault.key.dpapi"))).toBe(false);

    expect(loadVaultKey(dataDir, "win32").equals(key)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
  }
}, 15_000);

test.skipIf(process.platform !== "darwin")(
  "logs the keychain add failure before falling back",
  () => {
    const directory = testRoot();
    const dataDir = join(directory, "data");
    const binDir = join(directory, "bin");
    const logFile = join(directory, "security.log");
    const security = join(binDir, "security");
    mkdirSync(binDir);
    writeFileSync(
      security,
      '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$KEYCHAIN_TEST_LOG"\ncase "$1" in\n  find-generic-password) exit 44 ;;\n  add-generic-password) exit 45 ;;\nesac\nexit 0\n',
      { mode: 0o700 },
    );
    chmodSync(security, 0o700);
    setEnv("PATH", [binDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter));
    setEnv("KEYCHAIN_TEST_LOG", logFile);
    setEnv("UPBOT_VAULT_KEY", undefined);
    const error = spyOn(console, "error").mockImplementation(() => {});

    try {
      const key = loadVaultKey(dataDir, "darwin");
      const keyHex = key.toString("hex");
      const file = join(dataDir, "vault.key");
      expect(error.mock.calls.map(([message]) => message)).toEqual([
        "[upbotd] keychain add failed (exit 45)",
        "UpBot could not use the platform secure store; storing the vault key in a plaintext file.",
      ]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(keyHex);
      expect(readFileSync(file, "utf8")).toBe(keyHex);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const calls = readFileSync(logFile, "utf8").trim().split("\n");
      expect(calls).toEqual([
        "find-generic-password",
        "find-generic-password",
        "add-generic-password",
      ]);
    } finally {
      error.mockRestore();
    }
  },
);
