import type { ConfigOption, PermissionOption, ToolCallStatus } from "@openagent/protocol";

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
  | { type: "ignored"; kind: string };

export interface ProviderHooks {
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

export interface ProviderDriver {
  start(opts: {
    cwd: string;
    resumeSessionId: string | null;
    hooks: ProviderHooks;
  }): Promise<ProviderSession>;
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
