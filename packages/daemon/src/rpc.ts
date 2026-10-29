import { type MethodName, type MethodParsedParams, methodMap } from "@upbot/protocol";
import type { AgentStore } from "./agents";
import type { ApprovalService } from "./approvals";
import type { AppsService } from "./apps";
import { attachmentsBlock, saveAttachments } from "./attachments";
import { type BrowserService, findBrowser } from "./browser";
import type { ChannelService } from "./channels";
import type { ChatStore, QueueStore } from "./chat-store";
import type { ComputerUse } from "./computer";
import { InvalidSettingError } from "./db/settings";
import { draftAgent } from "./draft";
import type { EmailService } from "./email";
import type { GatewayService } from "./gateways";
import type { Marketplace } from "./marketplace";
import type { MemoryStore } from "./memories";
import type { MobileServer } from "./mobile";
import type { PageLibrary } from "./pages";
import { ProviderError } from "./providers/types";
import type { VmCredentials } from "./remote/credentials";
import type { HostStore } from "./remote/hosts";
import type { RoutineService } from "./routines";
import { asBadRequest, RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";
import type { SkillLibrary } from "./skills";
import type { SubagentService } from "./subagents";
import type { TeamClient } from "./team";
import type { Vault } from "./vault";
import type { Voice } from "./voice";

export type Broadcast = (event: string, data: unknown) => void;

type ErrorDiagnostics = { type: string; code?: string; status?: number; cause?: ErrorDiagnostics };
const IDENT = /^[A-Za-z_$][\w$]{0,63}$/;
const CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

// Messages and stacks are omitted because they can embed URLs or tokens.
function errorDiagnostics(e: unknown, depth = 0): ErrorDiagnostics {
  if (typeof e !== "object" || e === null) return { type: typeof e };
  const error = e as {
    constructor?: { name?: unknown };
    code?: unknown;
    status?: unknown;
    cause?: unknown;
  };
  const type =
    typeof error.constructor?.name === "string" && IDENT.test(error.constructor.name)
      ? error.constructor.name
      : "unknown";
  const diagnostics: ErrorDiagnostics = { type };
  if (typeof error.code === "string" && CODE.test(error.code)) diagnostics.code = error.code;
  if (
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
  )
    diagnostics.status = error.status;
  if (error.cause !== undefined && depth < 3)
    diagnostics.cause = errorDiagnostics(error.cause, depth + 1);
  return diagnostics;
}

export class Rpc {
  constructor(
    private agents: AgentStore,
    private chat: ChatStore,
    private queue: QueueStore,
    private runtimes: RuntimeManager,
    private broadcast: Broadcast,
    private channels: ChannelService,
    private memories: MemoryStore,
    private skills: SkillLibrary,
    private routines: RoutineService,
    private browser: BrowserService,
    private extras: {
      vault: Vault;
      vmCredentials: VmCredentials;
      computer: ComputerUse;
      voice: Voice;
      gateways: GatewayService;
      email: EmailService;
      apps: AppsService;
      approvals: ApprovalService;
      pages: PageLibrary;
      marketplace: Marketplace;
      mobile: MobileServer;
      team: TeamClient;
      hosts: HostStore;
      subagents: SubagentService;
    },
  ) {}

  /** Returns the response payload string for one raw incoming message. */
  async handle(raw: string): Promise<string> {
    let parsed: { id?: unknown; method?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return JSON.stringify({ id: "", error: { code: "bad_request", message: "invalid JSON" } });
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const method = parsed.method;
    if (typeof method !== "string" || !(method in methodMap)) {
      return JSON.stringify({
        id,
        error: { code: "bad_request", message: `unknown method: ${String(method)}` },
      });
    }
    const def = methodMap[method as MethodName];
    const paramsRes = def.params.safeParse(parsed.params ?? {});
    if (!paramsRes.success) {
      return JSON.stringify({
        id,
        error: {
          code: "bad_request",
          message: paramsRes.error.issues[0]?.message ?? "invalid params",
        },
      });
    }
    const startedAt = performance.now();
    try {
      const result = await this.dispatch(method as MethodName, paramsRes.data);
      return JSON.stringify({ id, result });
    } catch (e) {
      const durationMs = Math.round(performance.now() - startedAt);
      if (e instanceof RpcError) {
        if (e.code === "internal" || e.code === "busy" || e.cause !== undefined) {
          console.error(
            "[upbotd] rpc failed",
            JSON.stringify({ method, code: e.code, durationMs, error: errorDiagnostics(e) }),
          );
        }
        return JSON.stringify({ id, error: { code: e.code, message: e.message } });
      }
      if (e instanceof ProviderError) {
        console.error(
          "[upbotd] rpc failed",
          JSON.stringify({ method, code: e.code, durationMs, error: errorDiagnostics(e) }),
        );
        return JSON.stringify({ id, error: { code: e.code, message: e.message } });
      }
      if (e instanceof InvalidSettingError) {
        console.error(
          "[upbotd] handler error",
          JSON.stringify({ method, durationMs, error: errorDiagnostics(e) }),
        );
        return JSON.stringify({ id, error: { code: "internal", message: e.message } });
      }
      console.error(
        "[upbotd] handler error",
        JSON.stringify({ method, durationMs, error: errorDiagnostics(e) }),
      );
      return JSON.stringify({ id, error: { code: "internal", message: "internal error" } });
    }
  }

  private async dispatch(method: MethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case "agents.list":
        return this.agents.list();
      case "agents.create": {
        const agent = this.agents.create(params as MethodParsedParams<typeof method>);
        queueMicrotask(() => this.broadcast("agent.created", agent));
        return agent;
      }
      case "agents.update": {
        const p = params as MethodParsedParams<typeof method>;
        const before = this.agents.get(p.id);
        const agent = this.agents.update(p);
        if (!agent) throw new RpcError("not_found", "agent not found");
        if (before) void this.runtimes.agentUpdated(agent, before.provider !== agent.provider);
        queueMicrotask(() => this.broadcast("agent.updated", agent));
        return agent;
      }
      case "agents.delete": {
        const p = params as MethodParsedParams<typeof method>;
        const ok = this.agents.softDelete(p.id);
        if (!ok) throw new RpcError("not_found", "agent not found");
        this.queue.removeAllForAgent(p.id);
        this.runtimes.agentDeleted(p.id);
        queueMicrotask(() => this.broadcast("agent.deleted", { id: p.id }));
        return { ok: true };
      }
      case "agents.restore": {
        const agent = this.agents.restore((params as { id: string }).id);
        if (!agent) throw new RpcError("not_found", "deleted agent not found");
        queueMicrotask(() => this.broadcast("agent.created", agent));
        return agent;
      }
      case "chat.history": {
        const p = params as MethodParsedParams<typeof method>;
        if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
        this.runtimes.flushStreamText(p.agentId, p.beforeSeq);
        const { items, hasMore } = this.chat.history(p.agentId, p.beforeSeq, p.limit ?? 200);
        const turnIds = [...new Set(items.map((i) => i.turnId).filter((t): t is string => !!t))];
        return { items, turns: this.chat.turnsByIds(turnIds), hasMore };
      }
      case "chat.send": {
        const p = params as MethodParsedParams<typeof method>;
        if (!p.attachments?.length) return this.runtimes.send(p.agentId, p.text);
        const agent = this.agents.get(p.agentId);
        if (!agent) throw new RpcError("not_found", "agent not found");
        const saved = saveAttachments(agent.workspacePath, p.attachments);
        return this.runtimes.sendFrom(p.agentId, p.text, {
          agentId: null,
          hops: 0,
          prompt: attachmentsBlock(saved) + p.text,
          meta: { attachments: saved },
        });
      }
      case "queue.get": {
        const p = params as MethodParsedParams<typeof method>;
        return this.runtimes.getQueue(p.agentId);
      }
      case "queue.remove": {
        const p = params as MethodParsedParams<typeof method>;
        this.runtimes.removeQueued(p.queueId);
        return { ok: true };
      }
      case "queue.pause": {
        const p = params as MethodParsedParams<typeof method>;
        return this.runtimes.pauseQueue(p.agentId);
      }
      case "queue.resume": {
        const p = params as MethodParsedParams<typeof method>;
        return this.runtimes.resumeQueue(p.agentId);
      }
      case "agents.configOptions": {
        const p = params as MethodParsedParams<typeof method>;
        return { configOptions: await this.runtimes.configOptions(p.agentId) };
      }
      case "agents.setConfig": {
        const p = params as MethodParsedParams<typeof method>;
        return { configOptions: await this.runtimes.setConfig(p.agentId, p.configId, p.value) };
      }
      case "chat.cancel": {
        const p = params as MethodParsedParams<typeof method>;
        this.runtimes.cancel(p.agentId);
        return { ok: true };
      }
      case "agents.statuses":
        return this.runtimes.statuses();
      case "permissions.list":
        return this.runtimes.pendingPermissions();
      case "permissions.respond": {
        const p = params as MethodParsedParams<typeof method>;
        this.runtimes.respondPermission(p.requestId, p.optionId);
        return { ok: true };
      }
      case "agents.usage":
        return this.runtimes.usage((params as MethodParsedParams<typeof method>).agentId);
      case "agents.compact":
        await this.runtimes.compact((params as MethodParsedParams<typeof method>).agentId);
        return { ok: true };
      case "team.status":
        return this.extras.team.status();
      case "team.connect": {
        const p = params as MethodParsedParams<typeof method>;
        return this.extras.team.connect(p.url, p.token);
      }
      case "team.disconnect":
        this.extras.team.disconnect();
        return { ok: true };
      case "team.share":
        return this.extras.team.share((params as MethodParsedParams<typeof method>).agentIds);
      case "team.send": {
        const p = params as MethodParsedParams<typeof method>;
        return this.extras.team.send(p.memberId, p.agentId, p.text);
      }
      case "hosts.list":
        return this.extras.hosts.list();
      case "hosts.create": {
        const h = this.extras.hosts.create(params as MethodParsedParams<typeof method>);
        queueMicrotask(() => this.broadcast("hosts.changed", {}));
        return h;
      }
      case "hosts.delete": {
        if (!this.extras.hosts.delete((params as MethodParsedParams<typeof method>).id))
          throw new RpcError("not_found", "host not found");
        queueMicrotask(() => this.broadcast("hosts.changed", {}));
        return { ok: true };
      }
      case "hosts.install":
      case "hosts.check": {
        const id = (params as MethodParsedParams<typeof method>).id;
        if (!this.extras.hosts.get(id)) throw new RpcError("not_found", "host not found");
        const h = await asBadRequest(() =>
          method === "hosts.install" ? this.extras.hosts.install(id) : this.extras.hosts.check(id),
        );
        queueMicrotask(() => this.broadcast("hosts.changed", {}));
        return h;
      }
      case "vmCredentials.list":
        return this.extras.vmCredentials.list();
      case "vmCredentials.set": {
        const p = params as MethodParsedParams<typeof method>;
        const cred = this.extras.vmCredentials.set(p.provider, p.kind, p.value);
        queueMicrotask(() => this.broadcast("hosts.changed", {}));
        return cred;
      }
      case "vmCredentials.delete":
        this.extras.vmCredentials.delete((params as MethodParsedParams<typeof method>).provider);
        queueMicrotask(() => this.broadcast("hosts.changed", {}));
        return { ok: true };
      case "placements.list":
        return this.extras.hosts.placements();
      case "placements.set": {
        const p = params as MethodParsedParams<typeof method>;
        if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
        const placed = asBadRequest(() => this.extras.hosts.setPlacement(p));
        await this.runtimes.restartSession(p.agentId);
        queueMicrotask(() => this.broadcast("placement.updated", placed));
        return placed;
      }
      case "subagents.list":
        return this.extras.subagents.list((params as MethodParsedParams<typeof method>).parentId);
      case "team.messages":
        return this.extras.team.messages();
      case "mobile.status":
        return this.extras.mobile.status();
      case "mobile.enable":
        return this.extras.mobile.setEnabled((params as MethodParsedParams<typeof method>).enabled);
      case "mobile.pair":
        return this.extras.mobile.pair();
      case "mobile.revoke":
        this.extras.mobile.revoke((params as MethodParsedParams<typeof method>).id);
        return { ok: true };
      case "marketplace.list":
        return {
          sources: this.extras.marketplace.sources(),
          ...(await this.extras.marketplace.list()),
        };
      case "marketplace.install": {
        const p = params as MethodParsedParams<typeof method>;
        const r = await asBadRequest(() =>
          this.extras.marketplace.install(p.source, p.id, p.provider),
        );
        if (r.skills.length) this.broadcast("skills.changed", {});
        if (r.agent) {
          const agent = r.agent;
          queueMicrotask(() => this.broadcast("agent.created", agent));
        }
        return r;
      }
      case "marketplace.setSources":
        this.extras.marketplace.setSources((params as MethodParsedParams<typeof method>).urls);
        return { ok: true };
      case "gateways.list":
        return this.extras.gateways.list();
      case "gateways.create":
        return this.extras.gateways.create(params as MethodParsedParams<typeof method>);
      case "gateways.update":
        return this.extras.gateways.update(params as MethodParsedParams<typeof method>);
      case "gateways.delete":
        this.extras.gateways.delete((params as MethodParsedParams<typeof method>).id);
        return { ok: true };
      case "pages.list":
        return this.extras.pages.list();
      case "pages.delete":
        this.extras.pages.delete((params as MethodParsedParams<typeof method>).id);
        return { ok: true };
      case "approvals.list":
        return this.extras.approvals.list((params as MethodParsedParams<typeof method>).agentId);
      case "approvals.respond":
        return this.extras.approvals.respond(params as MethodParsedParams<typeof method>);
      case "approvals.rules":
        return this.extras.approvals.rules();
      case "approvals.setRules":
        return this.extras.approvals.setRules((params as MethodParsedParams<typeof method>).rules);
      case "apps.catalog":
        return this.extras.apps.catalog();
      case "apps.list":
        return this.extras.apps.list();
      case "apps.connect":
        return this.extras.apps.connect(params as MethodParsedParams<typeof method>);
      case "apps.update":
        return this.extras.apps.update(params as MethodParsedParams<typeof method>);
      case "apps.refresh":
        return this.extras.apps.refresh((params as MethodParsedParams<typeof method>).id);
      case "apps.delete":
        await this.extras.apps.delete((params as MethodParsedParams<typeof method>).id);
        return { ok: true };
      case "email.accounts.list":
        return this.extras.email.listAccounts();
      case "email.accounts.save":
        return this.extras.email.saveAccount(params as MethodParsedParams<typeof method>);
      case "email.accounts.delete":
        this.extras.email.deleteAccount((params as MethodParsedParams<typeof method>).id);
        return { ok: true };
      case "email.accounts.test":
        return this.extras.email.testAccount((params as MethodParsedParams<typeof method>).id);
      case "email.drafts.list":
        return this.extras.email.listDrafts(params as MethodParsedParams<typeof method>);
      case "email.drafts.update":
        return this.extras.email.updateDraft(params as MethodParsedParams<typeof method>);
      case "email.drafts.send":
        return this.extras.email.sendDraft((params as MethodParsedParams<typeof method>).id);
      case "email.drafts.discard":
        return this.extras.email.discardDraft((params as MethodParsedParams<typeof method>).id);
      case "vault.list":
        return this.extras.vault.list();
      case "vault.set": {
        const p = params as MethodParsedParams<typeof method>;
        this.extras.vault.set(p.name, p.value, p.agentIds);
        this.broadcast("vault.changed", {});
        return { ok: true };
      }
      case "vault.setAccess": {
        const p = params as MethodParsedParams<typeof method>;
        if (!this.extras.vault.setAccess(p.name, p.agentIds))
          throw new RpcError("not_found", "secret not found");
        this.broadcast("vault.changed", {});
        return { ok: true };
      }
      case "vault.delete":
        if (!this.extras.vault.delete((params as MethodParsedParams<typeof method>).name)) {
          throw new RpcError("not_found", "secret not found");
        }
        this.broadcast("vault.changed", {});
        return { ok: true };
      case "computer.access":
        return {
          available: this.extras.computer.available(),
          agentIds: this.extras.computer.access(),
        };
      case "computer.setAccess": {
        const ids = (params as MethodParsedParams<typeof method>).agentIds;
        if (ids.some((id) => !this.agents.get(id)))
          throw new RpcError("not_found", "agent not found");
        this.extras.computer.setAccess(ids);
        this.broadcast("computer.changed", { agentIds: this.extras.computer.access() });
        return { ok: true };
      }
      case "voice.status":
        return this.extras.voice.status();
      case "voice.speak":
        await asBadRequest(() =>
          this.extras.voice.speak((params as MethodParsedParams<typeof method>).text),
        );
        return { ok: true };
      case "voice.transcribe": {
        const p = params as MethodParsedParams<typeof method>;
        return {
          text: await asBadRequest(() => this.extras.voice.transcribe(p.audioBase64, p.mime)),
        };
      }
      case "browser.status":
        return {
          available: findBrowser() !== null && process.env.UPBOT_BROWSER !== "off",
          running: this.browser.running(),
          tabs: this.browser.list(),
        };
      case "browser.closeTab":
        if (!(await this.browser.closeTab((params as MethodParsedParams<typeof method>).agentId))) {
          throw new RpcError("not_found", "that agent has no browser tab");
        }
        return { ok: true };
      case "browser.close":
        await this.browser.close();
        return { ok: true };
      case "routines.list":
        return this.routines.list((params as MethodParsedParams<typeof method>).agentId);
      case "routines.create":
        return this.routines.create(params as MethodParsedParams<typeof method>);
      case "routines.update":
        return this.routines.update(params as MethodParsedParams<typeof method>);
      case "routines.delete":
        this.routines.delete((params as MethodParsedParams<typeof method>).id);
        return { ok: true };
      case "routines.run":
        return this.routines.run((params as MethodParsedParams<typeof method>).id, "manual");
      case "routines.runs":
        this.routines.get((params as MethodParsedParams<typeof method>).id);
        return this.routines.runs((params as MethodParsedParams<typeof method>).id);
      case "agents.draft":
        return draftAgent((params as MethodParsedParams<typeof method>).prompt);
      case "memories.list": {
        const p = params as MethodParsedParams<typeof method>;
        if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
        return this.memories.list(p.agentId);
      }
      case "memories.add": {
        const p = params as MethodParsedParams<typeof method>;
        if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
        const m = this.memories.add(p.agentId, p.text);
        this.broadcast("memories.changed", { agentId: p.agentId });
        return m;
      }
      case "memories.update": {
        const p = params as MethodParsedParams<typeof method>;
        const m = this.memories.update(p.id, p.text);
        if (!m) throw new RpcError("not_found", "memory not found");
        this.broadcast("memories.changed", { agentId: m.agentId });
        return m;
      }
      case "memories.delete": {
        const m = this.memories.get((params as MethodParsedParams<typeof method>).id);
        if (!m || !this.memories.delete(m.id)) throw new RpcError("not_found", "memory not found");
        this.broadcast("memories.changed", { agentId: m.agentId });
        return { ok: true };
      }
      case "skills.list":
        return this.skills.list();
      case "skills.get": {
        const s = this.skills.get((params as MethodParsedParams<typeof method>).name);
        if (!s) throw new RpcError("not_found", "skill not found");
        return s;
      }
      case "skills.save": {
        const p = params as MethodParsedParams<typeof method>;
        return asBadRequest(() => {
          const s = this.skills.save({ ...p, author: "user" }, "upsert");
          this.broadcast("skills.changed", {});
          return s;
        });
      }
      case "skills.delete": {
        if (!this.skills.delete((params as MethodParsedParams<typeof method>).name)) {
          throw new RpcError("not_found", "skill not found");
        }
        this.broadcast("skills.changed", {});
        return { ok: true };
      }
      case "channels.list":
        return this.channels.list((params as MethodParsedParams<typeof method>).includeArchived);
      case "channels.create":
        return this.channels.create(params as MethodParsedParams<typeof method>);
      case "channels.history": {
        const p = params as MethodParsedParams<typeof method>;
        return this.channels.history(p.channelId, p.limit);
      }
      case "channels.post": {
        const p = params as MethodParsedParams<typeof method>;
        return this.channels.post(p.channelId, p.text, p.replyTo);
      }
      case "channels.stop":
        return this.channels.stop((params as MethodParsedParams<typeof method>).channelId);
      case "channels.resume":
        return this.channels.resume((params as MethodParsedParams<typeof method>).channelId);
      case "channels.archive":
        return this.channels.archive((params as MethodParsedParams<typeof method>).channelId);
      case "channels.restore":
        return this.channels.restore((params as MethodParsedParams<typeof method>).channelId);
      case "channels.reassign": {
        const p = params as MethodParsedParams<typeof method>;
        return this.channels.reassign(p.channelId, p.ownerId);
      }
      default: {
        const _method: never = method;
        throw new RpcError("internal", `unhandled method: ${_method}`);
      }
    }
  }
}
