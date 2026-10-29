import type { DaemonEventMap, MethodName, MethodParams, MethodResult } from "@upbot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";

type DaemonEventName = keyof DaemonEventMap;

export type DaemonEventSpec =
  | DaemonEventName
  | {
      [E in DaemonEventName]: readonly [E, (data: DaemonEventMap[E]) => boolean];
    }[DaemonEventName];

export function daemonOn<E extends DaemonEventName>(
  name: E,
  filter: (data: DaemonEventMap[E]) => boolean,
) {
  return [name, filter] as const;
}

/** request → then(setData) → catch, re-requesting when one of the given daemon events fires. */
export function useDaemonQuery<M extends MethodName, I = MethodResult<M>>(
  client: DaemonClient,
  method: M,
  params: MethodParams<M>,
  initial: I,
  events: ReadonlyArray<DaemonEventSpec> = [],
  opts: { onError?: (error: unknown) => void; enabled?: boolean } = {},
) {
  const [data, setData] = useState<MethodResult<M> | I>(initial);
  const paramsJson = JSON.stringify(params);
  const eventsKey = events.map((e) => (typeof e === "string" ? e : e[0])).join("\n");
  const refs = useRef({ events, onError: opts.onError });
  refs.current = { events, onError: opts.onError };
  const enabled = opts.enabled !== false;

  const load = useCallback(() => {
    client
      .request(method, JSON.parse(paramsJson) as MethodParams<M>)
      .then(setData)
      .catch((e: unknown) => refs.current.onError?.(e));
  }, [client, method, paramsJson]);

  useEffect(() => {
    if (!enabled) return;
    load();
    const offs = (eventsKey ? eventsKey.split("\n") : []).map((name) =>
      client.on(name as DaemonEventName, (d) => {
        const spec = refs.current.events.find((e) => (typeof e === "string" ? e : e[0]) === name);
        const filter = spec === undefined || typeof spec === "string" ? undefined : spec[1];
        if (!filter || (filter as (d: unknown) => boolean)(d)) load();
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [client, enabled, eventsKey, load]);

  return [data, load, setData] as const;
}
