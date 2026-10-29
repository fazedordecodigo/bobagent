import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ConfigOption, ProviderId } from "@upbot/protocol";
import { resolveCommand, spawnEnv } from "../env/login-path";
import { spawnChild, waitForChildSpawn } from "../env/spawn";
import { envPositiveNumber } from "../env/vars";
import { VERSION } from "../version";
import {
  AUTH_RE,
  authMessage,
  commandFor,
  isVmCredentialRejection,
  redactCredential,
  STDERR_TAIL_LINES,
  vmCredentialRejectedMessage,
} from "./process";
import {
  type McpServerSpec,
  type NormalizedUpdate,
  type ProviderDriver,
  ProviderError,
  type ProviderHooks,
  type ProviderSession,
  type StartOpts,
} from "./types";

const DEFAULT_OPENCODE_FIRST_ACTIVITY_MS = 30000;

function isAuthError(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  if (err?.code === -32000) return true;
  return AUTH_RE.test(err?.message ?? "");
}

async function boundedRequest<T>(
  provider: ProviderId,
  method: string,
  request: Promise<T>,
  timeoutMs = 30000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${provider} ${method} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function opencodeFirstActivityTimeoutMs(): number {
  return envPositiveNumber("UPBOT_ACP_FIRST_ACTIVITY_MS", DEFAULT_OPENCODE_FIRST_ACTIVITY_MS);
}

type AcpActivityMonitor = {
  sessionId: string | null;
  promptHandler: (() => void) | null;
  promptActive: boolean;
  promptHadProgress: boolean;
};

const PROMPT_PROGRESS_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

function isPromptProgressUpdate(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const update = (params as { update?: { sessionUpdate?: unknown } }).update;
  return (
    typeof update?.sessionUpdate === "string" && PROMPT_PROGRESS_UPDATES.has(update.sessionUpdate)
  );
}

function observeAgentRequests(
  stream: ReadableStream<Uint8Array>,
  activity: AcpActivityMonitor,
): void {
  const observeLine = (line: string) => {
    const handler = activity.promptHandler;
    if (!handler) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const frame = message as {
      method?: unknown;
      id?: unknown;
      params?: { sessionId?: unknown } | null;
    };
    if (typeof frame.method !== "string" || frame.id === undefined) return;
    const requestSessionId = frame.params?.sessionId;
    if (requestSessionId === undefined || requestSessionId === activity.sessionId) handler();
  };

  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let lineStart = 0;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          observeLine(buffer.slice(lineStart, newline));
          lineStart = newline + 1;
          newline = buffer.indexOf("\n", lineStart);
        }
        buffer = buffer.slice(lineStart);
        if (done) {
          if (buffer.trim()) observeLine(buffer);
          return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  })().catch(() => {});
}

function errorDetail(e: unknown): string {
  const err = e as { message?: unknown; data?: { message?: unknown; detail?: unknown } } | null;
  const details = [err?.message, err?.data?.message, err?.data?.detail]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => {
      let detail = part;
      for (let i = 0; i < 3; i += 1) {
        try {
          const parsed = JSON.parse(detail) as {
            error?: { message?: unknown } | string;
            message?: unknown;
          };
          const nested =
            typeof parsed.error === "object" && parsed.error !== null
              ? parsed.error.message
              : typeof parsed.message === "string"
                ? parsed.message
                : parsed.error;
          if (typeof nested !== "string" || nested === detail) break;
          detail = nested;
        } catch {
          break;
        }
      }
      return detail;
    });
  return details.join(": ");
}

export function mapAcpAuthError(
  provider: ProviderId,
  error: unknown,
  credential: string | null,
  opencodeNoProgressPrompt = false,
): ProviderError | null {
  const detail = errorDetail(error);
  if (credential && isVmCredentialRejection(detail)) {
    return new ProviderError(
      "auth_required",
      vmCredentialRejectedMessage(provider, detail, credential),
    );
  }
  if (
    credential &&
    provider === "cursor" &&
    /failed to initialize session services/i.test(detail)
  ) {
    return new ProviderError(
      "auth_required",
      vmCredentialRejectedMessage(provider, detail, credential),
    );
  }
  if (
    provider === "opencode" &&
    !credential &&
    opencodeNoProgressPrompt &&
    /connection closed unexpectedly/i.test(detail)
  ) {
    return new ProviderError("auth_required", authMessage("opencode", ""));
  }
  if (isAuthError(error)) {
    return new ProviderError(
      "auth_required",
      authMessage(provider, redactCredential(detail, credential)),
    );
  }
  return null;
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
    case "usage_update": {
      const raw = u as unknown as { used?: unknown; size?: unknown };
      return {
        type: "usage",
        usedTokens: typeof raw.used === "number" ? raw.used : null,
        contextWindow: typeof raw.size === "number" ? raw.size : null,
      };
    }
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
    private hooks: ProviderHooks,
    private provider: ProviderId,
    private credential: string | null,
    private activity: AcpActivityMonitor,
    private firstActivityTimeoutMs: number,
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
    let res: {
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    let activityHandler: (() => void) | undefined;
    let watchdog: Promise<never> | undefined;
    try {
      if (this.provider === "opencode") {
        this.activity.promptActive = true;
        this.activity.promptHadProgress = false;
        watchdog = new Promise<never>((_, reject) => {
          watchdogTimer = setTimeout(() => {
            watchdogFired = true;
            reject(new ProviderError("auth_required", authMessage("opencode", "")));
          }, this.firstActivityTimeoutMs);
        });
        activityHandler = () => {
          if (watchdogFired || watchdogTimer === undefined) return;
          this.activity.promptHadProgress = true;
          clearTimeout(watchdogTimer);
          watchdogTimer = undefined;
          if (this.activity.promptHandler === activityHandler) {
            this.activity.promptHandler = null;
          }
        };
        this.activity.promptHandler = activityHandler;
      }
      const request = this.conn.agent.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      } as never);
      res = (await (watchdog ? Promise.race([request, watchdog]) : request)) as typeof res;
    } catch (e) {
      if (!watchdogFired && watchdogTimer !== undefined && watchdog) {
        const authError = mapAcpAuthError(
          this.provider,
          e,
          this.credential,
          this.activity.promptActive && !this.activity.promptHadProgress,
        );
        if (authError) throw authError;
        try {
          await watchdog;
        } catch (watchdogError) {
          e = watchdogError;
        }
      }
      if (watchdogFired) {
        await boundedRequest(this.provider, "session/cancel", this.cancel(), 1000).catch(() => {});
        await this.close();
      }
      if (e instanceof ProviderError) throw e;
      const authError = mapAcpAuthError(
        this.provider,
        e,
        this.credential,
        this.activity.promptActive && !this.activity.promptHadProgress,
      );
      if (authError) throw authError;
      throw e;
    } finally {
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
      if (activityHandler && this.activity.promptHandler === activityHandler) {
        this.activity.promptHandler = null;
      }
      this.activity.promptActive = false;
    }
    if (res.usage) {
      this.hooks.onUpdate({
        type: "usage",
        inputTokens: res.usage.inputTokens ?? 0,
        outputTokens: res.usage.outputTokens ?? 0,
      });
    }
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
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    }
  }
}

class AcpResumeError extends Error {}

export class AcpDriver implements ProviderDriver {
  constructor(private provider: ProviderId) {}

  async start(opts: StartOpts): Promise<ProviderSession> {
    try {
      return await this.startSession(opts);
    } catch (error) {
      if (!(error instanceof AcpResumeError)) throw error;
      opts.hooks.onResumeFailed?.();
      return this.startSession({ ...opts, resumeSessionId: null });
    }
  }

  private async startSession(opts: StartOpts): Promise<ProviderSession> {
    const { cwd, resumeSessionId, hooks } = opts;
    const mcpServers = (opts.mcpServers ?? []).map((m) => ({
      name: m.name,
      command: m.command,
      args: m.args,
      env: Object.entries(m.env).map(([name, value]) => ({ name, value })),
    }));
    const cmd = commandFor(this.provider);
    if (!cmd) {
      throw new ProviderError("provider_unavailable", `${this.provider} is not supported yet`);
    }
    const bin = opts.remote ? cmd[0]! : resolveCommand(cmd[0]!);
    if (!bin) {
      throw new ProviderError(
        "provider_unavailable",
        `\`${cmd[0]}\` not found in PATH (provider: ${this.provider})`,
      );
    }

    const stderrLines: string[] = [];
    const credential = Object.values(opts.remote?.credentials ?? {})[0] ?? null;
    let child: ChildProcess;
    try {
      child = opts.remote
        ? opts.remote.spawn([bin, ...cmd.slice(1)], { NO_COLOR: "1", ...opts.remote.credentials })
        : spawnChild(bin, cmd.slice(1), {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: spawnEnv({ NO_COLOR: "1" }),
          });
    } catch (error) {
      throw new ProviderError(
        "provider_unavailable",
        `${this.provider} failed to start: ${redactCredential(errorDetail(error), credential)}`,
      );
    }
    child.stdin?.on("error", () => {});
    let rejectChildError!: (error: Error) => void;
    const childError = new Promise<never>((_, reject) => {
      rejectChildError = reject;
    });
    void childError.catch(() => {});
    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split("\n")) stderrLines.push(line);
      if (stderrLines.length > STDERR_TAIL_LINES * 2) {
        stderrLines.splice(0, stderrLines.length - STDERR_TAIL_LINES);
      }
    });

    let exited = false;
    let closedByUs = false;
    let startupComplete = false;
    const activity: AcpActivityMonitor = {
      sessionId: null,
      promptHandler: null,
      promptActive: false,
      promptHadProgress: false,
    };
    child.on("error", (error) => {
      exited = true;
      rejectChildError(error);
      if (startupComplete && !closedByUs) {
        const message = `process error: ${error.message}`;
        const authError = mapAcpAuthError(this.provider, new Error(message), credential);
        hooks.onExit(authError?.message ?? message);
      }
    });
    child.on("exit", (code, signal) => {
      exited = true;
      if (
        !closedByUs &&
        (!activity.promptHandler || (activity.promptActive && !activity.promptHadProgress))
      ) {
        const tail = redactCredential(
          stderrLines.slice(-STDERR_TAIL_LINES).join("\n"),
          credential,
        ).trim();
        const message = `process exited (code ${code ?? "null"}, signal ${signal ?? "null"})${tail ? `: ${tail}` : ""}`;
        const authError = mapAcpAuthError(
          this.provider,
          new Error(message),
          credential,
          activity.promptActive && !activity.promptHadProgress,
        );
        hooks.onExit(authError?.message ?? message);
      }
    });

    try {
      await waitForChildSpawn(child);
    } catch (error) {
      closedByUs = true;
      child.kill("SIGKILL");
      throw new ProviderError(
        "provider_unavailable",
        `${this.provider} failed to start: ${redactCredential(errorDetail(error), credential)}`,
      );
    }
    const startupRequest = <T>(request: Promise<T>) => Promise.race([request, childError]);

    const stdoutNode = child.stdout!;
    const stdoutStream = Readable.toWeb(stdoutNode) as unknown as ReadableStream<Uint8Array>;
    let providerStream = stdoutStream;
    if (this.provider === "opencode") {
      const [main, activityStream] = stdoutStream.tee();
      providerStream = main;
      observeAgentRequests(activityStream, activity);
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      providerStream,
    );

    let loading = false;
    const app = acp
      .client({ name: "upbot" })
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
        const params = ctx.params as { sessionId?: string };
        if (params.sessionId === activity.sessionId && isPromptProgressUpdate(ctx.params)) {
          activity.promptHandler?.();
        }
        if (loading) return;
        hooks.onUpdate(mapUpdate(ctx.params));
      });

    const conn = app.connect(stream);
    conn.closed.catch(() => {});
    conn.closed.then(() => {
      if (
        !exited &&
        !closedByUs &&
        (!activity.promptHandler || (activity.promptActive && !activity.promptHadProgress))
      ) {
        const tail = redactCredential(
          stderrLines.slice(-STDERR_TAIL_LINES).join("\n"),
          credential,
        ).trim();
        const message = `connection closed unexpectedly${tail ? `: ${tail}` : ""}`;
        const authError = mapAcpAuthError(
          this.provider,
          new Error(message),
          credential,
          activity.promptActive && !activity.promptHadProgress,
        );
        hooks.onExit(authError?.message ?? message);
      }
    });

    const init = async () => {
      try {
        return (await startupRequest(
          boundedRequest(
            this.provider,
            "initialize",
            conn.agent.request("initialize", {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
              clientInfo: { name: "upbot", version: VERSION },
            } as never),
          ),
        )) as {
          agentCapabilities?: { loadSession?: boolean };
          authMethods?: unknown[];
        };
      } catch (e) {
        const authError = mapAcpAuthError(this.provider, e, credential);
        if (authError) throw authError;
        throw e;
      }
    };

    let initRes: Awaited<ReturnType<typeof init>>;
    try {
      initRes = await init();
    } catch (e) {
      closedByUs = true;
      try {
        conn.close();
      } catch {}
      child.kill("SIGKILL");
      if (e instanceof ProviderError) throw e;
      const authError = mapAcpAuthError(this.provider, e, credential);
      if (authError) throw authError;
      if (exited) {
        const tail = redactCredential(
          stderrLines.slice(-STDERR_TAIL_LINES).join("\n"),
          credential,
        ).trim();
        const detail = redactCredential(errorDetail(e), credential);
        throw new ProviderError(
          "provider_unavailable",
          `${this.provider} failed to start${tail ? `: ${tail}` : detail ? `: ${detail}` : ""}`,
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
    try {
      if (resumeSessionId && initRes.agentCapabilities?.loadSession === true) {
        try {
          loading = true;
          const lr = (await startupRequest(
            boundedRequest(
              this.provider,
              "session/load",
              conn.agent.request("session/load", {
                sessionId: resumeSessionId,
                cwd,
                mcpServers,
              } as never),
            ),
          )) as { configOptions?: unknown };
          rawConfig = normalizeConfigOptions(lr ?? {});
          sessionId = resumeSessionId;
          resumed = true;
        } catch (error) {
          const tail = stderrLines.slice(-STDERR_TAIL_LINES).join("\n");
          const authError =
            mapAcpAuthError(this.provider, error, credential) ??
            mapAcpAuthError(this.provider, new Error(tail), credential);
          if (authError) throw authError;
          throw new AcpResumeError(errorDetail(error));
        } finally {
          loading = false;
        }
      } else {
        const res = (await startupRequest(
          boundedRequest(
            this.provider,
            "session/new",
            conn.agent.request("session/new", {
              cwd,
              mcpServers,
            } as never),
          ),
        )) as { sessionId: string; configOptions?: unknown };
        sessionId = res.sessionId;
        rawConfig = normalizeConfigOptions(res);
      }
    } catch (e) {
      closedByUs = true;
      try {
        conn.close();
      } catch {}
      child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
      }
      if (e instanceof AcpResumeError || e instanceof ProviderError) throw e;
      const authError = mapAcpAuthError(this.provider, e, credential);
      if (authError) throw authError;
      if (exited) {
        const tail = redactCredential(
          stderrLines.slice(-STDERR_TAIL_LINES).join("\n"),
          credential,
        ).trim();
        const detail = redactCredential(errorDetail(e), credential);
        throw new ProviderError(
          "provider_unavailable",
          `${this.provider} failed to start${tail ? `: ${tail}` : detail ? `: ${detail}` : ""}`,
        );
      }
      const detail = errorDetail(e);
      throw new ProviderError(
        "provider_unavailable",
        `${this.provider} session startup failed${detail ? `: ${redactCredential(detail, credential)}` : ""}`,
      );
    }

    activity.sessionId = sessionId;
    const session = new AcpSession(
      sessionId,
      resumed,
      conn,
      child,
      hooks,
      this.provider,
      credential,
      activity,
      this.provider === "opencode" ? opencodeFirstActivityTimeoutMs() : 0,
    );
    session.configOptions = rawConfig;
    const origClose = session.close.bind(session);
    session.close = async () => {
      closedByUs = true;
      await origClose();
    };
    startupComplete = true;
    return session;
  }
}
