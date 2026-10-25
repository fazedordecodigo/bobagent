import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Agent } from "@bobagent/protocol";
import type { AgentStore } from "./agents";
import type { McpServerSpec } from "./providers/types";
import type { RuntimeManager } from "./runtime/runtime-manager";

// Local MCP bridge: each provider session gets a `bobagent` stdio MCP server
// (`bobagentd mcp-bridge`) that forwards tool calls to POST /bridge with a
// per-agent token, so agents can message each other and hand over files.

export const MAX_HOPS = 6;
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

type ToolResult = { text: string; isError?: boolean };
type Json = Record<string, unknown>;

export const BRIDGE_TOOLS = [
  {
    name: "list_agents",
    description:
      "List the other BobAgent agents you can message (id, name, provider, status). Your own entry is marked you=true.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_message",
    description:
      "Send a message to another BobAgent agent. It is queued and the agent handles it as a new turn; replies arrive as messages to you.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent name or id" },
        text: { type: "string", description: "Message text" },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "share_file",
    description:
      "Copy a file from your workspace to another agent's workspace (transfers/<id>/<name>) and notify it. Records a SHA-256 manifest.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent name or id" },
        path: { type: "string", description: "File path, relative to your workspace" },
        note: { type: "string", description: "Optional note for the recipient" },
      },
      required: ["to", "path"],
      additionalProperties: false,
    },
  },
] as const;

/** Command that runs this daemon build in `mcp-bridge` mode. */
export function bridgeCommand(): { command: string; args: string[] } {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
  return compiled
    ? { command: process.execPath, args: ["mcp-bridge"] }
    : { command: process.execPath, args: [Bun.main, "mcp-bridge"] };
}

export class Bridge {
  private tokens = new Map<string, string>();
  private byAgent = new Map<string, string>();
  port = 0;

  constructor(
    private agents: AgentStore,
    private runtimes: () => RuntimeManager,
    private sharedRoot: string,
  ) {}

  tokenFor(agentId: string): string {
    let t = this.byAgent.get(agentId);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.byAgent.set(agentId, t);
      this.tokens.set(t, agentId);
    }
    return t;
  }

  agentForToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  serversFor(agentId: string): McpServerSpec[] {
    if (!this.port) return [];
    const { command, args } = bridgeCommand();
    return [
      {
        name: "bobagent",
        command,
        args,
        env: {
          BOBAGENT_BRIDGE_URL: `http://127.0.0.1:${this.port}/bridge`,
          BOBAGENT_BRIDGE_TOKEN: this.tokenFor(agentId),
        },
      },
    ];
  }

  async handle(agentId: string, body: Json): Promise<Json> {
    if (body.method === "tools/list") return { tools: BRIDGE_TOOLS };
    if (body.method !== "tools/call")
      throw new Error(`unknown bridge method ${String(body.method)}`);
    const params = (body.params ?? {}) as Json;
    const args = (params.arguments ?? {}) as Json;
    let r: ToolResult;
    try {
      r = await this.call(agentId, String(params.name), args);
    } catch (e) {
      r = { text: (e as Error).message, isError: true };
    }
    return { content: [{ type: "text", text: r.text }], isError: r.isError === true };
  }

  private self(agentId: string): Agent {
    const a = this.agents.get(agentId);
    if (!a) throw new Error("your agent no longer exists");
    return a;
  }

  private resolveTarget(selfId: string, to: unknown): Agent {
    const key = typeof to === "string" ? to.trim() : "";
    if (!key) throw new Error("`to` is required");
    const all = this.agents.list().filter((a) => a.id !== selfId);
    const byId = all.find((a) => a.id === key);
    if (byId) return byId;
    const byName = all.filter((a) => a.name.toLowerCase() === key.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw new Error(`more than one agent is named "${key}"; use its id`);
    throw new Error(`no agent named "${key}" (use list_agents)`);
  }

  private nextHops(agentId: string): number {
    const hops = this.runtimes().currentHops(agentId) + 1;
    if (hops > MAX_HOPS) {
      throw new Error(
        `message chain limit reached (${MAX_HOPS} agent-to-agent hops); stop and report back`,
      );
    }
    return hops;
  }

  private async call(agentId: string, name: string, args: Json): Promise<ToolResult> {
    const me = this.self(agentId);
    switch (name) {
      case "list_agents": {
        const statuses = this.runtimes().statuses();
        const list = this.agents.list().map((a) => ({
          id: a.id,
          name: a.name,
          provider: a.provider,
          status: statuses[a.id]?.status ?? "idle",
          you: a.id === me.id,
        }));
        return { text: JSON.stringify(list, null, 2) };
      }
      case "send_message": {
        const target = this.resolveTarget(me.id, args.to);
        const text = typeof args.text === "string" ? args.text : "";
        if (!text.trim()) throw new Error("`text` is required");
        const hops = this.nextHops(me.id);
        const { queueId } = this.runtimes().sendFrom(target.id, text, { agentId: me.id, hops });
        return { text: `queued for ${target.name} (queueId ${queueId})` };
      }
      case "share_file":
        return this.shareFile(me, args);
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  private shareFile(me: Agent, args: Json): ToolResult {
    const target = this.resolveTarget(me.id, args.to);
    const rel = typeof args.path === "string" ? args.path : "";
    if (!rel) throw new Error("`path` is required");
    const wsReal = realpathSync(me.workspacePath);
    let src: string;
    try {
      src = realpathSync(isAbsolute(rel) ? rel : resolve(me.workspacePath, rel));
    } catch {
      throw new Error(`file not found: ${rel}`);
    }
    if (src !== wsReal && !src.startsWith(wsReal + sep)) {
      throw new Error("only files inside your workspace can be shared");
    }
    const st = statSync(src);
    if (!st.isFile()) throw new Error("only regular files can be shared");
    if (st.size > MAX_TRANSFER_BYTES)
      throw new Error(`file is larger than ${MAX_TRANSFER_BYTES} bytes`);
    const hops = this.nextHops(me.id);

    const id = crypto.randomUUID();
    const name = basename(src);
    const storeDir = join(this.sharedRoot, "Transfers", id);
    mkdirSync(storeDir, { recursive: true });
    copyFileSync(src, join(storeDir, name));
    const sha256 = createHash("sha256").update(readFileSync(src)).digest("hex");
    const destDir = join(target.workspacePath, "transfers", id);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, join(destDir, name));
    const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : null;
    const manifest = {
      id,
      from: { agentId: me.id, name: me.name },
      to: { agentId: target.id, name: target.name },
      file: { name, size: st.size, sha256, sourcePath: relative(wsReal, src) },
      deliveredPath: join("transfers", id, name),
      note,
      createdAt: Date.now(),
    };
    writeFileSync(join(storeDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const msg = [
      `Shared a file with you: ${manifest.deliveredPath} (${st.size} bytes, sha256 ${sha256}).`,
      note ? `Note: ${note}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    this.runtimes().sendFrom(target.id, msg, { agentId: me.id, hops });
    return {
      text: JSON.stringify({
        transferId: id,
        sha256,
        deliveredTo: target.name,
        path: manifest.deliveredPath,
      }),
    };
  }
}
