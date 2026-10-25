import type { Agent, AgentPlacement, RemoteHost, Subagent } from "@bobagent/protocol";
import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { btnCls, inputCls } from "./AgentSettings";

function Preflight({ h }: { h: RemoteHost }) {
  const p = h.preflight;
  if (!p) return <p className="text-xs text-zinc-500">Not installed — click Install.</p>;
  const ok = (v: boolean) => (v ? "text-emerald-400" : "text-amber-400");
  const providers = Object.entries(p.providers)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-zinc-400">
      <span>
        {p.os}/{p.arch} · kernel {p.kernelRelease} · bun {p.bun}
      </span>
      <span>CLIs: {providers.length ? providers.join(", ") : "none found"}</span>
      <span className={ok(p.kvm)}>/dev/kvm {p.kvm ? "ok" : "missing"}</span>
      <span className={ok(!!p.firecracker?.version)}>
        firecracker {p.firecracker?.version ?? "missing"}
      </span>
      <span className={ok(!!p.kernelImage && !!p.rootfs)}>
        guest image {p.kernelImage && p.rootfs ? "ok" : "missing (run rootfs/build-rootfs.sh)"}
      </span>
      <span className={ok(p.firecrackerReady)}>
        microVMs {p.firecrackerReady ? "ready" : "not available"}
      </span>
    </div>
  );
}

export function HostsView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [placements, setPlacements] = useState<AgentPlacement[]>([]);
  const [subs, setSubs] = useState<Subagent[]>([]);
  const [form, setForm] = useState({ name: "", target: "", port: "22", identityFile: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );

  const reload = useCallback(() => {
    client.request("hosts.list", {}).then(setHosts).catch(fail);
    client.request("placements.list", {}).then(setPlacements).catch(fail);
    client.request("subagents.list", {}).then(setSubs).catch(fail);
  }, [client, fail]);

  useEffect(() => {
    reload();
    const offs = [
      client.on("hosts.changed", reload),
      client.on("placement.updated", reload),
      client.on("subagent.updated", (s) =>
        setSubs((prev) => {
          const i = prev.findIndex((x) => x.agentId === s.agentId);
          return i >= 0 ? prev.map((x, j) => (j === i ? s : x)) : [...prev, s];
        }),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, reload]);

  const act = (id: string, method: "hosts.install" | "hosts.check") => {
    setBusy(id);
    setError(null);
    client
      .request(method, { id })
      .then(reload)
      .catch(fail)
      .finally(() => setBusy(null));
  };

  const place = (agentId: string, patch: Partial<AgentPlacement>) => {
    const cur = placements.find((p) => p.agentId === agentId) ?? {
      agentId,
      hostId: null,
      isolation: "none" as const,
      vcpus: 2,
      memMib: 2048,
    };
    const next = { ...cur, ...patch };
    if (!next.hostId) next.isolation = "none";
    setError(null);
    client
      .request("placements.set", {
        agentId,
        hostId: next.hostId,
        isolation: next.isolation,
        vcpus: next.vcpus,
        memMib: next.memMib,
      })
      .then(reload)
      .catch(fail);
  };

  const topLevel = agents.filter((a) => !subs.some((s) => s.agentId === a.id));
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">Remote hosts</h2>
        <p className="text-xs text-zinc-500">
          Run agents on a Linux VPS over SSH instead of this Mac. BobAgent uses your system{" "}
          <code>ssh</code> (keys from <code>~/.ssh</code> or the agent; nothing is stored here) and
          uploads a small helper to <code>~/.bobagent</code> on the host. With KVM and the guest
          image installed, each agent and subagent runs in its own Firecracker microVM.
        </p>
      </div>
      {error && <p className="rounded bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</p>}

      <section className="space-y-3">
        {hosts.map((h) => (
          <div
            key={h.id}
            className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{h.name}</span>
              <code className="text-xs text-zinc-500">
                {h.target}:{h.port}
              </code>
              <span className="flex-1" />
              <button
                type="button"
                className={btnCls}
                disabled={busy === h.id}
                onClick={() => act(h.id, "hosts.install")}
              >
                {busy === h.id ? "Working…" : h.root ? "Reinstall" : "Install"}
              </button>
              <button
                type="button"
                className={btnCls}
                disabled={busy === h.id || !h.root}
                onClick={() => act(h.id, "hosts.check")}
              >
                Check
              </button>
              <button
                type="button"
                className="text-xs text-red-400 hover:text-red-300"
                onClick={() =>
                  client.request("hosts.delete", { id: h.id }).then(reload).catch(fail)
                }
              >
                Remove
              </button>
            </div>
            <Preflight h={h} />
          </div>
        ))}
        <form
          className="grid grid-cols-[1fr_1.5fr_5rem] gap-2 rounded-lg border border-dashed border-zinc-800 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            client
              .request("hosts.create", {
                name: form.name || form.target,
                target: form.target,
                port: Number(form.port) || 22,
                identityFile: form.identityFile || null,
              })
              .then(() => {
                setForm({ name: "", target: "", port: "22", identityFile: "" });
                reload();
              })
              .catch(fail);
          }}
        >
          <input
            className={inputCls}
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="user@host"
            required
            value={form.target}
            onChange={(e) => setForm({ ...form, target: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="22"
            inputMode="numeric"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
          />
          <input
            className={`${inputCls} col-span-2`}
            placeholder="Identity file (optional, e.g. ~/.ssh/id_ed25519)"
            value={form.identityFile}
            onChange={(e) => setForm({ ...form, identityFile: e.target.value })}
          />
          <button type="submit" className={btnCls}>
            Add host
          </button>
        </form>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-zinc-300">Where agents run</h3>
        {topLevel.map((a) => {
          const p = placements.find((x) => x.agentId === a.id);
          const host = hosts.find((h) => h.id === p?.hostId);
          return (
            <div key={a.id} className="flex items-center gap-2 text-sm">
              <span className="w-40 truncate">{a.name}</span>
              <select
                className={`${inputCls} w-48`}
                value={p?.hostId ?? ""}
                onChange={(e) => place(a.id, { hostId: e.target.value || null })}
              >
                <option value="">This Mac</option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id} disabled={!h.root}>
                    {h.name}
                  </option>
                ))}
              </select>
              <select
                className={`${inputCls} w-40`}
                value={p?.isolation ?? "none"}
                disabled={!p?.hostId}
                onChange={(e) =>
                  place(a.id, { isolation: e.target.value as AgentPlacement["isolation"] })
                }
              >
                <option value="none">Process</option>
                <option value="firecracker" disabled={!host?.preflight?.firecrackerReady}>
                  Firecracker microVM
                </option>
              </select>
              {p?.isolation === "firecracker" && (
                <span className="text-xs text-zinc-500">
                  {p.vcpus} vCPU · {p.memMib} MiB
                </span>
              )}
            </div>
          );
        })}
      </section>

      {subs.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-zinc-300">Subagents</h3>
          {subs
            .slice(-30)
            .reverse()
            .map((s) => (
              <div key={s.agentId} className="flex gap-2 text-xs text-zinc-400">
                <span
                  className={
                    s.status === "running"
                      ? "text-sky-400"
                      : s.status === "done"
                        ? "text-emerald-400"
                        : "text-amber-400"
                  }
                >
                  {s.status}
                </span>
                <span className="text-zinc-500">{nameOf(s.parentId)} →</span>
                <span className="truncate">{s.task}</span>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
