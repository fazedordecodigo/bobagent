// Pure function: build the <conversation_history> block for a new provider
// session from prior user/assistant messages.

type Msg = { kind: "user_message" | "agent_message"; text: string };

const BUDGET = 20_000;
const HEAD = 2_000;
const TAIL = 800;

function clip(text: string): string {
  if (text.length <= 3_000) return text;
  return `${text.slice(0, HEAD)}\n[…]\n${text.slice(-TAIL)}`;
}

export function buildHandoff(messages: Msg[]): string | null {
  // newest-first selection until BUDGET chars of clipped text
  const picked: Msg[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const prefix = m.kind === "user_message" ? "[user] " : "[assistant] ";
    const lineLen = prefix.length + clip(m.text).length + 1;
    if (total + lineLen > BUDGET && picked.length > 0) break;
    picked.unshift(m);
    total += lineLen;
  }
  if (picked.length === 0) return null;
  const body = picked
    .map((m) => `[${m.kind === "user_message" ? "user" : "assistant"}] ${clip(m.text)}`)
    .join("\n");
  return `<conversation_history>\nThis is the earlier conversation with you in this app. Your previous session is not available, so use it as context.\n${body}\n</conversation_history>\n\n`;
}
