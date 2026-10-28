import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, Approval, ConnectedApp, QueueState } from "@upbot/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
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
let page: Page;
let main: Page;
let vite: ReturnType<typeof Bun.spawn> | undefined;
let state: string;
let bot: Agent;
let second: Agent;
let app: ConnectedApp;
const token = `menubar-test-${crypto.randomUUID()}`;
const errors: string[] = [];
const base = "http://localhost:1420/";
const url = () => `${base}#/menubar?port=${daemon.port}&token=${token}`;
const out = process.env.PHASE4_SCREEN_DIR;

beforeAll(async () => {
  state = mkdtempSync(join(homedir(), "upbot-menubar-test-"));
  mkdirSync(join(state, "fake"));
  daemon = await startDaemon(join(state, "data"), join(state, "bots"), token, {
    UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: join(state, "fake"),
    UPBOT_CANCEL_GRACE_MS: "250",
    UPBOT_VAULT_KEY: "ab".repeat(32),
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  bot = (await rpc.request("agents.create", {
    name: "UpBot",
    provider: "devin",
    instructions: "Organiza as entregas.",
  })) as Agent;
  second = (await rpc.request("agents.create", {
    name: "Relatório semanal",
    provider: "devin",
    instructions: "Prepara relatórios.",
  })) as Agent;
  app = (await rpc.request("apps.connect", {
    catalogId: "custom-stdio",
    name: "Notas",
    command: ["bun", join(ROOT, "packages/daemon/test/fixtures/fake-mcp-server.ts")],
    secrets: { FAKE_APP_PERMISSIONS: "1" },
  })) as ConnectedApp;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      ((await rpc.request("apps.list", {})) as ConnectedApp[]).find((item) => item.id === app.id)
        ?.tools.length
    )
      break;
    await Bun.sleep(100);
  }
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
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 384, height: 600 } });
  page = await context.newPage();
  main = await context.newPage();
  page.setDefaultTimeout(10000);
  main.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  main.on("pageerror", (error) => errors.push(error.message));
  await main.setViewportSize({ width: 1280, height: 900 });
  await main.addInitScript((id) => {
    localStorage.setItem("upbot.agent", id);
    localStorage.setItem("upbot.view", "chat");
  }, bot.id);
  await main.goto(`${base}#port=${daemon.port}&token=${token}`);
  await main
    .getByRole("textbox", { name: "Mensagem para o bot" })
    .waitFor({ timeout: 10000 })
    .catch(async (error) => {
      throw new Error(
        `${String(error)}\n${errors.join("\n")}\n${await main.locator("body").innerText()}`,
      );
    });
  await page.goto(url());
  await page.getByText("Nada aguardando você", { exact: true }).waitFor();
  if (out) mkdirSync(out, { recursive: true });
}, 30000);

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

async function pending(agent = bot, tool = "create_note", args: Record<string, unknown> = {}) {
  await rpc.request("chat.send", {
    agentId: agent.id,
    text: `mcp:notas-${tool} ${JSON.stringify(args)}`,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const approval = ((await rpc.request("approvals.list", {})) as Approval[]).find(
      (item) => item.status === "pending" && item.agentId === agent.id,
    );
    if (approval) return approval;
    await Bun.sleep(100);
  }
  throw new Error("Real daemon did not create the requested approval");
}

async function keyboardButton(label: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((label) => document.activeElement?.textContent === label, label)) {
      await page.keyboard.press("Enter");
      return;
    }
  }
  throw new Error(`Button ${label} was not keyboard reachable`);
}

test("empty state, guarded browser controls and footer error recovery use real daemon", async () => {
  expect(
    await page.getByRole("region", { name: "Aguardando você (0)", exact: true }).isVisible(),
  ).toBe(true);
  expect(await page.getByRole("button", { name: "Enviar tarefa", exact: true }).isDisabled()).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Abrir o app", exact: true }).click();
  await page.getByRole("button", { name: "Apps conectados →", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Peça uma tarefa ao UpBot" });
  await input.fill("x".repeat(100001));
  await page.getByRole("button", { name: "Enviar tarefa", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "100000" }).waitFor();
  expect((await input.inputValue()).length).toBe(100001);
  await input.fill("watchdog-idle");
  await page.getByRole("button", { name: "Enviar tarefa", exact: true }).click();
  await page
    .getByRole("region", { name: "Em execução (1)", exact: true })
    .getByRole("button", { name: /UpBot$/ })
    .waitFor();
  expect(await input.inputValue()).toBe("");
  expect(await page.getByRole("alert").count()).toBe(0);
  expect(await page.getByRole("progressbar").count()).toBe(0);
  expect(["starting", "running"]).toContain(
    ((await rpc.request("agents.statuses", {})) as Record<string, { status: string }>)[bot.id]
      ?.status,
  );
  await rpc.request("chat.cancel", { agentId: bot.id });
  await page.getByRole("region", { name: "Em execução (0)", exact: true }).waitFor();
  expect(errors).toEqual([]);
}, 30000);

test("keyboard app approval becomes done, count decreases and honest undo restores preference", async () => {
  await pending();
  await page.getByText("1 tarefa aguardando você", { exact: true }).waitFor();
  await page
    .getByTestId("menubar-approval")
    .getByText("UpBot quer criar uma nota em Notas.", { exact: true })
    .waitFor();
  await main
    .getByTestId("approval")
    .getByText("UpBot quer criar uma nota em Notas.", { exact: true })
    .waitFor();
  expect(await page.getByTestId("menubar-approval").innerText()).not.toMatch(
    /Run |create_note|\{\}/,
  );
  await keyboardButton("Permitir");
  const done = page.getByTestId("menubar-done");
  await done.filter({ hasText: "Preferência de permissão salva para este app." }).waitFor();
  await page.getByText("Nada aguardando você", { exact: true }).waitFor();
  expect(((await rpc.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.write).toBe(
    "allow",
  );
  await done.getByRole("button", { name: "Desfazer", exact: true }).click();
  await done
    .getByText("Preferência restaurada. A ação já aprovada não foi desfeita.", { exact: true })
    .waitFor();
  expect(((await rpc.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.write).toBe(
    "ask",
  );
  await done.waitFor({ state: "detached", timeout: 10000 });
  expect(await page.getByTestId("menubar-done").count()).toBe(0);
  await page.getByText("Nada aguardando você.", { exact: true }).waitFor();
}, 30000);

test("main-window decisions remove menubar requests; sensitive calls never offer permanent allow", async () => {
  await pending(bot, "create_note", { title: "Revisão da semana", content: "Organizar entregas" });
  await page.getByTestId("menubar-approval").waitFor();
  for (const card of [page.getByTestId("menubar-approval"), main.getByTestId("approval")]) {
    const summary = card.getByText("título: Revisão da semana · conteúdo: Organizar entregas", {
      exact: true,
    });
    await summary.waitFor();
    const style = await summary.evaluate((element) => {
      const style = getComputedStyle(element);
      return { whiteSpace: style.whiteSpace, font: style.fontFamily };
    });
    expect(style.whiteSpace).toBe("nowrap");
    expect(style.font).toContain("monospace");
    expect(await card.innerText()).not.toMatch(/Run |create_note|[{}]/);
  }
  await main.getByTestId("approval").getByRole("button", { name: "Recusar", exact: true }).click();
  await page.getByText("Nada aguardando você", { exact: true }).waitFor();
  expect(await page.getByTestId("menubar-approval").count()).toBe(0);
  const fullArgs = {
    to: ["Ana", "Bia", "Caio", "Dani"],
    body: "Mensagem completa ".repeat(400),
    attachments: ["relatório.pdf", "recibo.pdf"],
    total: 123,
    currency: "BRL",
  };
  await pending(bot, "send_message", fullArgs);
  const card = page.getByTestId("menubar-approval");
  await card.getByRole("button", { name: "Revisar no app", exact: true }).waitFor();
  expect(await card.getByRole("button", { name: "Aprovar e enviar", exact: true }).count()).toBe(0);
  const parameters = main.getByLabel("Parâmetros completos", { exact: true });
  await parameters.waitFor();
  expect(JSON.parse(await parameters.inputValue())).toEqual(fullArgs);
  expect(await parameters.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
  expect(await card.getByRole("button", { name: /Sempre|Permitir sempre/i }).count()).toBe(0);
  expect(await card.getByRole("button", { name: "Permitir", exact: true }).count()).toBe(0);
  expect(await card.getByRole("button", { name: "Só nesta tarefa", exact: true }).count()).toBe(0);
  await main
    .getByTestId("approval")
    .getByRole("button", { name: "Aprovar e enviar", exact: true })
    .click();
  await card.waitFor({ state: "detached" });
  expect(((await rpc.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.send).toBe("ask");
}, 30000);

test("overflow keyboard menu pauses all real queues, syncs theme and confirms exit", async () => {
  await rpc.request("queue.pause", { agentId: second.id });
  const more = page.getByRole("button", { name: "Mais opções", exact: true });
  await more.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await more.click();
  await page
    .getByRole("menuitem", { name: "Retomar bots", exact: true, disabled: false })
    .waitFor();
  for (const agent of [bot, second])
    expect(((await rpc.request("queue.get", { agentId: agent.id })) as QueueState).paused).toBe(
      true,
    );
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByText("Nada aguardando você", { exact: true }).waitFor();
  const created = (await rpc.request("agents.create", {
    name: "Novo bot",
    provider: "devin",
  })) as Agent;
  await rpc.request("queue.pause", { agentId: created.id });
  await more.click();
  await page.getByRole("menuitem", { name: "Retomar bots", exact: true }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await more.click();
  await page.getByRole("menuitem", { name: "Pausar bots", exact: true, disabled: false }).waitFor();
  await page.keyboard.press("Escape");
  expect(((await rpc.request("queue.get", { agentId: bot.id })) as QueueState).paused).toBe(false);
  for (const agent of [second, created])
    expect(((await rpc.request("queue.get", { agentId: agent.id })) as QueueState).paused).toBe(
      true,
    );
  await rpc.request("queue.resume", { agentId: second.id });
  await rpc.request("agents.delete", { id: created.id });
  await main.evaluate(() => {
    localStorage.setItem("upbot.theme", "light");
  });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await more.click();
  await page.getByRole("menuitemcheckbox", { name: "Tema escuro", exact: true }).click();
  await main.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await more.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Sair do UpBot?", exact: true });
  await dialog
    .getByText("As tarefas agendadas não rodam até você abrir o app de novo.", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  expect(await dialog.count()).toBe(0);
  await more.click();
  await page.keyboard.press("Escape");
  expect(await page.getByRole("menu").count()).toBe(0);
  expect(await more.evaluate((element) => document.activeElement === element)).toBe(true);
  expect(errors).toEqual([]);
}, 30000);

test("native bridge navigation and commands retain real daemon data", async () => {
  const native = await page.context().newPage();
  native.setDefaultTimeout(10000);
  native.on("pageerror", (error) => errors.push(error.message));
  try {
    await native.goto(`${base}#/kit`);
    await native.evaluate(
      async (connection) => {
        const path = "/node_modules/@tauri-apps/api/mocks.js";
        const { mockIPC, mockWindows } = await import(/* @vite-ignore */ path);
        mockWindows("main");
        mockIPC(
          (command: string, args: unknown) => {
            const calls = JSON.parse(document.body.dataset.nativeCalls ?? "[]");
            calls.push({ command, args });
            document.body.dataset.nativeCalls = JSON.stringify(calls);
            if (command === "daemon_connection") return connection;
            if (command === "notifications_initialize") return false;
            if (command === "notifications_take_actions") return [];
            if (command === "main_ready") {
              const path = "/node_modules/@tauri-apps/api/event.js";
              void import(/* @vite-ignore */ path).then(({ emit }) =>
                emit("upbot://navigate", "apps"),
              );
            }
          },
          { shouldMockEvents: true },
        );
        const internals = (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        const invoke = internals.invoke;
        // The mock reads id; the event API sends eventId.
        internals.invoke = (command, args) =>
          invoke(
            command,
            command === "plugin:event|unlisten" ? { ...args, id: args?.eventId } : args,
          );
        location.hash = "#main";
      },
      { port: daemon.port, token },
    );
    await native.getByRole("heading", { name: "Apps conectados", exact: true }).waitFor();
    const navigate = async (view: string) =>
      native.evaluate(async (view) => {
        const path = "/node_modules/@tauri-apps/api/event.js";
        const { emit } = await import(/* @vite-ignore */ path);
        await emit("upbot://navigate", view);
      }, view);
    await navigate("apps");
    await native.getByRole("heading", { name: "Apps conectados", exact: true }).waitFor();
    await navigate(second.id);
    await native.getByRole("textbox", { name: "Mensagem para o bot" }).waitFor();
    expect(await native.locator(".main-head").innerText()).toContain(second.name);
    await native.evaluate(() => {
      location.hash = "#/menubar";
    });
    await native.getByText("Nada aguardando você", { exact: true }).waitFor();
    const approval = await pending(second);
    await native.getByText("1 tarefa aguardando você", { exact: true }).waitFor();
    await rpc.request("approvals.respond", { id: approval.id, decision: "deny" });
    await native.getByText("Nada aguardando você", { exact: true }).waitFor();
    await native.getByRole("button", { name: "Abrir o app", exact: true }).click();
    await native.getByRole("button", { name: "Apps conectados →", exact: true }).click();
    await native.keyboard.press("Escape");
    await native.getByRole("button", { name: "Mais opções", exact: true }).click();
    await native.getByRole("menuitem", { name: "Sair do UpBot", exact: true }).click();
    const dialog = native.getByRole("dialog", { name: "Sair do UpBot?" });
    await dialog
      .getByText("As tarefas agendadas não rodam até você abrir o app de novo.", { exact: true })
      .waitFor();
    await dialog.getByRole("button", { name: "Sair do UpBot", exact: true }).click();
    const calls = await native.evaluate(() =>
      JSON.parse(document.body.dataset.nativeCalls ?? "[]"),
    );
    expect(
      calls
        .filter((call: { command: string }) => call.command === "set_tray_count")
        .map((call: { args: { count: number } }) => call.args.count),
    ).toEqual([0, 1, 0]);
    expect(calls).toContainEqual({ command: "open_main", args: { view: "apps" } });
    expect(calls).toContainEqual({ command: "open_main", args: { view: null } });
    expect(calls.some((call: { command: string }) => call.command === "menubar_hide")).toBe(true);
    expect(calls.some((call: { command: string }) => call.command === "quit_app")).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await native.close();
  }
}, 30000);

test("multiple real pending items stay secondary after first; light/dark captures", async () => {
  await page.reload();
  await page.getByText("Nada aguardando você", { exact: true }).waitFor();
  await pending(bot, "send_message");
  await pending(second);
  await page.getByText("2 tarefas aguardando você", { exact: true }).waitFor();
  const running = page.getByRole("region", { name: "Em execução (2)", exact: true });
  await running.waitFor();
  expect(await running.getByRole("button").count()).toBe(2);
  expect(await running.innerText()).toContain(bot.name);
  expect(await running.innerText()).toContain(second.name);
  for (const theme of ["light", "dark"]) {
    await main.evaluate((theme) => localStorage.setItem("upbot.theme", theme), theme);
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await page.addStyleTag({ content: "*{transition:none!important;animation:none!important}" });
    await page.evaluate(() => document.fonts.ready);
    expect(await page.getByTestId("menubar-approval").count()).toBe(2);
    await page
      .getByTestId("menubar-approval")
      .getByText("Relatório semanal quer criar uma nota em Notas.", { exact: true })
      .waitFor();
    await page
      .getByTestId("menubar-approval")
      .getByText("UpBot quer enviar uma mensagem em Notas.", { exact: true })
      .waitFor();
    const blue = await page
      .getByTestId("menubar-approval")
      .getByRole("button")
      .evaluateAll((buttons) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return buttons.filter((button) => getComputedStyle(button).backgroundColor === accent)
          .length;
      });
    expect(blue).toBe(1);
    if (out) await page.screenshot({ path: join(out, `menubar-${theme}.png`) });
    const lastBot = running.getByRole("button").last();
    const scroller = running.locator("..");
    const viewport = await scroller.boundingBox();
    await lastBot.scrollIntoViewIfNeeded();
    const after = await lastBot.boundingBox();
    expect(Math.ceil((after?.y ?? 0) + (after?.height ?? 0))).toBeLessThanOrEqual(
      Math.ceil((viewport?.y ?? 0) + (viewport?.height ?? 0)),
    );
    if (out) await page.screenshot({ path: join(out, `menubar-running-scrolled-${theme}.png`) });
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
  }
  for (const approval of (await rpc.request("approvals.list", {})) as Approval[]) {
    if (approval.status === "pending")
      await rpc.request("approvals.respond", { id: approval.id, decision: "deny" });
  }
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
}, 30000);
