import type { Agent, AgentStatus, PendingPermission, PermissionOption } from "@openagent/protocol";
import type { ChatStore } from "../chat-store";
import { checkProviderAvailable, getDriver } from "../providers/acp";
import { ProviderError, type ProviderHooks, type ProviderSession } from "../providers/types";

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
  Math.max(0, Number.parseInt(process.env.OPENAGENT_CANCEL_GRACE_MS ?? "", 10) || 10_000);

export class AgentRuntime {
  status: AgentStatus = "idle";
  statusError: string | null = null;
  private turn: { id: string; cancelled: boolean } | null = null;
  private session: ProviderSession | null = null;
  private sessionStarting: Promise<ProviderSession> | null = null;
  private sessionPromptCount = 0;
  private openTextItem: { id: string; kind: "agent_message" | "agent_thought" } | null = null;
  private pending = new Map<string, PendingEntry>();
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private agent: Agent,
    private store: ChatStore,
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

  private hooks(): ProviderHooks {
    return {
      onUpdate: (u) => this.onUpdate(u),
      requestPermission: (req) => this.onPermissionRequest(req),
      onExit: (err) => this.onProcessExit(err),
    };
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

  send(text: string): { turnId: string } {
    if (this.turn) throw new RpcError("busy", "a turn is already running for this agent");
    checkProviderAvailable(this.agent.provider); // throws provider_unavailable early

    const turnRow = this.store.createTurn(this.agent.id);
    this.turn = { id: turnRow.id, cancelled: false };
    this.openTextItem = null;
    const userItem = this.store.createItem(this.agent.id, turnRow.id, "user_message", { text });
    this.setStatus("starting");
    this.broadcast("turn.started", turnRow);
    this.broadcast("item.created", userItem);
    this.runTurn(text).catch(() => {});
    return { turnId: turnRow.id };
  }

  private async ensureSession(): Promise<ProviderSession> {
    if (this.session) return this.session;
    this.sessionStarting ??= (async () => {
      const stored = this.store.getAgentSession(this.agent.id);
      const resumeSessionId =
        stored && stored.provider === this.agent.provider ? stored.sessionId : null;
      const driver = getDriver(this.agent.provider);
      const session = await driver.start({
        cwd: this.agent.workspacePath,
        resumeSessionId,
        hooks: this.hooks(),
      });
      this.store.upsertAgentSession(this.agent.id, this.agent.provider, session.sessionId);
      return session;
    })();
    try {
      this.session = await this.sessionStarting;
      this.sessionPromptCount = 0;
      return this.session;
    } finally {
      this.sessionStarting = null;
    }
  }

  private async runTurn(userText: string): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    try {
      const session = await this.ensureSession();
      if (turn.cancelled || this.turn !== turn)
        return this.finishTurn(turn, "cancelled", null, null);
      this.setStatus("running");

      let promptText = userText;
      const instructions = this.agent.instructions.trim();
      if (!session.resumed && this.sessionPromptCount === 0 && instructions) {
        promptText = `<agent_instructions>\n${instructions}\n</agent_instructions>\n\n${userText}`;
      }
      this.sessionPromptCount += 1;
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
    turn: { id: string; cancelled: boolean },
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
  }

  cancel(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.cancelled = true;
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

  private onUpdate(u: Parameters<ProviderHooks["onUpdate"]>[0]): void {
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
    s?.close().catch(() => {});
  }

  /** Cancel any running turn and kill the provider process. */
  async dispose(): Promise<void> {
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
    if (starting) {
      try {
        const s = await starting;
        await s.close();
      } catch {}
    }
  }

  /** Provider change or agent deletion: hard shutdown. */
  async kill(): Promise<void> {
    await this.dispose();
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
