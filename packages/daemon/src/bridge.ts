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
import type { Agent } from "@upbot/protocol";
import { ProviderId } from "@upbot/protocol";
import type { AgentStore } from "./agents";
import { type ApprovalService, GateRejection } from "./approvals";
import type { AppsService } from "./apps";
import type { BrowserService } from "./browser";
import type { ChannelService } from "./channels";
import type { ComputerUse } from "./computer";
import type { Connectors } from "./connectors";
import { avatarFor } from "./draft";
import type { EmailService, SearchQuery } from "./email";
import type { MemoryStore } from "./memories";
import type { PageLibrary } from "./pages";
import type { McpServerSpec } from "./providers/types";
import type { Broadcast } from "./rpc";
import type { RuntimeManager } from "./runtime/runtime-manager";
import type { SkillLibrary } from "./skills";
import type { SubagentService } from "./subagents";
import type { Vault } from "./vault";

// Local MCP bridge: each provider session gets a `upbot` stdio MCP server
// (`upbotd mcp-bridge`) that forwards tool calls to POST /bridge with a
// per-agent token, so agents can message each other and hand over files.

export const MAX_HOPS = 6;
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

type ToolResult = { text: string; isError?: boolean };
type Json = Record<string, unknown>;

export const BRIDGE_TOOLS = [
  {
    name: "list_agents",
    description:
      "List the other UpBot agents you can message (id, name, provider, status). Your own entry is marked you=true.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_message",
    description:
      "Send a message to another UpBot agent. It is queued and the agent handles it as a new turn; replies arrive as messages to you.",
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
    description: "List the UpBot channels you belong to, with owner, members and status.",
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
    name: "spawn_subagents",
    description:
      "Launch up to 8 subagents that work on independent tasks in parallel (each in its own session; on a Firecracker host each gets its own microVM). Returns immediately; when all of them finish you receive one <subagent_results> message. Subagents are deleted afterwards unless keep=true.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task: { type: "string", description: "Self-contained instructions" },
              name: { type: "string", description: "Short label" },
            },
            required: ["task"],
            additionalProperties: false,
          },
        },
        provider: { type: "string", description: "Provider id; defaults to your own" },
        keep: { type: "boolean", description: "Keep the subagents after they report" },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  {
    name: "list_subagents",
    description: "List your subagents with their status and results.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stop_subagent",
    description: "Stop one of your running subagents.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_agent",
    description: "Create a new UpBot agent with its own workspace.",
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
  {
    name: "page_publish",
    description:
      "Publish a self-contained HTML page (report, dashboard, tracker) to the user's Pages library. Inline all CSS/JS/images (data: URIs); pages cannot load anything from the network. Pass `id` to update an existing page.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing page id to update" },
        title: { type: "string" },
        description: { type: "string" },
        html: { type: "string", description: "Full HTML document" },
        file: {
          type: "string",
          description: "Or: path of an .html file in your or the shared workspace",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_pages",
    description: "List pages in the Pages library (id, title, version, author bot).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_page",
    description: "Read the HTML of a page so you can revise it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "request_secret",
    description:
      "Ask the user for a password, API key or token through a secure form. The value goes straight to the vault (never into the chat); you get access to it under `name`. Never ask for secrets in chat.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Vault name, e.g. stripe.key" },
        label: { type: "string", description: "What the user should enter" },
        reason: { type: "string", description: "Why you need it" },
      },
      required: ["name", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "request_takeover",
    description:
      "Ask the user to take over the UpBot browser window for sign-in, 2FA, CAPTCHA, payment or identity checks. Blocks until the user clicks Done.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "email_accounts",
    description: "List the email accounts the user connected that you may use.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "email_search",
    description:
      "Search an email account over IMAP. Returns the newest matches first (uid, from, to, subject, date, seen).",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account id, address or label; optional when only one",
        },
        mailbox: { type: "string", description: "Default INBOX" },
        text: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        since: { type: "string", description: "YYYY-MM-DD" },
        unseen: { type: "boolean" },
        limit: { type: "number", description: "1-100, default 20" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "email_read",
    description: "Read one email (headers, plain-text body, attachment names) by uid.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string" },
        mailbox: { type: "string" },
        uid: { type: "number" },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "email_draft",
    description:
      "Prepare an email for the user to review. You cannot send email: the user sees the draft, can edit it, and decides to Send or Discard. Use email_draft_status to check the outcome.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text" },
        replyToUid: { type: "number", description: "uid of the INBOX message this replies to" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "email_draft_status",
    description: "Status of drafts you created (pending, sent, discarded, failed).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Draft id; omit for your recent drafts" } },
      additionalProperties: false,
    },
  },
  ...(
    [
      [
        "browser_open",
        "Open an http(s) URL in your own tab of the UpBot browser.",
        { url: { type: "string" } },
        ["url"],
      ],
      [
        "browser_snapshot",
        "Read the current page: URL, title, numbered interactive elements and text.",
        {},
        [],
      ],
      [
        "browser_click",
        "Click an element by its [ref] number from browser_snapshot.",
        { ref: { type: "number" } },
        ["ref"],
      ],
      [
        "browser_type",
        "Type text into an input by [ref] (replaces its content); submit=true presses Enter.",
        { ref: { type: "number" }, text: { type: "string" }, submit: { type: "boolean" } },
        ["ref", "text"],
      ],
      [
        "browser_press",
        "Press a key in the page (Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, PageDown, PageUp).",
        { key: { type: "string" } },
        ["key"],
      ],
      ["browser_back", "Go back in your tab's history.", {}, []],
      [
        "browser_screenshot",
        "Save a PNG screenshot of your tab into your workspace and return its path.",
        {},
        [],
      ],
      ["browser_close", "Close your browser tab.", {}, []],
      ["vault_list", "List the names of vault secrets the user shared with you.", {}, []],
      [
        "vault_get",
        "Read a vault secret the user shared with you. Never print or store it in files you share.",
        { name: { type: "string" } },
        ["name"],
      ],
      [
        "github_api",
        "Call the GitHub REST API as the user (needs the connector.github vault secret shared with you).",
        { method: { type: "string" }, path: { type: "string" }, body: { type: "object" } },
        ["path"],
      ],
      [
        "onepassword_read",
        "Read a 1Password field by reference op://vault/item/field (needs connector.1password shared with you).",
        { reference: { type: "string" } },
        ["reference"],
      ],
      [
        "bitwarden_get",
        "Read a Bitwarden item field: password, username, notes, totp, uri or item (needs connector.bitwarden).",
        { item: { type: "string" }, field: { type: "string" } },
        ["item"],
      ],
      [
        "computer_screenshot",
        "Computer Use: screenshot the main display into your workspace.",
        {},
        [],
      ],
      [
        "computer_click",
        "Computer Use: click at screen point x,y (double=true for a double click).",
        { x: { type: "number" }, y: { type: "number" }, double: { type: "boolean" } },
        ["x", "y"],
      ],
      [
        "computer_type",
        "Computer Use: type text into the focused app.",
        { text: { type: "string" } },
        ["text"],
      ],
      [
        "computer_key",
        "Computer Use: press a key (letter/digit, return, tab, escape, arrows, ...) with optional modifiers.",
        { key: { type: "string" }, modifiers: { type: "array", items: { type: "string" } } },
        ["key"],
      ],
    ] as const
  ).map(([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  })),
] as const;

/** Command that runs this daemon build in `mcp-bridge` mode. */
export function bridgeCommand(): { command: string; args: string[] } {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
  return compiled
    ? { command: process.execPath, args: ["mcp-bridge"] }
    : { command: process.execPath, args: [Bun.main, "mcp-bridge"] };
}

const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * Log-safe description of a caught error and its `cause` chain: class and format-checked code
 * only. Never the message nor the stack: tools and app MCP servers may echo credentials into the
 * message, and the stack embeds it, so frame-shaped lines in it can be forged.
 */
type ErrorDiagnostics = {
  errorType: string;
  code?: string | number;
  cause?: ErrorDiagnostics;
};

export function errorDiagnostics(e: unknown, depth = 0): ErrorDiagnostics {
  if (!(e instanceof Error)) return { errorType: typeof e };
  const errorType = typeof e.name === "string" && ERROR_NAME.test(e.name) ? e.name : "Error";
  const out: ErrorDiagnostics = { errorType };
  const code = (e as { code?: unknown }).code;
  if (Number.isSafeInteger(code)) out.code = code as number;
  else if (typeof code === "string" && ERROR_CODE.test(code)) out.code = code;
  if (e.cause !== undefined && depth < 2) out.cause = errorDiagnostics(e.cause, depth + 1);
  return out;
}

export class Bridge {
  private tokens = new Map<string, string>();
  private byAgent = new Map<string, string>();
  port = 0;
  channels: ChannelService | null = null;
  memories: MemoryStore | null = null;
  browser: BrowserService | null = null;
  vault: Vault | null = null;
  email: EmailService | null = null;
  apps: AppsService | null = null;
  approvals: ApprovalService | null = null;
  pages: PageLibrary | null = null;
  connectors: Connectors | null = null;
  computer: ComputerUse | null = null;
  skills: SkillLibrary | null = null;
  broadcast: Broadcast | null = null;
  subagents: SubagentService | null = null;

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
        name: "upbot",
        command,
        args,
        env: {
          UPBOT_BRIDGE_URL: `http://127.0.0.1:${this.port}/bridge`,
          UPBOT_BRIDGE_TOKEN: this.tokenFor(agentId),
        },
      },
    ];
  }

  async handle(agentId: string, body: Json): Promise<Json> {
    if (body.method === "tools/list") {
      const appTools = await this.apps?.toolsFor(agentId).catch((e) => {
        console.error("[upbotd] bridge tools/list failed", { agentId, ...errorDiagnostics(e) });
        return [];
      });
      return { tools: [...BRIDGE_TOOLS, ...(appTools ?? [])] };
    }
    if (body.method !== "tools/call")
      throw new Error(`unknown bridge method ${String(body.method)}`);
    const params = (body.params ?? {}) as Json;
    const args = (params.arguments ?? {}) as Json;
    const startedAt = Date.now();
    let name = "";
    let isApp = false;
    let r: ToolResult;
    try {
      name = String(params.name);
      isApp = this.apps?.isAppTool(name) ?? false;
      await this.approvals?.gate(agentId, name, args, isApp);
      r =
        (isApp ? await this.apps!.call(agentId, name, args) : null) ??
        (await this.call(agentId, name, args));
    } catch (e) {
      console.error("[upbotd] bridge tool failed", {
        agentId,
        tool: name,
        isApp,
        durationMs: Date.now() - startedAt,
        reason: e instanceof GateRejection ? e.reason : "error",
        ...errorDiagnostics(e),
      });
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
          parent: this.subagents?.parentOf(a.id) ?? undefined,
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
      case "spawn_subagents": {
        const provider =
          typeof args.provider === "string" && args.provider ? args.provider : me.provider;
        if (!ProviderId.safeParse(provider).success)
          throw new Error(`unknown provider "${provider}"`);
        const tasks = Array.isArray(args.tasks)
          ? (args.tasks as Json[]).map((t) => ({
              task: typeof t?.task === "string" ? t.task : "",
              ...(typeof t?.name === "string" ? { name: t.name } : {}),
            }))
          : [];
        const r = this.subagents!.spawn(me, tasks, {
          provider: provider as Agent["provider"],
          keep: args.keep === true,
          hops: this.nextHops(me.id),
        });
        return {
          text: `launched ${r.agents.length} subagent(s), batch ${r.batchId}:\n${r.agents.map((a) => `- ${a.name} (${a.id})`).join("\n")}\nResults arrive as one <subagent_results> message.`,
        };
      }
      case "list_subagents":
        return { text: JSON.stringify(this.subagents!.list(me.id), null, 2) };
      case "stop_subagent":
        await this.subagents!.stop(me.id, String(args.id ?? ""));
        return { text: `stopped ${String(args.id ?? "")}` };
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
      case "page_publish": {
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        const opt = (k: string) => (str(args[k]) !== undefined ? { [k]: str(args[k])! } : {});
        const page = this.pages!.publish(me, {
          ...opt("id"),
          ...opt("title"),
          ...opt("description"),
          ...opt("html"),
          ...opt("file"),
        });
        return {
          text: `published "${page.title}" (id ${page.id}, version ${page.version}); the user can open it in UpBot → Pages. File: ${page.path}`,
        };
      }
      case "list_pages": {
        const names = new Map(this.agents.list().map((a) => [a.id, a.name]));
        return {
          text: JSON.stringify(
            this.pages!.list().map((p) => ({
              id: p.id,
              title: p.title,
              version: p.version,
              by: names.get(p.agentId) ?? "deleted bot",
              updatedAt: new Date(p.updatedAt).toISOString(),
            })),
          ),
        };
      }
      case "read_page": {
        const html = this.pages!.html(String(args.id ?? ""));
        return { text: html.length > 200_000 ? `${html.slice(0, 200_000)}\n…[truncated]` : html };
      }
      case "request_secret":
        return {
          text: await this.approvals!.requestSecret(
            me.id,
            String(args.name ?? ""),
            String(args.label ?? ""),
            String(args.reason ?? ""),
          ),
        };
      case "request_takeover":
        return { text: await this.approvals!.requestTakeover(me.id, String(args.reason ?? "")) };
      case "email_accounts":
        return {
          text: JSON.stringify(
            this.email!.accountsFor(me.id).map(({ id, label, address, provider }) => ({
              id,
              label,
              address,
              provider,
            })),
          ),
        };
      case "email_search": {
        const acct = this.email!.resolve(me.id, args.account);
        return { text: JSON.stringify(await this.email!.search(acct, args as SearchQuery)) };
      }
      case "email_read": {
        const acct = this.email!.resolve(me.id, args.account);
        const mailbox = typeof args.mailbox === "string" && args.mailbox ? args.mailbox : "INBOX";
        return { text: JSON.stringify(await this.email!.read(acct, Number(args.uid), mailbox)) };
      }
      case "email_draft": {
        const acct = this.email!.resolve(me.id, args.account);
        const list = (v: unknown) =>
          (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
            .map((x) => String(x).trim())
            .filter(Boolean);
        const to = list(args.to);
        const cc = list(args.cc);
        const bad = [...to, ...cc].find((x) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x));
        if (!to.length) throw new Error("`to` needs at least one address");
        if (bad) throw new Error(`not an email address: ${bad}`);
        let inReplyTo: string | null = null;
        let subject = String(args.subject ?? "");
        if (typeof args.replyToUid === "number") {
          const orig = await this.email!.read(acct, args.replyToUid);
          inReplyTo = orig.messageId;
          if (!/^re:/i.test(subject)) subject = subject || `Re: ${orig.subject}`;
        }
        const d = this.email!.createDraft(me.id, acct, {
          to,
          cc,
          subject,
          body: String(args.body ?? ""),
          inReplyTo,
        });
        return {
          text: `Draft ${d.id} is waiting for the user's review in UpBot. It is NOT sent; the user will Send or Discard it.`,
        };
      }
      case "email_draft_status": {
        const mine = this.email!.listDrafts({ agentId: me.id }).slice(0, 20);
        const pick = typeof args.id === "string" ? mine.filter((d) => d.id === args.id) : mine;
        return {
          text: JSON.stringify(
            pick.map(({ id, to, subject, status, error }) => ({ id, to, subject, status, error })),
          ),
        };
      }
      case "vault_list":
        return { text: JSON.stringify(this.vault!.allowed(me.id)) };
      case "vault_get":
        return { text: this.vault!.reveal(String(args.name ?? ""), me.id) };
      case "github_api":
        return { text: await this.connectors!.github(me.id, args) };
      case "onepassword_read":
        return { text: await this.connectors!.onePassword(me.id, String(args.reference ?? "")) };
      case "bitwarden_get":
        return {
          text: await this.connectors!.bitwarden(
            me.id,
            String(args.item ?? ""),
            String(args.field ?? "password"),
          ),
        };
      case "computer_screenshot":
        return { text: await this.computer!.screenshot(me) };
      case "computer_click":
        return { text: await this.computer!.click(me, args.x, args.y, args.double === true) };
      case "computer_type":
        return { text: await this.computer!.type(me, String(args.text ?? "")) };
      case "computer_key":
        return { text: await this.computer!.key(me, String(args.key ?? ""), args.modifiers) };
      case "browser_open":
        return { text: await this.browser!.open(me, String(args.url ?? "")) };
      case "browser_snapshot":
        return { text: await this.browser!.snapshot(me) };
      case "browser_click":
        return { text: await this.browser!.click(me, args.ref) };
      case "browser_type":
        return {
          text: await this.browser!.type(
            me,
            args.ref,
            String(args.text ?? ""),
            args.submit === true,
          ),
        };
      case "browser_press":
        return { text: await this.browser!.press(me, String(args.key ?? "")) };
      case "browser_back":
        return { text: await this.browser!.back(me) };
      case "browser_screenshot":
        return { text: await this.browser!.screenshot(me) };
      case "browser_close":
        return {
          text: (await this.browser!.closeTab(me.id)) ? "closed your tab" : "you had no open tab",
        };
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
