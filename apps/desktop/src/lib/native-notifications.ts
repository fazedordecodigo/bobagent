import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Agent } from "@upbot/protocol";
import { useEffect, useRef } from "react";
import type { DaemonClient } from "./daemon";
import {
  ApprovalNotifications,
  type NotificationBridge,
  type NotificationResponse,
} from "./notifications";

export function useNativeNotifications(
  client: DaemonClient,
  ready: boolean,
  agents: Agent[],
  review: (view: string) => void,
  onError: (message: string) => void,
) {
  const names = useRef(agents);
  names.current = agents;
  useEffect(() => {
    if (!ready || !("__TAURI_INTERNALS__" in window)) return;
    const bridge: NotificationBridge = {
      initialize: () => invoke<boolean>("notifications_initialize"),
      post: (notification) => invoke("notifications_post", { notification }),
      remove: (id) => invoke("notifications_remove", { id }),
      open: () => invoke("notifications_open"),
      listen: async (handler) => {
        let stopped = false;
        let pending = Promise.resolve();
        const drain = () => {
          pending = pending
            .then(async () => {
              const responses = await invoke<NotificationResponse[]>("notifications_take_actions");
              if (!stopped) for (const response of responses) handler(response);
            })
            .catch((e) => onError(String(e)));
        };
        const off = await listen("upbot://notification-actions", drain);
        drain();
        return () => {
          stopped = true;
          off();
        };
      },
    };
    const notifications = new ApprovalNotifications(
      client,
      bridge,
      localStorage,
      (id) => names.current.find((agent) => agent.id === id)?.name ?? "O bot",
      review,
      onError,
    );
    void notifications.start().catch((e) => onError(String(e)));
    return () => notifications.stop();
  }, [client, ready, review, onError]);
}
