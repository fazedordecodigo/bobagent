import type { ProviderId } from "@boto/protocol";
import { AcpDriver } from "./acp";
import { ClaudeDriver } from "./claude";
import { CodexDriver } from "./codex";
import { resolveProviderCommand } from "./process";
import { type ProviderDriver, ProviderError } from "./types";

// Default mode per provider (never bypass/auto-approve). ACP values were measured by
// spikes/mode-probe.ts; claude/codex values are the native drivers' own option ids.
export const DEFAULT_MODE: Partial<Record<ProviderId, string>> = {
  devin: "accept-edits",
  cursor: "agent",
  opencode: "build",
  claude: "default",
  codex: "auto",
};

export function getDriver(provider: ProviderId): ProviderDriver {
  switch (provider) {
    case "claude":
      return new ClaudeDriver();
    case "codex":
      return new CodexDriver();
    case "openai-compatible":
      throw new ProviderError("provider_unavailable", `${provider} is not supported yet`);
    default:
      return new AcpDriver(provider);
  }
}

export function checkProviderAvailable(provider: ProviderId): void {
  getDriver(provider);
  resolveProviderCommand(provider);
}
