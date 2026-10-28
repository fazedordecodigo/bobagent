import type { Agent } from "@upbot/protocol";
import type { DaemonClient } from "../lib/daemon";
import { moveControlFocus } from "../lib/keyboard";
import { ApprovalsView } from "./ApprovalsView";
import { AppsView } from "./AppsView";
import { EmailView } from "./EmailView";
import { HostsView } from "./HostsView";
import {
  BrowserView,
  GatewaysView,
  MarketplaceView,
  MobileView,
  SkillsView,
  TeamView,
  VaultView,
} from "./Library";

export type ToolTab =
  | "apps"
  | "approvals"
  | "email"
  | "skills"
  | "marketplace"
  | "browser"
  | "vault"
  | "gateways"
  | "mobile"
  | "team"
  | "hosts";

export const TABS: { id: ToolTab; label: string; hint: string }[] = [
  { id: "apps", label: "Apps", hint: "Conecte apps para todos os bots" },
  { id: "approvals", label: "Aprovações", hint: "Regras de aprovação e pedidos pendentes" },
  { id: "email", label: "E-mail", hint: "Contas de e-mail e rascunhos" },
  { id: "skills", label: "Habilidades", hint: "Biblioteca de habilidades compartilhadas" },
  { id: "marketplace", label: "Marketplace", hint: "Instale habilidades e modelos de bot" },
  { id: "browser", label: "Navegador", hint: "Abas controladas pelos bots" },
  { id: "vault", label: "Cofre", hint: "Segredos criptografados e conectores" },
  { id: "gateways", label: "Gateways", hint: "Telegram, Slack e Discord" },
  { id: "mobile", label: "Celular", hint: "Emparelhe seu celular nesta rede" },
  { id: "team", label: "Equipe", hint: "Compartilhe bots por um relay" },
  { id: "hosts", label: "Servidores", hint: "Execute bots em VPS ou microVMs" },
];

export function ToolBody({
  client,
  agents,
  tab,
}: {
  client: DaemonClient;
  agents: Agent[];
  tab: ToolTab;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      {tab === "apps" && <AppsView client={client} agents={agents} />}
      {tab === "approvals" && <ApprovalsView client={client} agents={agents} />}
      {tab === "email" && <EmailView client={client} agents={agents} />}
      {tab === "skills" && <SkillsView client={client} />}
      {tab === "marketplace" && <MarketplaceView client={client} />}
      {tab === "browser" && <BrowserView client={client} agents={agents} />}
      {tab === "vault" && <VaultView client={client} agents={agents} />}
      {tab === "gateways" && <GatewaysView client={client} agents={agents} />}
      {tab === "mobile" && <MobileView client={client} />}
      {tab === "team" && <TeamView client={client} agents={agents} />}
      {tab === "hosts" && <HostsView client={client} agents={agents} />}
    </div>
  );
}

export function ToolsView({
  client,
  agents,
  tab,
  onTab,
}: {
  client: DaemonClient;
  agents: Agent[];
  tab: ToolTab;
  onTab: (t: ToolTab) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 px-4 pt-3"
        role="tablist"
        aria-label="Ferramentas"
        onKeyDown={moveControlFocus}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            title={t.hint}
            onClick={() => onTab(t.id)}
            className={`rounded-t-md px-3 py-2 text-sm whitespace-nowrap transition-colors ${
              tab === t.id
                ? "border-b-2 border-sky-400 bg-zinc-900 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ToolBody client={client} agents={agents} tab={tab} />
    </div>
  );
}
