import { invoke } from "@tauri-apps/api/core";

export function nativeCommand(command: string, args?: Record<string, unknown>) {
  return "__TAURI_INTERNALS__" in window ? invoke<void>(command, args) : Promise.resolve();
}
