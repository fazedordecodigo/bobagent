import type { Vault } from "./vault";

// Connectors use vault secrets the agent was granted, without returning the secret itself:
// connector.github (token) -> GitHub REST proxy; connector.1password (optional service
// account token) -> `op read`; connector.bitwarden (BW_SESSION) -> `bw get`.

const OUTPUT_LIMIT = 50_000;
const BW_FIELDS = new Set(["password", "username", "notes", "totp", "uri", "item"]);

function command(envName: string, fallback: string[]): string[] {
  const raw = process.env[envName];
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    } catch {}
  }
  return fallback;
}

async function run(cmd: string[], env: Record<string, string>): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch {
    throw new Error(`${cmd[0]} is not installed`);
  }
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${(err || out).trim().slice(0, 500)}`);
  return out.trimEnd();
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
    const base = process.env.BOBAGENT_GITHUB_API ?? "https://api.github.com";
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "BobAgent",
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
    return run([...command("BOBAGENT_OP_COMMAND", ["op"]), "read", reference], {
      ...(token && token !== "desktop" ? { OP_SERVICE_ACCOUNT_TOKEN: token } : {}),
    });
  }

  async bitwarden(agentId: string, item: string, field: string): Promise<string> {
    const session = this.secret("connector.bitwarden", agentId).trim();
    if (!BW_FIELDS.has(field))
      throw new Error(`\`field\` must be one of ${[...BW_FIELDS].join(", ")}`);
    if (!item.trim()) throw new Error("`item` is required");
    return run([...command("BOBAGENT_BW_COMMAND", ["bw"]), "get", field, item], {
      BW_SESSION: session,
    });
  }
}
