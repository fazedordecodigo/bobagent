import type { Agent } from "@upbot/protocol";
import type { AgentOverview } from "../hooks/useOverview";
import { MonoAv, Pill, type UiStatus } from "../lib/ui";

const TASK_ORDER: Record<UiStatus, number> = {
  err: 0,
  wait: 1,
  run: 2,
  queue: 3,
  ok: 4,
  idle: 5,
};

export function TasksView({
  agents,
  overview,
  onOpen,
}: {
  agents: Agent[];
  overview: Record<string, AgentOverview>;
  onOpen: (id: string) => void;
}) {
  const tasks = agents
    .filter((agent) => overview[agent.id]?.task)
    .sort(
      (a, b) =>
        TASK_ORDER[overview[a.id]?.status ?? "idle"] - TASK_ORDER[overview[b.id]?.status ?? "idle"],
    );
  return (
    <section className="view on">
      <div className="page">
        <div className="page-inner">
          <div className="page-top">
            <div>
              <h1>Tarefas</h1>
              <p>
                Tudo o que seus bots estão fazendo, em um só lugar. O que espera por você vem
                primeiro.
              </p>
            </div>
          </div>
          <table className="ds-table" data-od-id="task-table">
            <thead>
              <tr>
                <th>Tarefa</th>
                <th>Bot</th>
                <th>Status</th>
                <th className="hide-sm">Atualizado</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={4} className="meta">
                    Nenhuma tarefa ainda.
                  </td>
                </tr>
              ) : (
                tasks.map((agent) => {
                  const info = overview[agent.id];
                  return (
                    <tr
                      key={agent.id}
                      tabIndex={0}
                      onClick={() => onOpen(agent.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onOpen(agent.id);
                      }}
                    >
                      <td>{info?.task}</td>
                      <td className="agent">
                        <MonoAv agent={agent} dot={false} />
                        {agent.name}
                      </td>
                      <td>
                        <Pill st={info?.status ?? "idle"} />
                      </td>
                      <td className="meta hide-sm">{info?.updated ?? "—"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
