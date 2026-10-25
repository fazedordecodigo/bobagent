import type { Agent, AgentAvatar, Memory, Skill } from "@bobagent/protocol";
import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { btnCls, inputCls } from "./AgentSettings";

export function AvatarBadge({
  agent,
  size = 20,
}: {
  agent: Pick<Agent, "name" | "avatar">;
  size?: number;
}) {
  const emoji = agent.avatar?.emoji ?? agent.name.slice(0, 1).toUpperCase();
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.6,
        background: agent.avatar?.color ?? "#3f3f46",
      }}
    >
      {emoji}
    </span>
  );
}

export function AvatarEditor({
  agent,
  onSave,
}: {
  agent: Agent;
  onSave: (avatar: AgentAvatar | null) => Promise<void>;
}) {
  const [emoji, setEmoji] = useState(agent.avatar?.emoji ?? "🤖");
  const [color, setColor] = useState(agent.avatar?.color ?? "#0ea5e9");
  return (
    <section className="mx-auto max-w-lg space-y-2 px-6 pb-4">
      <h3 className="text-sm font-semibold text-zinc-300">Avatar</h3>
      <div className="flex items-center gap-2">
        <AvatarBadge agent={{ name: agent.name, avatar: { emoji, color } }} size={32} />
        <input
          className={`${inputCls} w-20`}
          value={emoji}
          maxLength={16}
          onChange={(e) => setEmoji(e.target.value)}
        />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <button
          type="button"
          className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}
          disabled={!emoji.trim()}
          onClick={() => onSave({ emoji: emoji.trim(), color })}
        >
          Save avatar
        </button>
      </div>
    </section>
  );
}

export function MemoriesPanel({ client, agentId }: { client: DaemonClient; agentId: string }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [text, setText] = useState("");
  const load = useCallback(() => {
    client
      .request("memories.list", { agentId })
      .then(setItems)
      .catch(() => {});
  }, [client, agentId]);
  useEffect(() => {
    load();
    return client.on("memories.changed", (d) => {
      if (d.agentId === agentId) load();
    });
  }, [client, agentId, load]);
  return (
    <section className="mx-auto max-w-lg space-y-2 px-6 pb-6">
      <h3 className="text-sm font-semibold text-zinc-300">Memories</h3>
      <p className="text-xs text-zinc-500">Shown to the agent at the start of every new session.</p>
      <ul className="space-y-1">
        {items.map((m) => (
          <li key={m.id} className="flex items-start gap-2 rounded bg-zinc-900 px-2 py-1 text-sm">
            <span className="flex-1 whitespace-pre-wrap">{m.text}</span>
            <button
              type="button"
              className="text-xs text-zinc-500 hover:text-red-400"
              onClick={() => client.request("memories.delete", { id: m.id }).catch(() => {})}
            >
              Delete
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="text-xs text-zinc-600">No memories yet.</li>}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          client
            .request("memories.add", { agentId, text })
            .then(() => setText(""))
            .catch(() => {});
        }}
      >
        <input
          className={inputCls}
          placeholder="Add a memory"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}>
          Add
        </button>
      </form>
    </section>
  );
}

export function SkillsView({ client }: { client: DaemonClient }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [edit, setEdit] = useState<{ name: string; description: string; body: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .request("skills.list", {})
      .then(setSkills)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    load();
    return client.on("skills.changed", load);
  }, [client, load]);

  if (edit) {
    return (
      <form
        className="mx-auto max-w-2xl space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("skills.save", edit)
            .then(() => setEdit(null))
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        <h2 className="text-lg font-semibold">Skill</h2>
        <input
          className={inputCls}
          placeholder="name (kebab-case)"
          value={edit.name}
          onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          required
        />
        <input
          className={inputCls}
          placeholder="When to use it"
          value={edit.description}
          onChange={(e) => setEdit({ ...edit, description: e.target.value })}
        />
        <textarea
          className={`${inputCls} min-h-64 font-mono`}
          value={edit.body}
          onChange={(e) => setEdit({ ...edit, body: e.target.value })}
          required
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
            Save
          </button>
          <button
            type="button"
            className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}
            onClick={() => setEdit(null)}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6">
      <div className="flex items-center">
        <h2 className="text-lg font-semibold">Skills library</h2>
        <button
          type="button"
          className={`${btnCls} ml-auto bg-sky-600 hover:bg-sky-500`}
          onClick={() => setEdit({ name: "", description: "", body: "" })}
        >
          New skill
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Shared by all agents. Agents can also create and revise skills themselves.
      </p>
      <ul className="space-y-2">
        {skills.map((s) => (
          <li key={s.name} className="rounded border border-zinc-800 p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{s.name}</span>
              {s.author && <span className="text-xs text-zinc-500">by {s.author}</span>}
              <button
                type="button"
                className="ml-auto text-xs text-sky-400 hover:text-sky-300"
                onClick={() => setEdit({ name: s.name, description: s.description, body: s.body })}
              >
                Edit
              </button>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-400"
                onClick={() => client.request("skills.delete", { name: s.name }).catch(() => {})}
              >
                Delete
              </button>
            </div>
            <p className="text-sm text-zinc-400">{s.description}</p>
          </li>
        ))}
        {skills.length === 0 && <li className="text-sm text-zinc-500">No skills yet.</li>}
      </ul>
    </div>
  );
}
