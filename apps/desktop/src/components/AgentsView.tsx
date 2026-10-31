import type { Agent, ProviderId } from "@boto/protocol";
import { useMemo, useState } from "react";
import type { AgentOverview } from "../hooks/useOverview";
import { MonoAv, Pill, role, statusProvider } from "../lib/ui";
import { Icon } from "./icons";

function isAskMode(agent: Agent) {
  return (
    (agent.provider === "claude" && agent.config.mode === "plan") ||
    (agent.provider === "codex" && agent.config.mode === "read-only")
  );
}

export function AgentsView({
  agents,
  overview,
  onCreate,
  onOpen,
}: {
  agents: Agent[];
  overview: Record<string, AgentOverview>;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const providers = useMemo(() => [...new Set(agents.map((agent) => agent.provider))], [agents]);
  const [filter, setFilter] = useState<ProviderId | "all">("all");
  const shown = filter === "all" ? agents : agents.filter((agent) => agent.provider === filter);
  return (
    <section className="view on">
      <div className="page">
        <div className="page-inner">
          <div className="page-top">
            <div>
              <h1>Bots</h1>
              <p>
                Cada bot tem uma função, as ferramentas que pode usar e o quanto pode agir sem
                perguntar.
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={onCreate}>
              Criar bot
            </button>
          </div>
          <fieldset className="filters">
            <legend className="sr">Filtrar bots</legend>
            <button
              type="button"
              className="chip"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              Todos
            </button>
            {providers.map((provider) => (
              <button
                key={provider}
                type="button"
                className="chip"
                aria-pressed={filter === provider}
                onClick={() => setFilter(provider)}
              >
                {statusProvider(provider)}
              </button>
            ))}
          </fieldset>
          <div className="grid" id="agentGrid">
            {shown.map((agent) => {
              const info = overview[agent.id];
              const appTags = info?.apps.flatMap((app) => app.tools.map((tool) => tool.name)) ?? [];
              const tools = [
                statusProvider(agent.provider),
                ...appTags,
                ...(info?.emailAccounts.length ? ["E-mail"] : []),
              ];
              return (
                <article className="a-card" key={agent.id}>
                  <div className="top">
                    <MonoAv agent={agent} status={info?.status ?? "idle"} lg />
                    <Pill st={info?.status ?? "idle"} />
                  </div>
                  <div>
                    <h3>{agent.name}</h3>
                    <p style={{ marginTop: 4 }}>{role(agent)}</p>
                  </div>
                  <div className="tags">
                    {tools.map((tool) => (
                      <span className="tag" key={tool}>
                        {tool}
                      </span>
                    ))}
                  </div>
                  <div className="foot">
                    <span className="meta">
                      {isAskMode(agent) ? "Só sugere" : "Age e pede aprovação"}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => onOpen(agent.id)}
                    >
                      Abrir conversa
                    </button>
                  </div>
                </article>
              );
            })}
            <button type="button" className="a-card new" onClick={onCreate}>
              <Icon name="plus" />
              <h3>Novo bot</h3>
              <span style={{ fontSize: 13 }}>Defina função, ferramentas e autonomia</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
