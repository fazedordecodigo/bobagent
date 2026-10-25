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
import { ProviderId } from "@bobagent/protocol";
import type { AgentStore } from "./agents";
import type { ChannelService } from "./channels";
import { avatarFor } from "./draft";
import type { MemoryStore } from "./memories";
import type { McpServerSpec } from "./providers/types";
import type { Broadcast } from "./rpc";
import type { RuntimeManager } from "./runtime/runtime-manager";
import type { SkillLibrary } from "./skills";

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
  {
    name: "list_channels",
    description: "List the BobAgent channels you belong to, with owner, members and status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delegate",
    description:
      "Delegate a task to another member of a channel. Their reply is posted to the channel and forwarded to the owner.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name or id" },
        to: { type: "string", description: "Member agent name or id" },
        task: { type: "string", description: "What the member should do" },
      },
      required: ["channel", "to", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "remember",
    description:
      "Save a durable memory for yourself; it is shown to you at the start of future sessions.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "Delete one of your memories by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_memories",
    description: "List your saved memories with their ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_skills",
    description: "List the shared local skills library (name + description).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_skill",
    description: "Read the full instructions of a skill from the library.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "create_skill",
    description: "Save a new reusable skill (markdown instructions) to the shared library.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case name" },
        description: { type: "string", description: "When to use this skill (one line)" },
        body: { type: "string", description: "Markdown instructions" },
      },
      required: ["name", "description", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "revise_skill",
    description:
      "Replace the instructions of an existing skill; the previous version is kept in history.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        body: { type: "string" },
        description: { type: "string" },
      },
      required: ["name", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "create_agent",
    description: "Create a new BobAgent agent with its own workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        provider: { type: "string", description: "Provider id; defaults to your own provider" },
        instructions: { type: "string" },
        emoji: { type: "string", description: "Avatar emoji" },
      },
      required: ["name", "instructions"],
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
  channels: ChannelService | null = null;
  memories: MemoryStore | null = null;
  skills: SkillLibrary | null = null;
  broadcast: Broadcast | null = null;

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
      case "remember": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text || text.length > 2000) throw new Error("`text` must be 1-2000 characters");
        const m = this.memories!.add(me.id, text);
        this.broadcast?.("memories.changed", { agentId: me.id });
        return { text: `remembered [${m.id}]` };
      }
      case "forget": {
        const m = this.memories!.get(String(args.id ?? ""));
        if (!m || m.agentId !== me.id)
          throw new Error(`no memory with id "${String(args.id ?? "")}"`);
        this.memories!.delete(m.id);
        this.broadcast?.("memories.changed", { agentId: me.id });
        return { text: `forgot [${m.id}]` };
      }
      case "list_memories":
        return {
          text: JSON.stringify(
            this.memories!.list(me.id).map((m) => ({ id: m.id, text: m.text })),
            null,
            2,
          ),
        };
      case "list_skills":
        return {
          text: JSON.stringify(
            this.skills!.list().map((s) => ({ name: s.name, description: s.description })),
            null,
            2,
          ),
        };
      case "read_skill": {
        const s = this.skills!.get(String(args.name ?? ""));
        if (!s) throw new Error(`no skill named "${String(args.name ?? "")}"`);
        return { text: `# ${s.name}\n${s.description}\n\n${s.body}` };
      }
      case "create_skill":
      case "revise_skill": {
        const existing = name === "revise_skill" ? this.skills!.get(String(args.name ?? "")) : null;
        const s = this.skills!.save(
          {
            name: String(args.name ?? ""),
            description:
              typeof args.description === "string"
                ? args.description
                : (existing?.description ?? ""),
            body: typeof args.body === "string" ? args.body : "",
            author: me.name,
          },
          name === "create_skill" ? "create" : "revise",
        );
        this.broadcast?.("skills.changed", {});
        return { text: `${name === "create_skill" ? "created" : "revised"} skill ${s.name}` };
      }
      case "create_agent": {
        const agentName = typeof args.name === "string" ? args.name.trim() : "";
        if (!agentName || agentName.length > 80) throw new Error("`name` must be 1-80 characters");
        const provider =
          typeof args.provider === "string" && args.provider ? args.provider : me.provider;
        if (!ProviderId.safeParse(provider).success)
          throw new Error(`unknown provider "${provider}"`);
        const instructions = typeof args.instructions === "string" ? args.instructions : "";
        const avatar = avatarFor(`${agentName} ${instructions}`);
        if (typeof args.emoji === "string" && args.emoji.trim())
          avatar.emoji = args.emoji.trim().slice(0, 16);
        const created = this.agents.create({
          name: agentName,
          provider: provider as Agent["provider"],
          instructions,
          avatar,
        });
        this.broadcast?.("agent.created", created);
        return { text: `created agent ${created.name} (${created.id}, ${created.provider})` };
      }
      case "list_channels": {
        const chans = (this.channels?.forAgent(me.id) ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          owner: c.ownerId ? (this.agents.get(c.ownerId)?.name ?? null) : null,
          members: c.memberIds.map((id) => this.agents.get(id)?.name ?? id),
          youAreOwner: c.ownerId === me.id,
        }));
        return { text: JSON.stringify(chans, null, 2) };
      }
      case "delegate": {
        if (!this.channels) throw new Error("channels are unavailable");
        const task = typeof args.task === "string" ? args.task : "";
        if (!task.trim()) throw new Error("`task` is required");
        const hops = this.nextHops(me.id);
        return {
          text: this.channels.delegate(
            me.id,
            String(args.channel ?? ""),
            String(args.to ?? ""),
            task,
            hops,
          ),
        };
      }
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
