import type { Agent, Routine } from "@upbot/protocol";
import { useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";

export function ScheduledView({
  client,
  agents,
  onOpen,
}: {
  client: DaemonClient;
  agents: Agent[];
  onOpen: (id: string) => void;
}) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    if (retry > 0) {
      setError(null);
      setRoutines(null);
    }
    const refresh = () =>
      void client
        .request("routines.list", {})
        .then((items) => {
          if (alive) {
            setRoutines(items);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    refresh();
    const offs = [
      client.on("routine.updated", refresh),
      client.on("routine.deleted", refresh),
      client.onReconnect(refresh),
    ];
    return () => {
      alive = false;
      for (const off of offs) off();
    };
  }, [client, retry]);
  return (
    <section className="view on">
      <div className="page">
        <div className="page-inner">
          <div className="page-top">
            <div>
              <h1>Agendadas</h1>
              <p>Rotinas dos seus bots.</p>
            </div>
          </div>
          {error ? (
            <div role="alert">
              <p>Não foi possível carregar as rotinas: {error}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setRetry((value) => value + 1)}
              >
                Tentar novamente
              </button>
            </div>
          ) : routines === null ? (
            <p role="status">Carregando rotinas…</p>
          ) : routines.length === 0 ? (
            <p>Nenhuma rotina ainda. Abra as configurações de um bot para criar uma.</p>
          ) : (
            <ul className="scheduled-list">
              {routines.map((routine) => {
                const bot = agents.find((agent) => agent.id === routine.agentId);
                return (
                  <li key={routine.id}>
                    <button
                      type="button"
                      className="scheduled-row"
                      disabled={!bot}
                      onClick={() => onOpen(routine.agentId)}
                    >
                      <b>{routine.name}</b>
                      <span>
                        {bot?.name ?? "Bot removido"} · {routine.enabled ? "Ativa" : "Desativada"}
                      </span>
                      <small>
                        {routine.schedule ??
                          (routine.webhook ? "Por webhook" : "Sem horário agendado")}
                        {routine.nextRunAt
                          ? ` · Próxima: ${new Date(routine.nextRunAt).toLocaleString("pt-BR")}`
                          : ""}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
