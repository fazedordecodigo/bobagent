import type { ConfigOption, PermissionOption, ToolCallStatus } from "@boto/protocol";

export type NormalizedUpdate =
  | { type: "message_chunk"; text: string }
  | { type: "thought_chunk"; text: string }
  | {
      type: "tool_call";
      toolCallId: string;
      title: string;
      toolKind: string | null;
      status: ToolCallStatus;
      detail: string | null;
    }
  | {
      type: "tool_call_update";
      toolCallId: string;
      title?: string;
      status?: ToolCallStatus;
      detail?: string | null;
    }
  | { type: "config_update"; configOptions: ConfigOption[] }
  | { type: "mode_update"; modeId: string }
  | {
      /** usedTokens/contextWindow are snapshots; input/output/cost are per-turn deltas. */
      type: "usage";
      usedTokens?: number | null;
      contextWindow?: number | null;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    }
  | { type: "ignored"; kind: string };

export interface ProviderHooks {
  onResumeFailed?(): void;
  onUpdate(u: NormalizedUpdate): void;
  requestPermission(req: {
    title: string;
    toolKind: string | null;
    options: PermissionOption[];
  }): Promise<{ optionId: string | null }>;
  onExit(error: string | null): void;
}

export interface ProviderSession {
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly configOptions: ConfigOption[];
  setConfigOption(configId: string, value: string): Promise<ConfigOption[]>;
  prompt(text: string): Promise<{ stopReason: string }>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export type McpServerSpec = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** Runs a provider command on a remote host (see `src/remote/hosts.ts`). */
export type RemoteLaunch = {
  /** Working directory as seen by the provider on the host. */
  cwd: string;
  describe: string;
  mcp(spec: McpServerSpec): McpServerSpec;
  /** Provider credentials injected into the session (microVMs only; see remote/credentials.ts). */
  credentials: Record<string, string>;
  spawn(cmd: string[], env: Record<string, string>): import("node:child_process").ChildProcess;
};

export type StartOpts = {
  cwd: string;
  resumeSessionId: string | null;
  hooks: ProviderHooks;
  mcpServers?: McpServerSpec[];
  remote?: RemoteLaunch;
  /** Extra writable directories (local sessions only), e.g. the shared bot workspace. */
  extraDirs?: string[];
};

export interface ProviderDriver {
  start(opts: StartOpts): Promise<ProviderSession>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: "provider_unavailable" | "auth_required" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
