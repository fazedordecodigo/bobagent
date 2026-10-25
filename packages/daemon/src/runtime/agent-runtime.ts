import { join } from "node:path";
import type {
  Agent,
  AgentStatus,
  ChatItem,
  ConfigOption,
  PendingPermission,
  PermissionOption,
  QueueState,
} from "@bobagent/protocol";
import type { AgentStore } from "../agents";
import type { ChatStore, QueueStore } from "../chat-store";
import { checkProviderAvailable, DEFAULT_MODE, getDriver } from "../providers";
import { ProviderError, type ProviderHooks, type ProviderSession } from "../providers/types";
import { buildHandoff } from "./handoff";

export type Broadcast = (event: string, data: unknown) => void;
export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

type PendingEntry = {
  requestId: string;
  turnId: string;
  title: string;
  toolKind: string | null;
  options: PermissionOption[];
  itemId: string;
  resolve: (r: { optionId: string | null }) => void;
};

const cancelGraceMs = () =>
  Math.max(0, Number.parseInt(process.env.BOBAGENT_CANCEL_GRACE_MS ?? "", 10) || 10_000);

export class AgentRuntime {
  status: AgentStatus = "idle";
  statusError: string | null = null;
  private turn: { id: string; cancelled: boolean; byUser: boolean } | null = null;
  private session: ProviderSession | null = null;
  private sessionTag: object | null = null;
  private sessionStarting: Promise<ProviderSession> | null = null;
  private sessionPromptCount = 0;
  private sessionConfigApplied = false;
  private configOptions: ConfigOption[] = [];
  private openTextItem: { id: string; kind: "agent_message" | "agent_thought" } | null = null;
  private pending = new Map<string, PendingEntry>();
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private disposing = false;

  constructor(
    private agent: Agent,
    private agents: AgentStore,
    private store: ChatStore,
    private queue: QueueStore,
    private broadcast: Broadcast,
  ) {}

  updateAgent(agent: Agent) {
    this.agent = agent;
  }

  private setStatus(status: AgentStatus, error: string | null = null) {
    this.status = status;
    this.statusError = error;
    this.broadcast("agent.status", { agentId: this.agent.id, status, error });
  }

  private hooks(tag: object): ProviderHooks {
    return {
      onUpdate: (u) => this.onUpdate(u),
      requestPermission: (req) => this.onPermissionRequest(req),
      onExit: (err) => {
        // ignore exits from sessions that have already been replaced
        if (this.sessionTag === tag) this.onProcessExit(err);
      },
    };
  }

  private queueState(): QueueState {
    return {
      agentId: this.agent.id,
      paused: this.agents.queuePaused(this.agent.id),
      items: this.queue.queued(this.agent.id),
    };
  }

  private emitQueue() {
    this.broadcast("queue.updated", this.queueState());
  }

  // ---- Queue API ----

  send(text: string): { queueId: string } {
    checkProviderAvailable(this.agent.provider); // up-front provider_unavailable
    const item = this.queue.enqueue(this.agent.id, text);
    this.emitQueue();
    this.drain();
    return { queueId: item.id };
  }

  getQueue(): QueueState {
    return this.queueState();
  }

  removeQueued(queueId: string): void {
    const ok = this.queue.remove(queueId);
    if (!ok) throw new RpcError("not_found", "queue item not found or already started");
    this.emitQueue();
  }

  pauseQueue(): QueueState {
    this.agents.setQueuePaused(this.agent.id, true);
    const s = this.queueState();
    this.broadcast("queue.updated", s);
    return s;
  }

  resumeQueue(): QueueState {
    this.agents.setQueuePaused(this.agent.id, false);
    const s = this.queueState();
    this.broadcast("queue.updated", s);
    this.drain();
    return s;
  }

  /** Starts the oldest queued item when idle and unpaused. */
  drain(): void {
    if (this.draining || this.turn || this.sessionStarting || this.disposing) return;
    if (this.agents.queuePaused(this.agent.id)) return;
    const next = this.queue.peek(this.agent.id);
    if (!next) return;
    this.draining = true;
    try {
      const turnRow = this.store.createTurn(this.agent.id, next.id);
      this.queue.markStarted(next.id, turnRow.id);
      this.turn = { id: turnRow.id, cancelled: false, byUser: false };
      this.openTextItem = null;
      const userItem = this.store.createItem(this.agent.id, turnRow.id, "user_message", {
        text: next.text,
      });
      this.setStatus("starting");
      this.broadcast("turn.started", turnRow);
      this.broadcast("item.created", userItem);
      this.emitQueue();
      this.runTurn(next.text, turnRow.id).catch(() => {});
    } finally {
      this.draining = false;
    }
  }

  // ---- Session ----

  private async ensureSession(): Promise<ProviderSession> {
    if (this.session) return this.session;
    this.sessionStarting ??= (async () => {
      const stored = this.store.getAgentSession(this.agent.id);
      const resumeSessionId =
        stored && stored.provider === this.agent.provider ? stored.sessionId : null;
      const driver = getDriver(this.agent.provider);
      const tag = {};
      const session = await driver.start({
        cwd: this.agent.workspacePath,
        resumeSessionId,
        hooks: this.hooks(tag),
      });
      this.sessionTag = tag;
      this.store.upsertAgentSession(this.agent.id, this.agent.provider, session.sessionId);
      return session;
    })();
    const started = this.sessionStarting;
    try {
      const session = await started;
      // if a dispose() replaced us while we were starting, drop this session
      if (this.sessionStarting !== started) {
        this.sessionTag = null;
        await session.close().catch(() => {});
        throw new Error("session disposed while starting");
      }
      this.session = session;
      this.sessionPromptCount = 0;
      this.sessionConfigApplied = false;
      this.configOptions = this.session.configOptions;
      this.broadcast("agent.config", {
        agentId: this.agent.id,
        configOptions: this.configOptions,
      });
      return this.session;
    } finally {
      if (this.sessionStarting === started) {
        this.sessionStarting = null;
        this.drain(); // a queued item may have arrived while starting
      }
    }
  }

  private async applySessionConfig(session: ProviderSession): Promise<void> {
    this.sessionConfigApplied = true;
    const opts = session.configOptions;
    let changed = false;
    for (const o of opts) {
      const desired = this.agent.config[o.id];
      if (desired === undefined) continue;
      if (!o.options.some((v) => v.value === desired)) {
        console.error(
          `[bobagentd] skipping invalid config ${o.id}=${desired} for ${this.agent.provider}`,
        );
        continue;
      }
      if (o.currentValue === desired) continue;
      try {
        await session.setConfigOption(o.id, desired);
        o.currentValue = desired;
        changed = true;
      } catch (e) {
        console.error(`[bobagentd] set_config_option ${o.id} failed:`, (e as Error).message);
      }
    }
    // default mode when the user hasn't chosen one
    const modeOpt = opts.find((o) => o.category === "mode" || o.id === "mode");
    if (modeOpt && this.agent.config[modeOpt.id] === undefined) {
      const def = DEFAULT_MODE[this.agent.provider];
      if (def && modeOpt.options.some((v) => v.value === def) && modeOpt.currentValue !== def) {
        try {
          await session.setConfigOption(modeOpt.id, def);
          modeOpt.currentValue = def;
          changed = true;
        } catch (e) {
          console.error(`[bobagentd] default mode ${def} failed:`, (e as Error).message);
        }
      }
    }
    if (changed) {
      this.broadcast("agent.config", { agentId: this.agent.id, configOptions: opts });
    }
  }

  private async runTurn(text: string, turnId: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.id !== turnId) return;
    try {
      const session = await this.ensureSession();
      if (turn.cancelled || this.turn !== turn)
        return this.finishTurn(turn, "cancelled", null, null);
      this.setStatus("running");
      if (!this.sessionConfigApplied) await this.applySessionConfig(session);

      let promptText = text;
      const instructions = this.agent.instructions.trim();
      if (!session.resumed && this.sessionPromptCount === 0) {
        if (instructions) {
          promptText = `<agent_instructions>\n${instructions}\n</agent_instructions>\n\n${promptText}`;
        }
        const prior = this.store
          .history(this.agent.id, undefined, 500)
          .items.filter(
            (i): i is Extract<ChatItem, { kind: "user_message" | "agent_message" }> =>
              (i.kind === "user_message" || i.kind === "agent_message") && i.turnId !== turn.id,
          )
          .map((i) => ({ kind: i.kind, text: i.text }));
        const handoff = buildHandoff(prior);
        if (handoff) promptText = handoff + promptText;
      }
      this.sessionPromptCount += 1;
      const dbgDir = process.env.BOBAGENT_DEBUG_PROMPTS_DIR;
      if (dbgDir) {
        try {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          mkdirSync(dbgDir, { recursive: true });
          writeFileSync(join(dbgDir, `${this.agent.id}-${turn.id}.txt`), promptText);
        } catch {}
      }
      const { stopReason } = await session.prompt(promptText);
      if (this.turn !== turn) return;
      if (turn.cancelled || stopReason === "cancelled") {
        this.finishTurn(turn, "cancelled", stopReason, null);
      } else {
        this.finishTurn(turn, "completed", stopReason, null);
      }
    } catch (e) {
      if (this.turn !== turn) return;
      if (turn.cancelled) {
        this.finishTurn(turn, "cancelled", "cancelled", null);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.dropSession();
      const errItem = this.store.createItem(this.agent.id, turn.id, "error", { message });
      this.broadcast("item.created", errItem);
      this.finishTurn(turn, "failed", null, message);
      this.setStatus("error", message);
    }
  }

  private finishTurn(
    turn: { id: string; cancelled: boolean; byUser: boolean },
    status: "completed" | "cancelled" | "failed",
    stopReason: string | null,
    error: string | null,
  ): void {
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }
    this.cancelAllPending();
    const ended = this.store.endTurn(turn.id, status, stopReason, error);
    this.broadcast("turn.ended", ended);
    if (this.turn === turn) this.turn = null;
    this.openTextItem = null;
    if (this.status !== "error") this.setStatus("idle");
    // queue policy: user stop pauses the queue; failed turn auto-pauses it
    if ((status === "cancelled" && turn.byUser) || status === "failed") {
      if (this.queue.queued(this.agent.id).length > 0) {
        this.agents.setQueuePaused(this.agent.id, true);
        this.emitQueue();
        return;
      }
    }
    this.drain();
  }

  cancel(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.cancelled = true;
    turn.byUser = true;
    this.cancelAllPending();
    this.session?.cancel().catch(() => {});
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(() => {
      if (this.turn === turn && turn.cancelled) {
        this.dropSession();
        this.finishTurn(turn, "cancelled", "cancelled", null);
      }
    }, cancelGraceMs());
  }

  // ---- Config API ----

  async configOptionsList(): Promise<ConfigOption[]> {
    this.setStatus("starting");
    try {
      const session = await this.ensureSession();
      if (this.status === "starting") this.setStatus("idle");
      return session.configOptions;
    } catch (e) {
      if (this.status === "starting") this.setStatus("idle");
      throw e;
    }
  }

  async setConfig(configId: string, value: string): Promise<ConfigOption[]> {
    if (this.turn) throw new RpcError("busy", "a turn is running for this agent");
    const session = await this.ensureSession();
    const opt = session.configOptions.find((o) => o.id === configId);
    if (!opt) throw new RpcError("bad_request", `unknown configId ${configId}`);
    if (!opt.options.some((v) => v.value === value)) {
      throw new RpcError("bad_request", `invalid value ${value} for ${configId}`);
    }
    await session.setConfigOption(configId, value);
    opt.currentValue = value;
    const config = { ...this.agent.config, [configId]: value };
    this.agents.setConfig(this.agent.id, config);
    this.agent = { ...this.agent, config };
    this.broadcast("agent.updated", this.agent);
    this.broadcast("agent.config", {
      agentId: this.agent.id,
      configOptions: session.configOptions,
    });
    return session.configOptions;
  }

  // ---- Permissions ----

  respondPermission(requestId: string, optionId: string | null): void {
    const p = this.pending.get(requestId);
    if (!p) throw new RpcError("not_found", "permission request not found or already resolved");
    if (optionId !== null && !p.options.some((o) => o.optionId === optionId)) {
      throw new RpcError("bad_request", "optionId is not among the request's options");
    }
    this.pending.delete(requestId);
    this.resolvePermissionItem(p, optionId);
    p.resolve({ optionId });
    if (this.status === "awaiting_permission" && this.pending.size === 0) {
      this.setStatus("running");
    }
  }

  listPending(): PendingPermission[] {
    return [...this.pending.values()].map((p) => ({
      requestId: p.requestId,
      agentId: this.agent.id,
      turnId: p.turnId,
      title: p.title,
      toolKind: p.toolKind,
      options: p.options,
    }));
  }

  /** Marks every pending permission cancelled in DB/events and unblocks the provider call. */
  private cancelAllPending(): void {
    for (const [requestId, p] of this.pending) {
      this.pending.delete(requestId);
      this.resolvePermissionItem(p, null);
      p.resolve({ optionId: null });
    }
  }

  private resolvePermissionItem(p: PendingEntry, optionId: string | null): void {
    const item = this.store.getItem(p.itemId);
    if (item?.kind !== "permission") return;
    const updated = this.store.updateItemData(item.id, {
      requestId: item.requestId,
      title: item.title,
      options: item.options,
      resolution: { optionId },
    });
    this.broadcast("item.updated", updated);
    this.broadcast("permission.resolved", {
      requestId: p.requestId,
      agentId: this.agent.id,
      optionId,
    });
  }

  private onPermissionRequest(req: {
    title: string;
    toolKind: string | null;
    options: PermissionOption[];
  }): Promise<{ optionId: string | null }> {
    const turn = this.turn;
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const entry: PendingEntry = {
        requestId,
        turnId: turn?.id ?? "",
        title: req.title,
        toolKind: req.toolKind,
        options: req.options,
        itemId: "",
        resolve,
      };
      const item = this.store.createItem(this.agent.id, turn?.id ?? null, "permission", {
        requestId,
        title: req.title,
        options: req.options,
        resolution: null,
      });
      entry.itemId = item.id;
      this.pending.set(requestId, entry);
      this.broadcast("item.created", item);
      const pending: PendingPermission = {
        requestId,
        agentId: this.agent.id,
        turnId: entry.turnId,
        title: req.title,
        toolKind: req.toolKind,
        options: req.options,
      };
      this.broadcast("permission.requested", pending);
      if (!turn?.cancelled) this.setStatus("awaiting_permission");
    });
  }

  // ---- Updates ----

  private onUpdate(u: Parameters<ProviderHooks["onUpdate"]>[0]): void {
    if (u.type === "config_update") {
      this.configOptions = u.configOptions;
      this.broadcast("agent.config", {
        agentId: this.agent.id,
        configOptions: u.configOptions,
      });
      return;
    }
    if (u.type === "mode_update") {
      const modeOpt = this.configOptions.find((o) => o.category === "mode" || o.id === "mode");
      if (modeOpt && u.modeId) {
        modeOpt.currentValue = u.modeId;
        this.broadcast("agent.config", {
          agentId: this.agent.id,
          configOptions: this.configOptions,
        });
      }
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    switch (u.type) {
      case "message_chunk":
        this.appendChunk("agent_message", u.text);
        break;
      case "thought_chunk":
        this.appendChunk("agent_thought", u.text);
        break;
      case "tool_call": {
        this.openTextItem = null;
        const item = this.store.createItem(this.agent.id, turn.id, "tool_call", {
          toolCallId: u.toolCallId,
          title: u.title,
          toolKind: u.toolKind,
          status: u.status,
          detail: u.detail,
        });
        this.broadcast("item.created", item);
        break;
      }
      case "tool_call_update": {
        const item = this.store.findToolCallItem(turn.id, u.toolCallId);
        if (item?.kind !== "tool_call") return;
        const updated = this.store.updateItemData(item.id, {
          toolCallId: item.toolCallId,
          title: u.title ?? item.title,
          toolKind: item.toolKind,
          status: u.status ?? item.status,
          detail: u.detail === undefined ? item.detail : u.detail,
        });
        this.broadcast("item.updated", updated);
        break;
      }
      case "ignored":
        break;
    }
  }

  private appendChunk(kind: "agent_message" | "agent_thought", text: string): void {
    const turn = this.turn;
    if (!turn) return;
    if (this.openTextItem && this.openTextItem.kind === kind) {
      const item = this.store.appendItemText(this.openTextItem.id, text);
      this.broadcast("item.delta", { agentId: this.agent.id, itemId: item.id, text });
    } else {
      const item = this.store.createItem(this.agent.id, turn.id, kind, { text });
      this.openTextItem = { id: item.id, kind };
      this.broadcast("item.created", item);
    }
  }

  private onProcessExit(error: string | null): void {
    const dead = this.session;
    this.session = null;
    this.sessionStarting = null;
    const turn = this.turn;
    if (turn && this.status !== "error") {
      const message = error ?? "provider process exited";
      const errItem = this.store.createItem(this.agent.id, turn.id, "error", { message });
      this.broadcast("item.created", errItem);
      this.finishTurn(turn, "failed", null, message);
      this.setStatus("error", message);
    }
    void dead;
  }

  private dropSession(): void {
    const s = this.session ?? null;
    this.session = null;
    this.sessionStarting = null;
    this.sessionTag = null;
    s?.close().catch(() => {});
  }

  /** Cancel any running turn and kill the provider process. */
  async dispose(resumeAfter = false): Promise<void> {
    this.disposing = true;
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }
    const turn = this.turn;
    if (turn) {
      turn.cancelled = true;
      this.finishTurn(turn, "cancelled", "cancelled", null);
    }
    const starting = this.sessionStarting;
    this.dropSession();
    this.sessionTag = null;
    if (starting) {
      try {
        const s = await starting;
        await s.close();
      } catch {}
    }
    this.disposing = false;
    if (resumeAfter) this.drain();
  }

  async kill(): Promise<void> {
    await this.dispose();
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
