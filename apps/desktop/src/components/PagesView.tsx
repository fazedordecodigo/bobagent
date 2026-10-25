import type { Agent, Page } from "@upbot/protocol";
import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { btnCls } from "./AgentSettings";

export function PagesView({
  client,
  agents,
  onOpenBot,
}: {
  client: DaemonClient;
  agents: Agent[];
  onOpenBot: (id: string) => void;
}) {
  const [pages, setPages] = useState<Page[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .request("pages.list", {})
      .then(setPages)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    load();
    return client.on("pages.changed", load);
  }, [client, load]);
  const page = pages.find((p) => p.id === selected) ?? pages[0] ?? null;
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "deleted bot";
  return (
    <div className="flex h-full">
      <ul className="w-64 shrink-0 overflow-y-auto border-r border-zinc-800">
        <li className="px-4 py-3 text-sm font-semibold">Pages</li>
        {pages.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => setSelected(p.id)}
              className={`w-full px-4 py-2 text-left text-sm hover:bg-zinc-900 ${
                page?.id === p.id ? "bg-zinc-900" : ""
              }`}
            >
              <div className="truncate font-medium">{p.title}</div>
              <div className="truncate text-xs text-zinc-500">
                {nameOf(p.agentId)} · v{p.version} · {new Date(p.updatedAt).toLocaleDateString()}
              </div>
            </button>
          </li>
        ))}
        {pages.length === 0 && (
          <li className="px-4 py-2 text-xs text-zinc-500">
            No pages yet. Ask a bot for a report, dashboard or tracker and it can publish it here.
          </li>
        )}
      </ul>
      {page ? (
        <div className="flex flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{page.title}</div>
              <div className="truncate text-xs text-zinc-500" title={page.path}>
                {page.description || page.path}
              </div>
            </div>
            <button
              type="button"
              className={`${btnCls} ml-auto bg-zinc-700 hover:bg-zinc-600`}
              onClick={() => onOpenBot(page.agentId)}
            >
              Ask {nameOf(page.agentId)}
            </button>
            <button
              type="button"
              className={`${btnCls} bg-zinc-800 hover:bg-red-900`}
              onClick={() => client.request("pages.delete", { id: page.id }).catch(() => {})}
            >
              Delete
            </button>
          </div>
          <iframe
            key={`${page.id}:${page.version}`}
            title={page.title}
            src={page.url}
            sandbox="allow-scripts"
            className="flex-1 bg-white"
          />
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}
