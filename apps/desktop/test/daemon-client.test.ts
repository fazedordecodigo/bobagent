import { afterAll, expect, test } from "bun:test";

type TauriTestGlobals = typeof globalThis & {
  __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
};

let resolveConnection: () => Promise<unknown>;
let invokeCount = 0;
let socketAttempts = 0;
const tauriGlobals = globalThis as TauriTestGlobals;

tauriGlobals.window = globalThis;
tauriGlobals.__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    if (command !== "daemon_connection") throw new Error(`unexpected invoke: ${command}`);
    invokeCount += 1;
    return resolveConnection();
  },
};

const NativeWebSocket = globalThis.WebSocket;
class CountingWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    socketAttempts += 1;
    super(url, protocols);
  }
}
globalThis.WebSocket = CountingWebSocket;

const { DaemonClient } = await import("../src/lib/daemon");

afterAll(() => {
  delete tauriGlobals.window;
  delete tauriGlobals.__TAURI_INTERNALS__;
});

function serve() {
  return Bun.serve({
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/ws") {
        return new Response(null, { status: 404 });
      }
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message));
        socket.send(JSON.stringify({ id: request.id, result: [] }));
      },
    },
  });
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}

test("reports daemon termination after re-resolving and stops retrying", async () => {
  const server = serve();
  const exitMessage = "botod exited: TerminatedPayload { code: Some(1), signal: None }";
  invokeCount = 0;
  socketAttempts = 0;
  resolveConnection = async () => {
    if (invokeCount === 1) return { port: server.port, token: "t" };
    throw exitMessage;
  };
  const client = new DaemonClient();
  let failure: Error | undefined;
  const off = client.onFailure((error) => {
    failure = error;
  });

  try {
    await client.connect();
    expect(invokeCount).toBe(1);
    expect(socketAttempts).toBe(1);
    server.stop(true);
    await waitFor(() => failure !== undefined);
    expect(failure?.message).toBe(exitMessage);
    expect(invokeCount).toBe(2);
    const callsAfterFailure = invokeCount;
    const socketsAfterFailure = socketAttempts;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(invokeCount).toBe(callsAfterFailure);
    expect(socketAttempts).toBe(socketsAfterFailure);
  } finally {
    off();
    client.close();
    server.stop(true);
  }
});

test("reconnects to the newly resolved daemon connection", async () => {
  const oldServer = serve();
  const newServer = serve();
  invokeCount = 0;
  socketAttempts = 0;
  resolveConnection = async () => ({
    port: invokeCount === 1 ? oldServer.port : newServer.port,
    token: "t",
  });
  const client = new DaemonClient();
  let reconnected = false;
  const off = client.onReconnect(() => {
    reconnected = true;
  });

  try {
    await client.connect();
    oldServer.stop(true);
    await waitFor(() => reconnected);
    expect(invokeCount).toBe(2);
    expect(socketAttempts).toBe(2);
    expect(await client.request("agents.list", {})).toEqual([]);
  } finally {
    off();
    client.close();
    oldServer.stop(true);
    newServer.stop(true);
  }
});
