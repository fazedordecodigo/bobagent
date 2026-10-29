import type { Agent, AgentStatusInfo, ProviderId, Turn } from "@upbot/protocol";
import { StatusPill } from "../components/ds/controls";
import {
  CalIcon,
  ChartIcon,
  MailIcon,
  PlaneIcon,
  ReceiptIcon,
  SheetIcon,
  UpbotSimboloCurrentcolorIcon,
} from "../components/ds/icons";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  devin: "Devin",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  gemini: "Gemini",
  claude: "Claude",
  codex: "Codex",
  "openai-compatible": "Compatível com OpenAI",
};

export function statusProvider(provider: ProviderId) {
  return PROVIDER_NAMES[provider];
}

export const ST = {
  run: "Em execução",
  wait: "Aguardando você",
  ok: "Concluído",
  idle: "Disponível",
  queue: "Na fila",
  err: "Com erro",
} as const;

export type UiStatus = keyof typeof ST;

export function mono(name: string) {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1, 2)}`;
}

export function role(agent: Pick<Agent, "instructions" | "provider">) {
  const first = agent.instructions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? first.slice(0, 80) : `Bot ${agent.provider}`;
}

export function fmtTime(ms: number | null | undefined, now = Date.now()) {
  if (ms == null) return "—";
  const date = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today))
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, yesterday)) return "ontem";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function status(
  live: AgentStatusInfo["status"] | undefined,
  queued: number,
  latestTurn: Turn | null,
  pendingApprovals = 0,
): UiStatus {
  if (live === "starting" || live === "running") return "run";
  if (live === "awaiting_permission") return "wait";
  if (live === "error") return "err";
  if (pendingApprovals > 0) return "wait";
  if (queued > 0) return "queue";
  if (latestTurn?.status === "completed") return "ok";
  if (latestTurn?.status === "failed") return "err";
  return "idle";
}

export function MonoAv({
  agent,
  status: st,
  lg = false,
  dot = true,
}: {
  agent: Pick<Agent, "name" | "avatar">;
  status?: UiStatus;
  lg?: boolean;
  dot?: boolean;
}) {
  const avatar = agent.avatar;
  const mark =
    avatar && "icon" in avatar ? (
      avatar.icon === "sym" ? (
        <UpbotSimboloCurrentcolorIcon />
      ) : avatar.icon === "mail" ? (
        <MailIcon />
      ) : avatar.icon === "receipt" ? (
        <ReceiptIcon />
      ) : avatar.icon === "plane" ? (
        <PlaneIcon />
      ) : avatar.icon === "chart" ? (
        <ChartIcon />
      ) : avatar.icon === "cal" ? (
        <CalIcon />
      ) : (
        <SheetIcon />
      )
    ) : avatar && "emoji" in avatar ? (
      avatar.emoji
    ) : (
      mono(agent.name)
    );
  return (
    <span
      className={`mono-av${lg ? " lg" : ""}`}
      style={
        avatar && "color" in avatar
          ? { background: `color-mix(in oklch, ${avatar.color} 15%, var(--surface))` }
          : undefined
      }
    >
      {mark}
      {dot && st && <i className={`dot s-${st}`} />}
    </span>
  );
}

export function Pill({ st }: { st: UiStatus }) {
  if (st !== "idle" && st !== "queue") return <StatusPill status={st} />;
  return (
    <span className={`status ${st}`}>
      <i className={`dot s-${st}`} />
      {ST[st]}
    </span>
  );
}
