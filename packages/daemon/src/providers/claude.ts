import type { ConfigOption, PermissionOption } from "@bobagent/protocol";
import {
  AUTH_RE,
  authMessage,
  type ProviderProcess,
  providerCommand,
  readJsonLines,
  spawnProvider,
  truncate,
  withTimeout,
  writeJsonLine,
} from "./process";
import {
  type McpServerSpec,
  type NormalizedUpdate,
  type ProviderDriver,
  ProviderError,
  type ProviderHooks,
  type ProviderSession,
  type RemoteLaunch,
  type StartOpts,
} from "./types";

// Claude Code driven directly over its stream-json stdio protocol: user turns go in
// as `{"type":"user"}` lines, and permission prompts come back as `can_use_tool`
// control requests (enabled by `--permission-prompt-tool stdio`).

const INIT_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

export const CLAUDE_MODES: { value: string; name: string; description: string }[] = [
  { value: "default", name: "Ask", description: "Ask before running tools" },
  { value: "acceptEdits", name: "Accept edits", description: "Auto-accept file edits" },
  { value: "plan", name: "Plan", description: "Plan only, no tool execution" },
];

const TOOL_KINDS: Record<string, string> = {
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Glob: "search",
  Grep: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  Task: "think",
  TodoWrite: "think",
  ExitPlanMode: "switch_mode",
  EnterPlanMode: "switch_mode",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function claudeToolTitle(name: string, input: unknown): string {
  const i = (input ?? {}) as Json;
  const arg =
    str(i.command) ??
    str(i.file_path) ??
    str(i.notebook_path) ??
    str(i.path) ??
    str(i.pattern) ??
    str(i.url) ??
    str(i.query) ??
    str(i.description);
  return arg ? `${name}: ${truncate(arg.split("\n")[0]!, 200)}` : name;
}

function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() ? truncate(content) : null;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) =>
        c && typeof c === "object" && (c as Json).type === "text" ? (c as Json).text : "",
      )
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    return parts.length ? truncate(parts.join("\n")) : null;
  }
  return null;
}

type ActivePrompt = {
  resolve: (r: { stopReason: string }) => void;
  reject: (e: unknown) => void;
  interrupting: boolean;
  assistantError: string | null;
};

class ClaudeSession implements ProviderSession {
  configOptions: ConfigOption[] = [];
  private nextId = 0;
  private control = new Map<string, { resolve: (r: Json) => void; reject: (e: unknown) => void }>();
  private active: ActivePrompt | null = null;
  private streamed = new Set<string>();
  private currentMessageId: string | null = null;
  private closed = false;
  sessionId: string;
  resumed: boolean;

  constructor(
    private proc: ProviderProcess,
    private hooks: ProviderHooks,
    sessionId: string,
    resumed: boolean,
  ) {
    this.sessionId = sessionId;
    this.resumed = resumed;
    readJsonLines(proc.child.stdout!, (m) => this.onMessage(m));
    proc.onUnexpectedExit((message) => this.fail(message));
  }

  private fail(message: string) {
    const err = new Error(message);
    for (const p of this.control.values()) p.reject(err);
    this.control.clear();
    const active = this.active;
    this.active = null;
    active?.reject(err);
    if (!this.closed) this.hooks.onExit(message);
  }

  request(subtype: string, body: Json = {}): Promise<Json> {
    const requestId = `bob-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      if (this.proc.exited()) {
        reject(new Error("claude process is not running"));
        return;
      }
      this.control.set(requestId, { resolve, reject });
      writeJsonLine(this.proc.child, {
        type: "control_request",
        request_id: requestId,
        request: { subtype, ...body },
      });
    });
  }

  private onMessage(m: Json) {
    switch (m.type) {
      case "control_response": {
        const r = (m.response ?? {}) as Json;
        const p = this.control.get(String(r.request_id));
        if (!p) return;
        this.control.delete(String(r.request_id));
        if (r.subtype === "success") p.resolve((r.response ?? {}) as Json);
        else p.reject(new Error(String(r.error ?? "control request failed")));
        return;
      }
      case "control_request":
        void this.onControlRequest(String(m.request_id), (m.request ?? {}) as Json);
        return;
      case "control_cancel_request":
        return;
      case "system":
        if (m.subtype === "init" && typeof m.permissionMode === "string") {
          this.hooks.onUpdate({ type: "mode_update", modeId: m.permissionMode });
        }
        return;
      case "stream_event":
        this.onStreamEvent((m.event ?? {}) as Json);
        return;
      case "assistant":
        this.onAssistant(m);
        return;
      case "user":
        this.onUser(m);
        return;
      case "result":
        this.onResult(m);
        return;
      default:
        this.hooks.onUpdate({ type: "ignored", kind: String(m.type ?? "unknown") });
    }
  }

  private onStreamEvent(ev: Json) {
    if (ev.type === "message_start") {
      this.currentMessageId = str((ev.message as Json | undefined)?.id) ?? null;
      return;
    }
    if (ev.type !== "content_block_delta") return;
    const delta = (ev.delta ?? {}) as Json;
    let u: NormalizedUpdate | null = null;
    if (delta.type === "text_delta" && str(delta.text)) {
      u = { type: "message_chunk", text: delta.text as string };
    } else if (delta.type === "thinking_delta" && str(delta.thinking)) {
      u = { type: "thought_chunk", text: delta.thinking as string };
    }
    if (!u) return;
    if (this.currentMessageId) this.streamed.add(this.currentMessageId);
    this.hooks.onUpdate(u);
  }

  private lastContextTokens: number | null = null;
  private lastCostUsd = 0;

  private emitUsage(m: Json) {
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    const usage = (m.usage ?? {}) as Json;
    let contextWindow: number | null = null;
    for (const mu of Object.values((m.modelUsage ?? {}) as Record<string, Json>)) {
      if (typeof mu?.contextWindow === "number")
        contextWindow = Math.max(contextWindow ?? 0, mu.contextWindow);
    }
    const total = typeof m.total_cost_usd === "number" ? m.total_cost_usd : this.lastCostUsd;
    const costUsd = Math.max(0, total - this.lastCostUsd);
    this.lastCostUsd = total;
    this.hooks.onUpdate({
      type: "usage",
      usedTokens: this.lastContextTokens,
      contextWindow,
      inputTokens:
        n(usage.input_tokens) +
        n(usage.cache_read_input_tokens) +
        n(usage.cache_creation_input_tokens),
      outputTokens: n(usage.output_tokens),
      costUsd,
    });
  }

  private onAssistant(m: Json) {
    const msg = (m.message ?? {}) as Json;
    const mu = msg.usage as Json | undefined;
    if (mu) {
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      this.lastContextTokens =
        n(mu.input_tokens) +
        n(mu.cache_read_input_tokens) +
        n(mu.cache_creation_input_tokens) +
        n(mu.output_tokens);
    }
    if (typeof m.error === "string" && this.active) this.active.assistantError = m.error;
    const synthetic = msg.model === "<synthetic>";
    const id = str(msg.id);
    const alreadyStreamed = id !== null && this.streamed.has(id);
    for (const block of (Array.isArray(msg.content) ? msg.content : []) as Json[]) {
      if (block.type === "text" && !alreadyStreamed && !synthetic && str(block.text)) {
        this.hooks.onUpdate({ type: "message_chunk", text: block.text as string });
      } else if (block.type === "thinking" && !alreadyStreamed && str(block.thinking)) {
        this.hooks.onUpdate({ type: "thought_chunk", text: block.thinking as string });
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "tool");
        this.hooks.onUpdate({
          type: "tool_call",
          toolCallId: String(block.id ?? ""),
          title: claudeToolTitle(name, block.input),
          toolKind: TOOL_KINDS[name] ?? "other",
          status: "in_progress",
          detail: block.input ? truncate(JSON.stringify(block.input)) : null,
        });
      }
    }
  }

  private onUser(m: Json) {
    const msg = (m.message ?? {}) as Json;
    if (!Array.isArray(msg.content)) return;
    for (const block of msg.content as Json[]) {
      if (block.type !== "tool_result") continue;
      this.hooks.onUpdate({
        type: "tool_call_update",
        toolCallId: String(block.tool_use_id ?? ""),
        status: block.is_error === true ? "failed" : "completed",
        detail: toolResultText(block.content),
      });
    }
  }

  private onResult(m: Json) {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.streamed.clear();
    this.emitUsage(m);
    if (active.interrupting) {
      active.resolve({ stopReason: "cancelled" });
      return;
    }
    if (m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success")) {
      const detail = str(m.result) ?? (Array.isArray(m.errors) ? m.errors.join("; ") : "");
      if (active.assistantError === "authentication_failed" || AUTH_RE.test(detail)) {
        active.reject(new ProviderError("auth_required", authMessage("claude", detail)));
      } else {
        active.reject(new Error(detail || `claude turn failed (${String(m.subtype)})`));
      }
      return;
    }
    const stop = str(m.stop_reason);
    active.resolve({ stopReason: stop === "max_tokens" ? "max_tokens" : "end_turn" });
  }

  private async onControlRequest(requestId: string, req: Json) {
    const reply = (response: Json | null, error?: string) =>
      writeJsonLine(this.proc.child, {
        type: "control_response",
        response:
          error === undefined
            ? { subtype: "success", request_id: requestId, response: response ?? {} }
            : { subtype: "error", request_id: requestId, error },
      });
    if (req.subtype !== "can_use_tool") {
      reply(null, `unsupported control request: ${String(req.subtype)}`);
      return;
    }
    const toolName = String(req.tool_name ?? "tool");
    const input = (req.input ?? {}) as Json;
    const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
    const options: PermissionOption[] = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
    if (suggestions.length > 0) {
      options.push({ optionId: "allow_always", name: "Always allow", kind: "allow_always" });
    }
    options.push({ optionId: "deny", name: "Deny", kind: "reject_once" });
    const { optionId } = await this.hooks.requestPermission({
      title: str(req.title) ?? claudeToolTitle(toolName, input),
      toolKind: TOOL_KINDS[toolName] ?? "other",
      options,
    });
    const toolUseID = str(req.tool_use_id) ?? undefined;
    if (optionId === "allow") {
      reply({ behavior: "allow", updatedInput: input, toolUseID });
    } else if (optionId === "allow_always") {
      reply({ behavior: "allow", updatedInput: input, updatedPermissions: suggestions, toolUseID });
    } else if (optionId === "deny") {
      reply({ behavior: "deny", message: "The user denied this action.", toolUseID });
    } else {
      reply({ behavior: "deny", message: "The user cancelled.", interrupt: true, toolUseID });
    }
  }

  async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
    if (configId === "mode") await this.request("set_permission_mode", { mode: value });
    else if (configId === "model") await this.request("set_model", { model: value });
    else throw new Error(`unknown config option ${configId}`);
    const opt = this.configOptions.find((o) => o.id === configId);
    if (opt) opt.currentValue = value;
    return this.configOptions;
  }

  prompt(text: string): Promise<{ stopReason: string }> {
    if (this.active) return Promise.reject(new Error("a claude turn is already running"));
    if (this.proc.exited()) return Promise.reject(new Error("claude process is not running"));
    return new Promise((resolve, reject) => {
      this.active = { resolve, reject, interrupting: false, assistantError: null };
      writeJsonLine(this.proc.child, {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
    });
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.active.interrupting = true;
    await this.request("interrupt").catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.proc.markClosed();
    try {
      this.proc.child.stdin?.end();
    } catch {}
    this.proc.kill();
  }
}

function modelOptions(models: unknown): ConfigOption | null {
  if (!Array.isArray(models) || models.length === 0) return null;
  const options = (models as Json[])
    .filter((m) => typeof m.value === "string")
    .map((m) => ({
      value: m.value as string,
      name: str(m.displayName) ?? (m.value as string),
      description: str(m.description),
    }));
  if (options.length === 0) return null;
  return {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: options.some((o) => o.value === "default") ? "default" : options[0]!.value,
    options,
  };
}

export class ClaudeDriver implements ProviderDriver {
  async start(opts: StartOpts): Promise<ProviderSession> {
    const mcp = opts.mcpServers ?? [];
    if (opts.resumeSessionId) {
      try {
        return await this.launch(opts.cwd, opts.resumeSessionId, opts.hooks, mcp, opts.remote);
      } catch (e) {
        if (e instanceof ProviderError && e.code !== "internal") throw e;
        // stale/unknown session: fall back to a fresh one
      }
    }
    return this.launch(opts.cwd, null, opts.hooks, mcp, opts.remote);
  }

  private async launch(
    cwd: string,
    resumeSessionId: string | null,
    hooks: ProviderHooks,
    mcp: McpServerSpec[],
    remote?: RemoteLaunch,
  ): Promise<ProviderSession> {
    const mcpArgs =
      mcp.length > 0
        ? [
            "--mcp-config",
            JSON.stringify({
              mcpServers: Object.fromEntries(
                mcp.map((m) => [
                  m.name,
                  { type: "stdio", command: m.command, args: m.args, env: m.env },
                ]),
              ),
            }),
          ]
        : [];
    const { bin, args } = providerCommand("claude", remote);
    const sessionId = resumeSessionId ?? crypto.randomUUID();
    const proc = spawnProvider(
      bin,
      [
        ...args,
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        "default",
        ...(resumeSessionId ? ["--resume", resumeSessionId] : ["--session-id", sessionId]),
        ...mcpArgs,
      ],
      cwd,
      undefined,
      remote,
    );
    const session = new ClaudeSession(proc, hooks, sessionId, resumeSessionId !== null);
    let init: Json;
    try {
      init = await withTimeout(
        session.request("initialize", { hooks: null }),
        INIT_TIMEOUT_MS,
        "claude initialize",
      );
    } catch (e) {
      proc.kill();
      const tail = proc.stderrTail();
      if (AUTH_RE.test(tail)) throw new ProviderError("auth_required", authMessage("claude", tail));
      const msg = `claude failed to start${tail ? `: ${tail}` : `: ${(e as Error).message}`}`;
      throw new ProviderError(resumeSessionId ? "internal" : "provider_unavailable", msg);
    }
    const mode = str(init.current_permission_mode) ?? "default";
    const options: ConfigOption[] = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: CLAUDE_MODES.some((m) => m.value === mode) ? mode : "default",
        options: CLAUDE_MODES,
      },
    ];
    const model = modelOptions(init.models);
    if (model) options.push(model);
    session.configOptions = options;
    return session;
  }
}
