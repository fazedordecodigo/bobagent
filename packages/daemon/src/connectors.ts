import type { ChildProcess } from "node:child_process";
import { resolveCommand, spawnEnv } from "./env/login-path";
import { spawnChild } from "./env/spawn";
import { envStringArray } from "./env/vars";
import type { Vault } from "./vault";

// Connectors use vault secrets the agent was granted, without returning the secret itself:
// connector.github (token) -> GitHub REST proxy; connector.1password (optional service
// account token) -> `op read`; connector.bitwarden (BW_SESSION) -> `bw get`.

const OUTPUT_LIMIT = 50_000;
const BW_FIELDS = new Set(["password", "username", "notes", "totp", "uri", "item"]);

async function run(cmd: string[], env: Record<string, string>): Promise<string> {
  let proc: ChildProcess;
  try {
    proc = spawnChild(resolveCommand(cmd[0]!) ?? cmd[0]!, cmd.slice(1), {
      env: spawnEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`${cmd[0]} is not installed`);
  }
  const outPromise = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stdout?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (!proc.stdout) resolve("");
  });
  const errPromise = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (!proc.stderr) resolve("");
  });
  const codePromise = new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    const [out, err, code] = await Promise.all([outPromise, errPromise, codePromise]);
    if (code !== 0) throw new Error(`${cmd[0]} failed: ${(err || out).trim().slice(0, 500)}`);
    return out.trimEnd();
  } finally {
    clearTimeout(timer);
  }
}

export class Connectors {
  constructor(private vault: Vault) {}

  private secret(name: string, agentId: string): string {
    return this.vault.reveal(name, agentId);
  }

  async github(agentId: string, args: Record<string, unknown>): Promise<string> {
    const token = this.secret("connector.github", agentId);
    const method = String(args.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method))
      throw new Error("unsupported method");
    const path = String(args.path ?? "");
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("`path` must start with / (e.g. /user/repos)");
    const base = process.env.BOTO_GITHUB_API ?? "https://api.github.com";
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "Boto",
        ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: args.body !== undefined ? JSON.stringify(args.body) : null,
    });
    const text = (await res.text()).split(token).join("[redacted]");
    return `HTTP ${res.status}\n${text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[truncated]` : text}`;
  }

  async onePassword(agentId: string, reference: string): Promise<string> {
    const token = this.secret("connector.1password", agentId).trim();
    if (!/^op:\/\/[^\s]+$/.test(reference))
      throw new Error("`reference` must look like op://vault/item/field");
    return run([...(envStringArray("BOTO_OP_COMMAND") ?? ["op"]), "read", reference], {
      ...(token && token !== "desktop" ? { OP_SERVICE_ACCOUNT_TOKEN: token } : {}),
    });
  }

  async bitwarden(agentId: string, item: string, field: string): Promise<string> {
    const session = this.secret("connector.bitwarden", agentId).trim();
    if (!BW_FIELDS.has(field))
      throw new Error(`\`field\` must be one of ${[...BW_FIELDS].join(", ")}`);
    if (!item.trim()) throw new Error("`item` is required");
    return run([...(envStringArray("BOTO_BW_COMMAND") ?? ["bw"]), "get", field, item], {
      BW_SESSION: session,
    });
  }
}
