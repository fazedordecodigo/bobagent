import type { ConfigOption, PermissionOption, ToolCallStatus } from "@upbot/protocol";
import {
  AUTH_RE,
  authMessage,
  isVmCredentialRejection,
  type ProviderProcess,
  providerCommand,
  readJsonLines,
  redactCredential,
  spawnProvider,
  truncate,
  vmCredentialRejectedMessage,
  withTimeout,
  writeJsonLine,
} from "./process";
import {
  type McpServerSpec,
  type ProviderDriver,
  ProviderError,
  type ProviderHooks,
  type ProviderSession,
  type StartOpts,
} from "./types";

// Codex App Server (`codex app-server --listen stdio://`): JSON-RPC without the
// "jsonrpc" field, one message per line. Threads map to UpBot sessions.

const REQUEST_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

export const CODEX_MODES: { value: string; name: string; description: string }[] = [
  { value: "auto", name: "Auto", description: "Edit the workspace; ask before anything else" },
  { value: "read-only", name: "Read only", description: "Read files; ask before any change" },
];

const MODE_POLICY: Record<string, { approvalPolicy: string; sandbox: string }> = {
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "read-only": { approvalPolicy: "on-request", sandbox: "read-only" },
};

function sandboxPolicy(mode: string, roots: string[]): Json {
  return mode === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: roots,
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

class RpcFailure extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

type ToolInfo = { title: string; kind: string; detail: string | null } | null;

export function codexToolInfo(item: Json): ToolInfo {
  switch (item.type) {
    case "commandExecution":
      return {
        title: `Run: ${truncate(String(item.command ?? ""), 200)}`,
        kind: "execute",
        detail: str(item.cwd),
      };
    case "fileChange": {
      const paths = (Array.isArray(item.changes) ? item.changes : [])
        .map((c) => str((c as Json).path))
        .filter((p): p is string => p !== null);
      return {
        title: paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`,
        kind: "edit",
        detail: paths.length ? truncate(paths.join("\n")) : null,
      };
    }
    case "mcpToolCall":
      return { title: `${String(item.server)}.${String(item.tool)}`, kind: "other", detail: null };
    case "dynamicToolCall":
      return { title: String(item.tool ?? "tool"), kind: "other", detail: null };
    case "webSearch":
      return {
        title: `Web search${str(item.query) ? `: ${item.query}` : ""}`,
        kind: "fetch",
        detail: null,
      };
    case "imageView":
      return { title: `View ${String(item.path ?? "image")}`, kind: "read", detail: null };
    default:
      return null;
  }
}

function itemStatus(item: Json): ToolCallStatus {
  const s = item.status;
  if (s === "failed" || s === "declined") return "failed";
  if (
    item.type === "commandExecution" &&
    typeof item.exitCode === "number" &&
    item.exitCode !== 0
  ) {
    return "failed";
  }
  if (item.type === "mcpToolCall" && item.error) return "failed";
  if (item.type === "dynamicToolCall" && item.success === false) return "failed";
  return "completed";
}

function completedDetail(item: Json): string | null {
  if (item.type === "commandExecution" && str(item.aggregatedOutput)) {
    const out = item.aggregatedOutput as string;
    return out.length > 2000 ? `…${out.slice(-2000)}` : out;
  }
  return null;
}

type ActiveTurn = {
  turnId: string | null;
  resolve: (r: { stopReason: string }) => void;
  reject: (e: unknown) => void;
  interrupting: boolean;
  /** turn/completed may race ahead of the turn/start response. */
  early: Json | null;
};

class CodexSession implements ProviderSession {
  configOptions: ConfigOption[] = [];
  sessionId = "";
  resumed = false;
  private nextId = 0;
  private pending = new Map<number, { resolve: (r: Json) => void; reject: (e: unknown) => void }>();
  private active: ActiveTurn | null = null;
  private deltaItems = new Set<string>();
  private toolItems = new Set<string>();
  private closed = false;

  constructor(
    private proc: ProviderProcess,
    private hooks: ProviderHooks,
    private roots: string[],
    private vmCredential: string | null,
  ) {
    readJsonLines(proc.child.stdout!, (m) => this.onMessage(m));
    proc.onUnexpectedExit((message) => this.fail(message));
  }

  private fail(message: string) {
    const err =
      this.vmCredential && isVmCredentialRejection(message)
        ? new ProviderError(
            "auth_required",
            vmCredentialRejectedMessage("codex", message, this.vmCredential),
          )
        : new Error(redactCredential(message, this.vmCredential));
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    const active = this.active;
    this.active = null;
    active?.reject(err);
    if (!this.closed) this.hooks.onExit(message);
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> {
    const id = ++this.nextId;
    const p = new Promise<Json>((resolve, reject) => {
      if (this.proc.exited()) {
        reject(new Error("codex process is not running"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      writeJsonLine(this.proc.child, { id, method, params });
    });
    return withTimeout(p, timeoutMs, `codex ${method}`).finally(() => this.pending.delete(id));
  }

  notify(method: string, params?: unknown) {
    writeJsonLine(this.proc.child, params === undefined ? { method } : { method, params });
  }

  private onMessage(m: Json) {
    const hasId = typeof m.id === "number" || typeof m.id === "string";
    if (hasId && typeof m.method === "string") {
      void this.onServerRequest(m.id as number | string, m.method, (m.params ?? {}) as Json);
      return;
    }
    if (hasId) {
      const p = this.pending.get(m.id as number);
      if (!p) return;
      this.pending.delete(m.id as number);
      if (m.error) {
        const e = m.error as Json;
        p.reject(
          new RpcFailure(typeof e.code === "number" ? e.code : null, String(e.message ?? "error")),
        );
      } else {
        p.resolve((m.result ?? {}) as Json);
      }
      return;
    }
    if (typeof m.method === "string") this.onNotification(m.method, (m.params ?? {}) as Json);
  }

  private onNotification(method: string, p: Json) {
    if (p.threadId !== undefined && p.threadId !== this.sessionId) return;
    switch (method) {
      case "item/agentMessage/delta":
        if (str(p.delta)) {
          this.deltaItems.add(String(p.itemId));
          this.hooks.onUpdate({ type: "message_chunk", text: p.delta as string });
        }
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        if (str(p.delta)) {
          this.deltaItems.add(String(p.itemId));
          this.hooks.onUpdate({ type: "thought_chunk", text: p.delta as string });
        }
        return;
      case "item/started": {
        const item = (p.item ?? {}) as Json;
        const info = codexToolInfo(item);
        if (!info) return;
        this.toolItems.add(String(item.id));
        this.hooks.onUpdate({
          type: "tool_call",
          toolCallId: String(item.id),
          title: info.title,
          toolKind: info.kind,
          status: "in_progress",
          detail: info.detail,
        });
        return;
      }
      case "item/completed": {
        const item = (p.item ?? {}) as Json;
        const id = String(item.id);
        if (item.type === "agentMessage" && !this.deltaItems.has(id) && str(item.text)) {
          this.hooks.onUpdate({ type: "message_chunk", text: item.text as string });
          return;
        }
        if (!this.toolItems.has(id)) return;
        this.toolItems.delete(id);
        const update: Parameters<ProviderHooks["onUpdate"]>[0] = {
          type: "tool_call_update",
          toolCallId: id,
          status: itemStatus(item),
        };
        const detail = completedDetail(item);
        if (detail !== null) update.detail = detail;
        this.hooks.onUpdate(update);
        return;
      }
      case "turn/completed":
        this.onTurnCompleted((p.turn ?? {}) as Json);
        return;
      case "thread/tokenUsage/updated":
        this.onTokenUsage((p.tokenUsage ?? {}) as Json);
        return;
      default:
        this.hooks.onUpdate({ type: "ignored", kind: method });
    }
  }

  private prevTotals = { input: 0, output: 0 };

  private onTokenUsage(t: Json) {
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    const total = (t.total ?? {}) as Json;
    const last = (t.last ?? {}) as Json;
    const input = n(total.inputTokens);
    const output = n(total.outputTokens);
    this.hooks.onUpdate({
      type: "usage",
      usedTokens: t.last ? n(last.totalTokens) : null,
      contextWindow: typeof t.modelContextWindow === "number" ? t.modelContextWindow : null,
      inputTokens: Math.max(0, input - this.prevTotals.input),
      outputTokens: Math.max(0, output - this.prevTotals.output),
    });
    this.prevTotals = { input, output };
  }

  private onTurnCompleted(turn: Json) {
    const active = this.active;
    if (!active) return;
    if (active.turnId === null) {
      active.early = turn;
      return;
    }
    if (turn.id !== active.turnId) return;
    this.active = null;
    this.deltaItems.clear();
    this.toolItems.clear();
    if (turn.status === "interrupted" || active.interrupting) {
      active.resolve({ stopReason: "cancelled" });
      return;
    }
    if (turn.status === "failed") {
      const detail = str((turn.error as Json | null)?.message) ?? "codex turn failed";
      if (this.vmCredential && isVmCredentialRejection(detail))
        active.reject(
          new ProviderError(
            "auth_required",
            vmCredentialRejectedMessage("codex", detail, this.vmCredential),
          ),
        );
      else
        active.reject(
          AUTH_RE.test(detail)
            ? new ProviderError("auth_required", authMessage("codex", detail))
            : new Error(redactCredential(detail, this.vmCredential)),
        );
      return;
    }
    active.resolve({ stopReason: "end_turn" });
  }

  private async onServerRequest(id: number | string, method: string, p: Json) {
    const respond = (result: unknown) => writeJsonLine(this.proc.child, { id, result });
    const approval = async (
      title: string,
      toolKind: string,
      ids: { accept: string; session: string; decline: string; cancel: string },
    ) => {
      const options: PermissionOption[] = [
        { optionId: ids.accept, name: "Allow", kind: "allow_once" },
        { optionId: ids.session, name: "Allow for session", kind: "allow_always" },
        { optionId: ids.decline, name: "Deny", kind: "reject_once" },
      ];
      const { optionId } = await this.hooks.requestPermission({ title, toolKind, options });
      return optionId ?? ids.cancel;
    };
    const v2 = {
      accept: "accept",
      session: "acceptForSession",
      decline: "decline",
      cancel: "cancel",
    };
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const cmd = str(p.command);
        const title = cmd ? `Run: ${truncate(cmd, 200)}` : (str(p.reason) ?? "Run a command");
        respond({ decision: await approval(title, "execute", v2) });
        return;
      }
      case "item/fileChange/requestApproval": {
        const title =
          str(p.reason) ?? (str(p.grantRoot) ? `Write to ${p.grantRoot}` : "Apply file changes");
        respond({ decision: await approval(title, "edit", v2) });
        return;
      }
      case "execCommandApproval":
      case "applyPatchApproval": {
        const legacy = {
          accept: "approved",
          session: "approved_for_session",
          decline: "denied",
          cancel: "abort",
        };
        const cmd = Array.isArray(p.command) ? p.command.join(" ") : null;
        const title = cmd ? `Run: ${truncate(cmd, 200)}` : (str(p.reason) ?? "Apply file changes");
        const d = await approval(
          title,
          method === "execCommandApproval" ? "execute" : "edit",
          legacy,
        );
        respond({
          decision: d === "denied" ? { denied: { rejection: "The user denied this action." } } : d,
        });
        return;
      }
      default:
        writeJsonLine(this.proc.child, {
          id,
          error: { code: -32601, message: `UpBot does not support ${method}` },
        });
    }
  }

  private mode(): string {
    return this.configOptions.find((o) => o.id === "mode")?.currentValue ?? "auto";
  }

  async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
    const opt = this.configOptions.find((o) => o.id === configId);
    if (!opt) throw new Error(`unknown config option ${configId}`);
    opt.currentValue = value;
    return this.configOptions;
  }

  async prompt(text: string): Promise<{ stopReason: string }> {
    if (this.active) throw new Error("a codex turn is already running");
    const mode = this.mode();
    const model = this.configOptions.find((o) => o.id === "model")?.currentValue;
    const effort = this.configOptions.find((o) => o.id === "effort")?.currentValue;
    const done = new Promise<{ stopReason: string }>((resolve, reject) => {
      this.active = { turnId: null, resolve, reject, interrupting: false, early: null };
    });
    const active = this.active!;
    try {
      const res = await this.request("turn/start", {
        threadId: this.sessionId,
        input: [{ type: "text", text, text_elements: [] }],
        approvalPolicy: (MODE_POLICY[mode] ?? MODE_POLICY.auto!).approvalPolicy,
        sandboxPolicy: sandboxPolicy(mode, this.roots),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      active.turnId = String((res.turn as Json | undefined)?.id ?? "");
      if (active.interrupting) void this.interrupt(active);
      if (active.early) this.onTurnCompleted(active.early);
    } catch (e) {
      if (this.active === active) this.active = null;
      const message = (e as Error).message;
      if (AUTH_RE.test(message))
        throw new ProviderError("auth_required", authMessage("codex", message));
      throw e;
    }
    return done;
  }

  private async interrupt(active: ActiveTurn) {
    if (!active.turnId) return;
    await this.request("turn/interrupt", { threadId: this.sessionId, turnId: active.turnId }).catch(
      () => {},
    );
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.interrupting = true;
    await this.interrupt(active);
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

function buildConfigOptions(
  models: Json[],
  threadModel: string | null,
  effort: string | null,
): ConfigOption[] {
  const out: ConfigOption[] = [
    { id: "mode", name: "Mode", category: "mode", currentValue: "auto", options: CODEX_MODES },
  ];
  const visible = models.filter((m) => m.hidden !== true && typeof m.model === "string");
  if (visible.length > 0) {
    const current =
      visible.find((m) => m.model === threadModel) ??
      visible.find((m) => m.isDefault === true) ??
      visible[0]!;
    out.push({
      id: "model",
      name: "Model",
      category: "model",
      currentValue: String(current.model),
      options: visible.map((m) => ({
        value: String(m.model),
        name: str(m.displayName) ?? String(m.model),
        description: str(m.description),
      })),
    });
    const efforts = (
      Array.isArray(current.supportedReasoningEfforts) ? current.supportedReasoningEfforts : []
    )
      .map((e) => str((e as Json).reasoningEffort))
      .filter((e): e is string => e !== null);
    if (efforts.length > 0) {
      const def = effort ?? str(current.defaultReasoningEffort) ?? efforts[0]!;
      out.push({
        id: "effort",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: efforts.includes(def) ? def : efforts[0]!,
        options: efforts.map((e) => ({ value: e, name: e, description: null })),
      });
    }
  }
  return out;
}

export class CodexDriver implements ProviderDriver {
  async start(opts: StartOpts): Promise<ProviderSession> {
    const { cwd, resumeSessionId, hooks } = opts;
    const mcp = opts.mcpServers ?? [];
    const { bin, args } = providerCommand("codex", opts.remote);
    const vmKey = opts.remote?.credentials.OPENAI_API_KEY ?? null;
    const proc = spawnProvider(
      bin,
      args,
      cwd,
      vmKey ? { CODEX_HOME: "/run/upbot/codex-home" } : undefined,
      opts.remote,
    );
    const session = new CodexSession(proc, hooks, [cwd, ...(opts.extraDirs ?? [])], vmKey);
    try {
      await session.request("initialize", {
        clientInfo: { name: "upbot", title: "UpBot", version: "0.2.1" },
        capabilities: null,
      });
      session.notify("initialized");
      let account = await session.request("account/read", { refreshToken: false });
      if (account.account == null && account.requiresOpenaiAuth === true && vmKey) {
        await session.request("account/login/start", { type: "apiKey", apiKey: vmKey });
        account = await session.request("account/read", { refreshToken: false });
      }
      if (account.account == null && account.requiresOpenaiAuth === true && vmKey)
        throw new ProviderError(
          "auth_required",
          vmCredentialRejectedMessage(
            "codex",
            "Codex app-server remained signed out after API-key login",
            vmKey,
          ),
        );
      if (
        account.account == null &&
        account.requiresOpenaiAuth === true &&
        (opts.remote || !process.env.OPENAI_API_KEY)
      ) {
        throw new ProviderError("auth_required", authMessage("codex"));
      }
      const threadParams = {
        cwd,
        approvalPolicy: MODE_POLICY.auto!.approvalPolicy,
        sandbox: MODE_POLICY.auto!.sandbox,
        ...(mcp.length > 0
          ? {
              config: Object.fromEntries(
                mcp.map((m) => [
                  `mcp_servers.${m.name}`,
                  // approvals can keep a tool call waiting for the user
                  { command: m.command, args: m.args, env: m.env, tool_timeout_sec: 3600 },
                ]),
              ),
            }
          : {}),
      };
      let res: Json | null = null;
      if (resumeSessionId) {
        try {
          res = await session.request("thread/resume", {
            threadId: resumeSessionId,
            ...threadParams,
            excludeTurns: true,
          });
          session.resumed = true;
        } catch {
          res = null;
        }
      }
      res ??= await session.request("thread/start", threadParams);
      const thread = (res.thread ?? {}) as Json;
      session.sessionId = String(thread.id ?? "");
      if (!session.sessionId) throw new Error("thread/start returned no thread id");
      let models: Json[] = [];
      try {
        const list = await session.request("model/list", {});
        models = Array.isArray(list.data) ? (list.data as Json[]) : [];
      } catch {}
      session.configOptions = buildConfigOptions(models, str(res.model), str(res.reasoningEffort));
      return session;
    } catch (e) {
      proc.kill();
      if (e instanceof ProviderError) throw e;
      const tail = proc.stderrTail();
      const message = (e as Error).message;
      if (vmKey && isVmCredentialRejection(message))
        throw new ProviderError(
          "auth_required",
          vmCredentialRejectedMessage("codex", message, vmKey),
        );
      if (AUTH_RE.test(message))
        throw new ProviderError(
          "auth_required",
          authMessage("codex", redactCredential(message, vmKey)),
        );
      const safeTail = redactCredential(tail, vmKey);
      const safeMessage = redactCredential(message, vmKey);
      throw new ProviderError(
        "provider_unavailable",
        `codex failed to start: ${safeMessage}${safeTail ? `\n${safeTail.split("\n").slice(-5).join("\n")}` : ""}`,
      );
    }
  }
}
