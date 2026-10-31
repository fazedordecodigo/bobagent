import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@boto/protocol";
import { type Browser, chromium, type Page, type WebSocketRoute } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  stopTestChildren,
} from "../../../packages/daemon/test/helpers";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let vite: ReturnType<typeof Bun.spawn> | undefined;
let state: string;
let bot: Agent;
const token = `daemon-recovery-test-${crypto.randomUUID()}`;
const base = "http://localhost:1420/";

beforeAll(async () => {
  state = mkdtempSync(join(homedir(), "boto-daemon-recovery-test-"));
  const fake = join(state, "fake");
  mkdirSync(fake);
  daemon = await startDaemon(join(state, "data"), join(state, "bots"), token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: fake,
    BOTO_VAULT_KEY: "ab".repeat(32),
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  bot = (await rpc.request("agents.create", {
    name: "Boto",
    provider: "devin",
    instructions: "Organiza as entregas.",
  })) as Agent;
  try {
    await fetch(base);
  } catch {
    vite = Bun.spawn(["bun", "run", "dev", "--port", "1420"], {
      cwd: join(ROOT, "apps/desktop"),
      stdout: "ignore",
      stderr: "inherit",
    });
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: "chrome" }),
    headless: true,
  });
}, 60000);

afterAll(async () => {
  await browser?.close();
  rpc?.close();
  try {
    daemon?.proc.kill();
  } catch {}
  try {
    vite?.kill();
  } catch {}
  if (daemon) await daemon.proc.exited;
  if (vite) await vite.exited;
  if (state) {
    await stopTestChildren(join(state, "fake"));
    rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function pageWithBot(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.addInitScript((id) => {
    localStorage.setItem("boto.agent", id);
    localStorage.setItem("boto.view", "chat");
  }, bot.id);
  return page;
}

async function failFirstRefresh(page: Page): Promise<() => void> {
  let connections = 0;
  let firstSocket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\?token=/, (ws) => {
    connections++;
    if (connections === 1) {
      firstSocket = ws;
      const server = ws.connectToServer();
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.method === "agents.list") {
          ws.send(
            JSON.stringify({
              id: message.id,
              error: { code: -32000, message: "falha simulada" },
            }),
          );
        } else {
          server.send(raw);
        }
      });
    } else {
      ws.connectToServer();
    }
  });
  return () => firstSocket?.close();
}

test("main window recovers after its initial refresh fails", async () => {
  const page = await pageWithBot();
  const closeFirst = await failFirstRefresh(page);
  try {
    await page.goto(`${base}#port=${daemon.port}&token=${token}`);
    const heading = page.getByRole("heading", {
      name: "Não foi possível conectar ao Boto",
      exact: true,
    });
    await heading.waitFor();
    await page.getByText("falha simulada", { exact: true }).waitFor();
    closeFirst();
    await page.getByRole("textbox", { name: "Mensagem para o bot" }).waitFor({
      state: "visible",
      timeout: 15000,
    });
    expect(await heading.count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30000);

test("menu bar recovers after its initial refresh fails", async () => {
  const page = await pageWithBot();
  const closeFirst = await failFirstRefresh(page);
  try {
    await page.goto(`${base}#/menubar?port=${daemon.port}&token=${token}`);
    await page.getByText("Conectando…", { exact: true }).waitFor();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.innerText()).toContain("falha simulada");
    closeFirst();
    await page.getByText("Nada aguardando você", { exact: true }).waitFor({
      state: "visible",
      timeout: 15000,
    });
    expect(await page.getByRole("alert").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30000);

test("main window refreshes when the first socket retry connects", async () => {
  const reservation = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = reservation.port;
  reservation.stop(true);

  const page = await pageWithBot();
  const upstreams = new Map<Bun.Socket, Bun.Socket>();
  const buffered = new Map<Bun.Socket, Uint8Array[]>();
  const closed = new WeakSet<Bun.Socket>();
  let proxyConnections = 0;
  let upstreamConnections = 0;
  let upstreamResponse = "";
  let proxy: { stop: (closeActiveConnections?: boolean) => void } | undefined;

  try {
    await page.goto(`${base}#port=${port}&token=${token}`);
    const heading = page.getByRole("heading", {
      name: "Não foi possível conectar ao Boto",
      exact: true,
    });
    await heading.waitFor();
    proxy = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(client) {
          proxyConnections++;
          void Bun.connect({
            hostname: "127.0.0.1",
            port: daemon.port,
            socket: {
              data(_upstream, data) {
                if (upstreamResponse.length < 512)
                  upstreamResponse += new TextDecoder().decode(data).slice(0, 512);
                client.write(data);
              },
              close() {
                client.end();
              },
              error() {
                client.end();
              },
            },
          })
            .then((upstream) => {
              if (closed.has(client)) {
                upstream.end();
                return;
              }
              upstreamConnections++;
              upstreams.set(client, upstream);
              for (const data of buffered.get(client) ?? []) upstream.write(data);
              buffered.delete(client);
            })
            .catch(() => client.end());
        },
        data(client, data) {
          const upstream = upstreams.get(client);
          if (upstream) upstream.write(data);
          else buffered.set(client, [...(buffered.get(client) ?? []), data]);
        },
        close(client) {
          closed.add(client);
          buffered.delete(client);
          upstreams.get(client)?.end();
          upstreams.delete(client);
        },
        error(client) {
          closed.add(client);
          buffered.delete(client);
          upstreams.get(client)?.end();
          upstreams.delete(client);
        },
      },
    });
    try {
      await page.getByRole("textbox", { name: "Mensagem para o bot" }).waitFor({
        state: "visible",
        timeout: 15000,
      });
    } catch (error) {
      throw new Error(
        `${String(error)}\nproxy connections=${proxyConnections}; upstream connections=${upstreamConnections}; response=${upstreamResponse}\n${await page.locator("body").innerText()}`,
      );
    }
    expect(await heading.count()).toBe(0);
  } finally {
    proxy?.stop(true);
    await page.close();
  }
}, 30000);
