import type { Agent } from "@bobagent/protocol";
import type { DaemonClient } from "../lib/daemon";
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
  | "skills"
  | "marketplace"
  | "browser"
  | "vault"
  | "gateways"
  | "mobile"
  | "team";

const TABS: { id: ToolTab; label: string; hint: string }[] = [
  { id: "skills", label: "Skills", hint: "Shared skills library" },
  { id: "marketplace", label: "Marketplace", hint: "Install skills and agent templates" },
  { id: "browser", label: "Browser", hint: "Agent-controlled Chrome tabs" },
  { id: "vault", label: "Vault", hint: "Encrypted secrets and connectors" },
  { id: "gateways", label: "Gateways", hint: "Telegram, Slack and Discord" },
  { id: "mobile", label: "Mobile", hint: "Pair your phone on this network" },
  { id: "team", label: "Team", hint: "Share agents through a relay" },
];

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
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
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
      <div className="flex-1 overflow-y-auto">
        {tab === "skills" && <SkillsView client={client} />}
        {tab === "marketplace" && <MarketplaceView client={client} />}
        {tab === "browser" && <BrowserView client={client} agents={agents} />}
        {tab === "vault" && <VaultView client={client} agents={agents} />}
        {tab === "gateways" && <GatewaysView client={client} agents={agents} />}
        {tab === "mobile" && <MobileView client={client} />}
        {tab === "team" && <TeamView client={client} agents={agents} />}
      </div>
    </div>
  );
}
