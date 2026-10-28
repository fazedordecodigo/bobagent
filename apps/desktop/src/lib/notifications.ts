import type { Approval, ApprovalDecision } from "@upbot/protocol";
import { type ApprovalResult, decideApproval } from "./approval-decisions";
import { describeApproval } from "./approval-description";
import type { DaemonClient } from "./daemon";

export type NotificationAction = "approve" | "deny" | "task" | "review" | "undo";
export type DecisionNotification = {
  id: string;
  title: string;
  body: string;
  actions: { id: NotificationAction; label: string }[];
  muted: boolean;
};
export type NotificationResponse = { id: string; action: string };
export interface NotificationBridge {
  initialize(): Promise<boolean>;
  post(notification: DecisionNotification): Promise<void>;
  remove(id: string): Promise<void>;
  listen(handler: (response: NotificationResponse) => void): Promise<() => void>;
  open(): Promise<void>;
}
type Preferences = Pick<Storage, "getItem" | "setItem">;
export const MUTE_KEY = "upbot.notifications.muteUntil";
const SEEN_KEY = "upbot.notifications.seen";
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const limits = { title: 110, body: 180 };

export function muteUntil(preferences: Preferences): number {
  const value = Number(preferences.getItem(MUTE_KEY));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function muteForHour(preferences: Preferences, now = Date.now()) {
  const until = now + 60 * 60 * 1000;
  preferences.setItem(MUTE_KEY, String(until));
  return until;
}

function notificationDetails(detail: string) {
  const labels: Record<string, string> = {
    to: "Para",
    recipient: "Para",
    recipients: "Para",
    attachment: "Anexo",
    attachments: "Anexos",
    total: "Total",
    amount: "Valor",
    currency: "Moeda",
    subject: "Assunto",
    title: "Título",
    body: "Mensagem",
    text: "Mensagem",
    content: "Conteúdo",
    name: "Nome",
  };
  try {
    const args: unknown = JSON.parse(detail);
    if (!args || typeof args !== "object" || Array.isArray(args))
      return {
        body: "Revise os detalhes no UpBot.",
        complete: false,
        recipient: false,
        message: false,
      };
    const fields = Object.entries(args);
    let complete = true;
    const body = fields
      .flatMap(([key, value]) => {
        if (!Object.hasOwn(labels, key)) {
          complete = false;
          return [];
        }
        const values = Array.isArray(value) ? value : [value];
        if (
          !values.length ||
          values.some((v) => !["string", "number"].includes(typeof v) || !String(v).trim())
        ) {
          complete = false;
          return [];
        }
        const text = oneLine(values.join(", "));
        if (/[\r\n]/.test(values.join(""))) complete = false;
        return [`${labels[key]}: ${text}`];
      })
      .join(" · ");
    return {
      body,
      complete: complete && body.length <= limits.body,
      recipient: fields.some(
        ([key, value]) => ["to", "recipient", "recipients"].includes(key) && Boolean(value),
      ),
      message: fields.some(
        ([key, value]) => ["body", "text", "content"].includes(key) && Boolean(value),
      ),
    };
  } catch {
    return {
      body: "Revise os detalhes no UpBot.",
      complete: false,
      recipient: false,
      message: false,
    };
  }
}

export function decisionNotification(
  approval: Approval,
  botName: string,
  muted: boolean,
  now = Date.now(),
): DecisionNotification | null {
  if (approval.status !== "pending" || approval.expiresAt <= now) return null;
  const title =
    approval.kind === "tool"
      ? describeApproval(approval, botName).description
      : `${botName} precisa de você no UpBot.`;
  const details = notificationDetails(approval.detail);
  const tool = approval.tool ?? "";
  const operation = /^[a-z]+(?:[_-][a-z]+)?$/i.test(tool)
    ? tool.split(/[_-]/)[0]?.toLowerCase()
    : null;
  const kind =
    approval.permission ??
    (operation && /^(send|post|publish|reply|dispatch|deliver)$/.test(operation)
      ? "send"
      : operation && /^(get|read|list|search|create|update|edit|write)$/.test(operation)
        ? "write"
        : null);
  const fits = title.length <= limits.title && details.complete && approval.kind === "tool";
  const inline =
    fits &&
    kind !== null &&
    kind !== "pay" &&
    kind !== "book" &&
    kind !== "del" &&
    (kind !== "send" || (details.recipient && details.message));
  const actions: DecisionNotification["actions"] = inline
    ? approval.appId && approval.permission
      ? [
          { id: "deny", label: "Recusar" },
          { id: "task", label: "Só nesta tarefa" },
        ]
      : [
          { id: "approve", label: kind === "send" ? "Aprovar e enviar" : "Aprovar e executar" },
          { id: "review", label: "Revisar no app" },
        ]
    : [{ id: "review", label: "Revisar no UpBot" }];
  const body =
    approval.kind === "tool" ? details.body : "Abra o UpBot para continuar com segurança.";
  return {
    id: approval.id,
    title: title.length > limits.title ? `${title.slice(0, limits.title - 1)}…` : title,
    body: body.length > limits.body ? `${body.slice(0, limits.body - 1)}…` : body,
    actions,
    muted,
  };
}

export class ApprovalNotifications {
  private seen = new Set<string>();
  private active = new Map<string, Approval>();
  private local = new Set<string>();
  private busy = new Set<string>();
  private unavailable = new Set<string>();
  private results = new Map<string, { result: ApprovalResult; until: number }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private off: (() => void)[] = [];
  private stopped = false;
  private events: Promise<void> = Promise.resolve();

  constructor(
    private client: Pick<DaemonClient, "request" | "on" | "onReconnect">,
    private bridge: NotificationBridge,
    private preferences: Preferences,
    private botName: (agentId: string) => string,
    private review: (view: string, notice?: string) => void,
    private error: (message: string) => void,
    private now = Date.now,
    private decide = decideApproval,
  ) {
    try {
      const saved: unknown = JSON.parse(preferences.getItem(SEEN_KEY) ?? "[]");
      if (Array.isArray(saved)) this.seen = new Set(saved.filter((id) => typeof id === "string"));
    } catch {}
  }

  private fail(error: unknown) {
    if (!this.stopped) this.error(error instanceof Error ? error.message : String(error));
  }

  async start() {
    const off = await this.bridge.listen((response) => {
      void this.respond(response).catch((e) => this.fail(e));
    });
    if (this.stopped) {
      off();
      return;
    }
    this.off.push(off);
    if (!(await this.bridge.initialize())) return;
    if (this.stopped) return;
    const update = (approval: Approval) => {
      this.events = this.events.then(() => this.update(approval)).catch((e) => this.fail(e));
    };
    this.off.push(this.client.on("approval.updated", update));
    const sync = async () => {
      const approvals = await this.client.request("approvals.list", {});
      if (this.stopped) return;
      const pending = new Set(
        approvals
          .filter((a) => a.status === "pending" && a.expiresAt > this.now())
          .map((a) => a.id),
      );
      for (const id of this.seen)
        if (!pending.has(id) && !this.local.has(id)) await this.bridge.remove(id);
      for (const approval of approvals) update(approval);
      await this.events;
    };
    this.off.push(
      this.client.onReconnect(() => {
        void sync().catch((e) => this.fail(e));
      }),
    );
    await sync();
  }

  private async update(approval: Approval) {
    if (this.stopped) return;
    const notification = decisionNotification(
      approval,
      this.botName(approval.agentId),
      muteUntil(this.preferences) > this.now(),
      this.now(),
    );
    if (!notification) {
      this.active.delete(approval.id);
      if (!this.local.has(approval.id)) await this.bridge.remove(approval.id);
      return;
    }
    this.active.set(approval.id, approval);
    if (!this.timers.has(approval.id)) {
      this.timers.set(
        approval.id,
        setTimeout(
          () => {
            this.active.delete(approval.id);
            if (!this.local.has(approval.id))
              void this.bridge.remove(approval.id).catch((e) => this.fail(e));
          },
          Math.max(0, approval.expiresAt - this.now()),
        ),
      );
    }
    if (this.seen.has(approval.id)) return;
    await this.bridge.post(notification);
    if (this.stopped) return;
    this.seen.add(approval.id);
    try {
      this.preferences.setItem(SEEN_KEY, JSON.stringify([...this.seen].slice(-1000)));
    } catch {}
  }

  async respond({ id, action }: NotificationResponse) {
    if (this.stopped || this.busy.has(id) || this.unavailable.has(id)) return;
    if (action === "mute") {
      muteForHour(this.preferences, this.now());
      return;
    }
    if (action === "apps") {
      this.review("apps");
      await this.bridge.open();
      return;
    }
    this.busy.add(id);
    try {
      if (action === "undo") {
        const saved = this.results.get(id);
        if (!saved) {
          const approvals = await this.client.request("approvals.list", {});
          if (!approvals.some((approval) => approval.id === id)) await this.showUnavailable(id);
          return;
        }
        if (!saved?.result.undo || this.now() >= saved.until) return;
        await saved.result.undo();
        this.results.delete(id);
        await this.bridge.post({
          id,
          title: "Preferência restaurada.",
          body: "A ação executada não foi desfeita.",
          actions: [],
          muted: muteUntil(this.preferences) > this.now(),
        });
        return;
      }
      const approval = (await this.client.request("approvals.list", {})).find((a) => a.id === id);
      if (!approval) {
        await this.showUnavailable(id);
        return;
      }
      if (approval.status !== "pending" || approval.expiresAt <= this.now()) {
        await this.bridge.remove(id);
        return;
      }
      if (action === "review") {
        this.review(approval.agentId);
        await this.bridge.open();
        return;
      }
      const notification = decisionNotification(
        approval,
        this.botName(approval.agentId),
        false,
        this.now(),
      );
      if (!notification?.actions.some((item) => item.id === action)) return;
      this.local.add(id);
      let result: ApprovalResult;
      try {
        result = await this.decide(this.client, approval, action as ApprovalDecision);
      } catch (e) {
        this.local.delete(id);
        if (e instanceof Error && "code" in e && e.code === "not_found") {
          await this.showUnavailable(id);
          return;
        }
        await this.bridge.remove(id);
        throw e;
      }
      const until = this.now() + 6000;
      const replacement: DecisionNotification = {
        id,
        title: result.message,
        body: "",
        muted: muteUntil(this.preferences) > this.now(),
        actions: result.undo ? [{ id: "undo", label: "Desfazer" }] : [],
      };
      this.results.set(id, { result, until });
      await this.bridge.post(replacement);
      clearTimeout(this.timers.get(id));
      this.timers.set(
        id,
        setTimeout(() => {
          this.results.delete(id);
          void this.bridge.remove(id).catch((e) => this.fail(e));
        }, 6000),
      );
    } finally {
      this.busy.delete(id);
    }
  }

  private async showUnavailable(id: string) {
    this.unavailable.add(id);
    this.review(
      "approvals",
      "Esse pedido não está mais disponível. O UpBot foi fechado antes da decisão.",
    );
    await Promise.all([this.bridge.open(), this.bridge.remove(id)]);
  }

  stop() {
    this.stopped = true;
    for (const off of this.off) off();
    for (const timer of this.timers.values()) clearTimeout(timer);
  }
}
