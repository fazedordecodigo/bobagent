import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ConfigOption, ProviderId } from "@openagent/protocol";
import { resolveCommand, spawnEnv } from "../env/login-path";
import {
  type NormalizedUpdate,
  type ProviderDriver,
  ProviderError,
  type ProviderHooks,
  type ProviderSession,
} from "./types";

const ACP_COMMANDS: Partial<Record<ProviderId, string[]>> = {
  devin: ["devin", "acp"],
  cursor: ["agent", "acp"],
  grok: ["grok", "agent", "stdio"],
  opencode: ["opencode", "acp"],
  gemini: ["gemini", "--experimental-acp"],
};

const STDERR_TAIL_LINES = 50;

// Task A probe result: the default mode per provider (never bypass/auto-approve).
export const DEFAULT_MODE: Partial<Record<ProviderId, string>> = {
  devin: "accept-edits",
  cursor: "agent",
  opencode: "build",
};

function redactSecrets(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt-redacted>")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "<redacted>",
    );
}

function commandFor(provider: ProviderId): string[] | null {
  const override =
    process.env[`OPENAGENT_ACP_COMMAND_${provider.toUpperCase().replace(/-/g, "_")}`];
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) return parsed;
    } catch {}
  }
  return ACP_COMMANDS[provider] ?? null;
}

const AUTH_RE =
  /\b(auth(entication)?[ _-]?required|unauthori[sz]ed|not (logged|signed) in|log ?in required|sign ?in required)\b/i;

const LOGIN_COMMANDS: Partial<Record<ProviderId, string>> = {
  devin: "devin auth login",
  cursor: "agent login",
  grok: "grok login",
  opencode: "opencode auth login",
  gemini: "gemini",
};

function isAuthError(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  if (err?.code === -32000) return true;
  return AUTH_RE.test(err?.message ?? "");
}

function authMessage(provider: ProviderId, e: unknown): string {
  const detail = (e as { message?: string })?.message ?? "";
  const loginCmd = LOGIN_COMMANDS[provider] ?? "its login command";
  return `${provider} requires sign-in. Run \`${loginCmd}\` in a terminal.${detail ? ` (${detail})` : ""}`;
}

type RawConfigOption = {
  id?: string;
  name?: string;
  category?: string | null;
  currentValue?: string;
  options?: (
    | { value?: string; name?: string; description?: string | null }
    | { options?: { value?: string; name?: string; description?: string | null }[] }
  )[];
};

function normalizeConfigOptions(src: { configOptions?: unknown }): ConfigOption[] {
  const out: ConfigOption[] = [];
  for (const o of (src.configOptions ?? []) as RawConfigOption[]) {
    if (!o?.id) continue;
    const flat: { value: string; name: string; description: string | null }[] = [];
    for (const opt of o.options ?? []) {
      if ("value" in opt && opt.value !== undefined) {
        flat.push({
          value: opt.value,
          name: opt.name ?? opt.value,
          description: opt.description ?? null,
        });
      } else if ("options" in opt && Array.isArray(opt.options)) {
        for (const sub of opt.options) {
          if (sub.value !== undefined) {
            flat.push({
              value: sub.value,
              name: sub.name ?? sub.value,
              description: sub.description ?? null,
            });
          }
        }
      }
    }
    out.push({
      id: o.id,
      name: o.name ?? o.id,
      category: o.category ?? null,
      currentValue: o.currentValue ?? "",
      options: flat,
    });
  }
  return out;
}

type ToolCallContent = {
  type?: string;
  content?: { type?: string; text?: string };
  path?: string;
};

type SessionUpdatePayload = {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  content2?: never;
  locations?: { path?: string }[];
  currentModeId?: string;
  configOptions?: unknown;
};

function toolDetail(u: { content?: unknown; locations?: { path?: string }[] }): string | null {
  const parts: string[] = [];
  const content = u.content;
  if (Array.isArray(content)) {
    for (const c of content as ToolCallContent[]) {
      if (c?.type === "content" && c.content?.type === "text" && c.content.text) {
        parts.push(c.content.text);
      } else if (c?.type === "diff" && c.path) {
        parts.push(c.path);
      }
    }
  }
  for (const loc of u.locations ?? []) {
    if (loc?.path) parts.push(loc.path);
  }
  const joined = parts.join("\n").trim();
  return joined ? joined.slice(0, 2000) : null;
}

function mapUpdate(params: unknown): NormalizedUpdate {
  const u = (params as { update?: SessionUpdatePayload })?.update ?? {};
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      if (u.content?.type === "text" && u.content.text) {
        return { type: "message_chunk", text: u.content.text };
      }
      return { type: "ignored", kind: "agent_message_chunk" };
    case "agent_thought_chunk":
      if (u.content?.type === "text" && u.content.text) {
        return { type: "thought_chunk", text: u.content.text };
      }
      return { type: "ignored", kind: "agent_thought_chunk" };
    case "tool_call":
      return {
        type: "tool_call",
        toolCallId: u.toolCallId ?? "",
        title: u.title ?? "",
        toolKind: u.kind ?? null,
        status: (u.status as never) ?? "pending",
        detail: toolDetail(u),
      };
    case "tool_call_update": {
      const out: Extract<NormalizedUpdate, { type: "tool_call_update" }> = {
        type: "tool_call_update",
        toolCallId: u.toolCallId ?? "",
      };
      if (u.title !== undefined) out.title = u.title;
      if (u.status !== undefined) out.status = u.status as never;
      const d = toolDetail(u);
      if (d !== null) out.detail = d;
      return out;
    }
    case "config_option_update":
      return { type: "config_update", configOptions: normalizeConfigOptions(u) };
    case "current_mode_update":
      return { type: "mode_update", modeId: String(u.currentModeId ?? "") };
    default:
      return { type: "ignored", kind: u.sessionUpdate ?? "unknown" };
  }
}

class AcpSession implements ProviderSession {
  private closed = false;
  configOptions: ConfigOption[] = [];
  constructor(
    readonly sessionId: string,
    readonly resumed: boolean,
    private conn: acp.ClientConnection,
    private child: ChildProcess,
    _hooks: ProviderHooks,
  ) {}

  async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
    const res = (await this.conn.agent.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    } as never)) as { configOptions?: unknown };
    const opts = normalizeConfigOptions(res ?? {});
    if (opts.length > 0) this.configOptions = opts;
    return this.configOptions;
  }

  async prompt(text: string): Promise<{ stopReason: string }> {
    const res = (await this.conn.agent.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    } as never)) as { stopReason?: string };
    return { stopReason: res.stopReason ?? "end_turn" };
  }

  async cancel(): Promise<void> {
    try {
      await this.conn.agent.notify("session/cancel", { sessionId: this.sessionId } as never);
    } catch {}
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.conn.close();
    } catch {}
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }
}

export class AcpDriver implements ProviderDriver {
  constructor(private provider: ProviderId) {}

  async start(opts: {
    cwd: string;
    resumeSessionId: string | null;
    hooks: ProviderHooks;
  }): Promise<ProviderSession> {
    const { cwd, resumeSessionId, hooks } = opts;
    const cmd = commandFor(this.provider);
    if (!cmd) {
      throw new ProviderError("provider_unavailable", `${this.provider} is not supported yet`);
    }
    const bin = resolveCommand(cmd[0]!);
    if (!bin) {
      throw new ProviderError(
        "provider_unavailable",
        `\`${cmd[0]}\` not found in PATH (provider: ${this.provider})`,
      );
    }

    const stderrLines: string[] = [];
    const child = spawn(bin, cmd.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv({ NO_COLOR: "1" }),
    });
    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split("\n")) stderrLines.push(line);
      if (stderrLines.length > STDERR_TAIL_LINES * 2) {
        stderrLines.splice(0, stderrLines.length - STDERR_TAIL_LINES);
      }
    });

    let exited = false;
    let closedByUs = false;
    child.on("exit", (code, signal) => {
      exited = true;
      if (!closedByUs) {
        const tail = redactSecrets(stderrLines.slice(-STDERR_TAIL_LINES).join("\n")).trim();
        hooks.onExit(
          `process exited (code ${code ?? "null"}, signal ${signal ?? "null"})${tail ? `: ${tail}` : ""}`,
        );
      }
    });

    const stdoutNode = child.stdout!;
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(stdoutNode) as unknown as ReadableStream<Uint8Array>,
    );

    let loading = false;
    const app = acp
      .client({ name: "openagent" })
      .onRequest("session/request_permission", async (ctx) => {
        const p = ctx.params as {
          toolCall?: { title?: string; kind?: string };
          options?: { optionId: string; name: string; kind: string }[];
        };
        const res = await hooks.requestPermission({
          title: p.toolCall?.title ?? "Permission request",
          toolKind: p.toolCall?.kind ?? null,
          options: (p.options ?? []).map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind as never,
          })),
        });
        if (res.optionId === null) {
          return { outcome: { outcome: "cancelled" } } as never;
        }
        return { outcome: { outcome: "selected", optionId: res.optionId } } as never;
      })
      .onNotification("session/update", async (ctx) => {
        if (loading) return;
        hooks.onUpdate(mapUpdate(ctx.params));
      });

    const conn = app.connect(stream);
    conn.closed.catch(() => {});
    conn.closed.then(() => {
      if (!exited && !closedByUs) hooks.onExit("connection closed unexpectedly");
    });

    const init = async () => {
      try {
        return (await conn.agent.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "openagent", version: "0.1.0" },
        } as never)) as {
          agentCapabilities?: { loadSession?: boolean };
        };
      } catch (e) {
        if (isAuthError(e)) throw new ProviderError("auth_required", authMessage(this.provider, e));
        throw e;
      }
    };

    let initRes: Awaited<ReturnType<typeof init>>;
    try {
      initRes = await init();
    } catch (e) {
      closedByUs = true;
      child.kill("SIGKILL");
      if (e instanceof ProviderError) throw e;
      if (exited) {
        const tail = redactSecrets(stderrLines.slice(-STDERR_TAIL_LINES).join("\n")).trim();
        throw new ProviderError(
          "provider_unavailable",
          `${this.provider} failed to start${tail ? `: ${tail}` : ""}`,
        );
      }
      throw new ProviderError(
        "provider_unavailable",
        `${this.provider} initialize failed: ${(e as Error).message}`,
      );
    }

    let sessionId: string;
    let resumed = false;
    let rawConfig: ConfigOption[] = [];
    if (resumeSessionId && initRes.agentCapabilities?.loadSession === true) {
      try {
        loading = true;
        const lr = (await conn.agent.request("session/load", {
          sessionId: resumeSessionId,
          cwd,
          mcpServers: [],
        } as never)) as { configOptions?: unknown };
        rawConfig = normalizeConfigOptions(lr ?? {});
        sessionId = resumeSessionId;
        resumed = true;
      } catch {
        const res = (await conn.agent.request("session/new", {
          cwd,
          mcpServers: [],
        } as never)) as { sessionId: string; configOptions?: unknown };
        sessionId = res.sessionId;
        rawConfig = normalizeConfigOptions(res);
      } finally {
        loading = false;
      }
    } else {
      const res = (await conn.agent.request("session/new", {
        cwd,
        mcpServers: [],
      } as never)) as { sessionId: string; configOptions?: unknown };
      sessionId = res.sessionId;
      rawConfig = normalizeConfigOptions(res);
    }

    const session = new AcpSession(sessionId, resumed, conn, child, hooks);
    session.configOptions = rawConfig;
    const origClose = session.close.bind(session);
    session.close = async () => {
      closedByUs = true;
      await origClose();
    };
    return session;
  }
}

export function getDriver(provider: ProviderId): ProviderDriver {
  if (provider === "claude" || provider === "codex" || provider === "openai-compatible") {
    throw new ProviderError("provider_unavailable", `${provider} is not supported yet`);
  }
  return new AcpDriver(provider);
}

export function checkProviderAvailable(provider: ProviderId): void {
  getDriver(provider); // throws provider_unavailable for non-ACP providers
  const cmd = commandFor(provider);
  if (!cmd || !resolveCommand(cmd[0]!)) {
    throw new ProviderError(
      "provider_unavailable",
      `\`${cmd?.[0] ?? provider}\` not found in PATH (provider: ${provider})`,
    );
  }
}
