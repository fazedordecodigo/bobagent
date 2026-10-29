import type { DaemonEventMap, MethodName, MethodParams, MethodResult } from "@upbot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";

/** Subscriptions for `useDaemonQuery`: `true` reloads on every event, a
 * predicate reloads only when it accepts the event payload. */
export type DaemonQueryEvents = Partial<{
  [E in keyof DaemonEventMap]: true | ((data: DaemonEventMap[E]) => boolean);
}>;

/**
 * Loads one daemon method result, keeps it fresh through event subscriptions
 * and reconnects, and reports the failure instead of swallowing it.
 * `data` resets whenever `method`/`params` change so callers never render a
 * previous query's result; `loaded` stays true only after a successful load.
 */
export function useDaemonQuery<M extends MethodName>(
  client: DaemonClient,
  method: M,
  params: MethodParams<M>,
  { events = {}, enabled = true }: { events?: DaemonQueryEvents; enabled?: boolean } = {},
) {
  const [data, setData] = useState<MethodResult<M> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const generation = useRef(0);
  const mounted = useRef(false);

  const paramsKey = JSON.stringify(params);
  const eventsKey = Object.keys(events).sort().join("\n");

  const reload = useCallback(() => {
    const gen = ++generation.current;
    void client
      .request(method, paramsRef.current)
      .then((result) => {
        if (mounted.current && gen === generation.current) {
          setData(result);
          setLoaded(true);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (mounted.current && gen === generation.current) {
          setError(errorMessage(e));
        }
      });
  }, [client, method]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: paramsKey serializes params so param edits re-run the load.
  useEffect(() => {
    if (!enabled) return;
    setData(undefined);
    setError(null);
    setLoaded(false);
    reload();
  }, [enabled, reload, paramsKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: eventsKey serializes the subscribed event set; predicates are read live from eventsRef.
  useEffect(() => {
    if (!enabled) return;
    const offs = (Object.keys(eventsRef.current) as (keyof DaemonEventMap)[]).map((name) =>
      client.on(name, (eventData) => {
        const rule = eventsRef.current[name] as true | ((data: unknown) => boolean) | undefined;
        if (rule === true || (typeof rule === "function" && rule(eventData))) reload();
      }),
    );
    const offReconnect = client.onReconnect(reload);
    return () => {
      for (const off of offs) off();
      offReconnect();
    };
    // eventsKey re-subscribes when the event set changes; predicates are read
    // live from eventsRef so they can be inline closures.
  }, [enabled, client, reload, eventsKey]);

  return { data, error, loaded, reload, setData };
}
