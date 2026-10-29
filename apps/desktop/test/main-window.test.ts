import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  Approval,
  ApprovalRule,
  ChannelMessage,
  ConnectedApp,
  Routine,
} from "@upbot/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  stopTestChildren,
} from "../../../packages/daemon/test/helpers";
import { expectSwitchGeometry } from "./switch-geometry";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let page: Page;
let vite: ReturnType<typeof Bun.spawn> | undefined;
let state: string;
let bot: Agent;
const token = `window-test-${crypto.randomUUID()}`;
const out =
  process.env.PHASE6_SCREEN_DIR ?? process.env.PHASE3_SCREEN_DIR ?? process.env.PHASE2_SCREEN_DIR;
const blueCounts: Record<string, number> = {};

async function capture(name: string, target = page) {
  if (!out) return;
  await target.addStyleTag({ content: "*{transition:none!important;animation:none!important}" });
  await target.evaluate(() => document.fonts.ready);
  await target.screenshot({ path: join(out, `${name}.png`) });
  blueCounts[name] = await target.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.color = root.getPropertyValue("--accent");
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight) return false;
      const css = getComputedStyle(el);
      if (css.visibility === "hidden" || css.display === "none") return false;
      const parent = el.parentElement && getComputedStyle(el.parentElement);
      return (
        css.backgroundColor === accent ||
        (css.color === accent && parent?.color !== accent) ||
        (css.outlineColor === accent && css.outlineStyle !== "none") ||
        css.boxShadow.includes(accent) ||
        ["Top", "Right", "Bottom", "Left"].some(
          (side) =>
            css.getPropertyValue(`border-${side.toLowerCase()}-color`) === accent &&
            Number.parseFloat(css.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
        )
      );
    }).length;
  });
}

beforeAll(async () => {
  state = mkdtempSync(join(homedir(), "upbot-window-test-"));
  const fake = join(state, "fake");
  mkdirSync(fake);
  daemon = await startDaemon(join(state, "data"), join(state, "bots"), token, {
    UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: fake,
    UPBOT_VAULT_KEY: "ab".repeat(32),
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  bot = (await rpc.request("agents.create", {
    name: "Relatório semanal",
    provider: "devin",
    instructions: "Organiza as entregas da semana.",
  })) as Agent;
  await rpc.request("agents.create", {
    name: "Pesquisa",
    provider: "devin",
    instructions: "Pesquisa referências.",
  });
  const app = (await rpc.request("apps.connect", {
    catalogId: "custom-stdio",
    name: "Notas",
    command: ["bun", join(ROOT, "packages/daemon/test/fixtures/fake-mcp-server.ts")],
    secrets: { FAKE_APP_PERMISSIONS: "1" },
  })) as ConnectedApp;
  for (let i = 0; i < 100; i++) {
    const apps = (await rpc.request("apps.list", {})) as ConnectedApp[];
    if (apps.find((a) => a.id === app.id)?.tools.length) break;
    await Bun.sleep(100);
  }
  try {
    await fetch("http://localhost:1420");
  } catch {
    vite = Bun.spawn(["bun", "run", "dev", "--port", "1420"], {
      cwd: join(ROOT, "apps/desktop"),
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch("http://localhost:1420")).ok) break;
      } catch {}
      await Bun.sleep(100);
    }
  }
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: "chrome" }),
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem("upbot.agent", id);
      localStorage.setItem("upbot.view", "chat");
    },
    { id: bot.id },
  );
  if (out) mkdirSync(out, { recursive: true });
}, 60000);

afterAll(async () => {
  if (out) writeFileSync(join(out, "blue-counts.json"), JSON.stringify(blueCounts, null, 2));
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

test("real chat, approval once/always/undo, details, palette, settings and drawer in both themes", async () => {
  for (const theme of ["light", "dark"] as const) {
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await page.evaluate((theme) => localStorage.setItem("upbot.theme", theme), theme);
    await page.reload();
    await page.addStyleTag({ content: "*{transition:none!important;animation:none!important}" });
    await page
      .locator(".main-head")
      .getByRole("heading", { name: bot.name, exact: true })
      .waitFor();
    if (await page.locator(".panel").isVisible()) await page.keyboard.press("Meta+.");
    const prompt = page.getByRole("textbox", { name: "Mensagem para o bot" });
    const send = async (text: string) => {
      await prompt.fill(text);
      await page.mouse.move(1, 1);
      expect(
        await page.locator("button.send").evaluate((el) => {
          const root = getComputedStyle(document.documentElement);
          const probe = document.createElement("span");
          probe.style.color = root.getPropertyValue("--fg");
          document.body.append(probe);
          const ink = getComputedStyle(probe).color;
          probe.remove();
          return getComputedStyle(el).backgroundColor === ink;
        }),
      ).toBe(true);
      await page.getByRole("button", { name: "Enviar", exact: true }).click();
    };
    if (theme === "light") {
      await page.getByText("Diga o que precisa", { exact: false }).waitFor();
      await send("echo:As entregas da semana estão organizadas para revisão.");
      await page
        .getByText("As entregas da semana estão organizadas para revisão.", { exact: true })
        .waitFor();
    }
    expect(await page.locator(".window-titlebar").count()).toBe(0);
    for (const selector of [".main-head", ".side-titlebar"]) {
      expect(
        await page.locator(selector).evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return {
            top: rect.top,
            height: rect.height,
            drag: el.hasAttribute("data-tauri-drag-region"),
          };
        }),
      ).toEqual({ top: 0, height: 52, drag: true });
    }
    expect(await page.locator(".side-brand").allTextContents()).toEqual(["UpBot"]);
    expect(await page.locator(".rail").count()).toBe(0);
    expect(
      await page
        .getByRole("button", { name: "Alternar painel de execução" })
        .evaluate(
          (el) =>
            !el.hasAttribute("data-tauri-drag-region") &&
            getComputedStyle(el).pointerEvents === "auto",
        ),
    ).toBe(true);
    expect(await page.locator(".side").evaluate((el) => el.getBoundingClientRect().width)).toBe(
      270,
    );
    expect(
      await page.locator(".thread-inner").evaluate((el) => el.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(720);
    await capture(`chat-${theme}`);
    await send("mcp:notas-create_note {}");
    const card = page.getByTestId("approval");
    await card.waitFor();
    expect(await card.getByText("Aguardando você", { exact: true }).isVisible()).toBe(true);
    await capture(`approval-${theme}`);
    await page.keyboard.press("Meta+,");
    await page.getByRole("tab", { name: "Apps", exact: true }).click();
    await page
      .getByRole("region", { name: "Pedidos de apps conectados" })
      .getByRole("button", { name: "Permitir", exact: true })
      .waitFor();
    await capture(`apps-approval-${theme}`);
    await page.getByRole("tab", { name: "Aprovações", exact: true }).click();
    await page.getByRole("button", { name: "Permitir", exact: true }).waitFor();
    await capture(`settings-approval-${theme}`);
    await page.keyboard.press("Meta+1");
    await card.waitFor();
    await card.getByRole("button", { name: "Só nesta tarefa" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Permissão concedida somente nesta tarefa." })
      .waitFor();
    expect(await page.getByRole("button", { name: "Desfazer", exact: true }).count()).toBe(0);
    await capture(`toast-once-${theme}`);
    await page.getByRole("button", { name: "Fechar aviso" }).click();
    await page.getByRole("button", { name: "Enviar", exact: true }).waitFor();
    await send("mcp:notas-create_note {}");
    await card.waitFor();
    await card.getByRole("button", { name: "Permitir", exact: true }).click();
    await page.getByRole("button", { name: "Desfazer", exact: true }).waitFor();
    await capture(`toast-always-${theme}`);
    expect(
      ((await rpc.request("approvals.rules", {})) as ApprovalRule[]).filter(
        (rule) => rule.pattern === "notas-create_note",
      ).length,
    ).toBe(0);
    expect(((await rpc.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.write).toBe(
      "allow",
    );
    await page.getByRole("button", { name: "Desfazer", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "não foi desfeita" }).waitFor();
    expect(((await rpc.request("approvals.rules", {})) as ApprovalRule[]).length).toBe(0);
    expect(((await rpc.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.write).toBe(
      "ask",
    );
    await page.getByRole("button", { name: "Fechar aviso" }).click();
    await page.keyboard.press("Meta+.");
    expect(await page.locator(".panel").isVisible()).toBe(true);
    expect(await page.locator(".panel").evaluate((el) => el.getBoundingClientRect().width)).toBe(
      320,
    );
    await capture(`details-${theme}`);
    await page.keyboard.press("Meta+k");
    await page.getByRole("dialog", { name: "Buscar", exact: true }).waitFor();
    await capture(`palette-${theme}`);
    await page.getByRole("dialog").getByRole("textbox").fill("sem-correspondencia-xyz");
    expect(await page.getByText("Nenhum resultado.", { exact: true }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator(".panel").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Alternar painel de execução" }).click();
    expect(await page.locator(".panel").isVisible()).toBe(false);
    await page.keyboard.press("Meta+,");
    await page.getByRole("heading", { name: "Configurações", exact: true }).waitFor();
    expect(
      await page
        .getByRole("tab", { name: "Geral", exact: true })
        .evaluate((el) => getComputedStyle(el).color !== getComputedStyle(el).backgroundColor),
    ).toBe(true);
    await capture(`settings-${theme}`);
    await page.getByRole("tab", { name: "Apps", exact: true }).click();
    await page.getByRole("button", { name: /MCP personalizado \(comando\)/ }).click();
    expect(
      await page
        .locator("button.bg-sky-600")
        .evaluate((el) => getComputedStyle(el).color !== getComputedStyle(el).backgroundColor),
    ).toBe(true);
    for (const tab of [
      "Apps",
      "Aprovações",
      "E-mail",
      "Habilidades",
      "Marketplace",
      "Navegador",
      "Cofre",
      "Gateways",
      "Celular",
      "Equipe",
      "Servidores",
    ])
      expect(await page.getByRole("tab", { name: tab, exact: true }).isVisible()).toBe(true);
    await page.keyboard.press("Meta+n");
    expect(await page.locator("dialog[open]").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await page.keyboard.press("Meta+1");
    await page.setViewportSize({ width: 700, height: 900 });
    expect(await page.locator(".side").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Abrir barra lateral", exact: true }).click();
    expect(await page.locator(".side").isVisible()).toBe(true);
    expect(
      await page.getByRole("dialog", { name: "Bots e tarefas" }).getAttribute("aria-modal"),
    ).toBe("true");
    expect(
      await page.locator(".side").evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.locator(".side").evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
    await capture(`drawer-700-${theme}`);
    await page.locator(".side-scrim").click({ position: { x: 600, y: 150 } });
    expect(await page.locator(".side").isVisible()).toBe(false);
    expect(
      await page
        .getByRole("button", { name: "Abrir barra lateral", exact: true })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await page.getByRole("button", { name: "Abrir barra lateral", exact: true }).click();
    await page.keyboard.press("Escape");
    expect(await page.locator(".side").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Alternar painel de execução" }).click();
    await page.getByRole("dialog", { name: "Execução", exact: true }).waitFor();
    expect(
      await page.locator(".panel").evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
    await capture(`details-700-${theme}`);
    await page.keyboard.press("Escape");
    expect(await page.locator(".panel").isVisible()).toBe(false);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}, 90000);

test("RunPanel switch tracks contain their knobs on and off in both themes", async () => {
  const previous = (await rpc.request("approvals.rules", {})) as ApprovalRule[];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  await page.addInitScript((id) => {
    localStorage.setItem("upbot.agent", id);
    localStorage.setItem("upbot.view", "chat");
  }, bot.id);
  await page.routeWebSocket(`ws://127.0.0.1:${daemon.port}/ws?*`, (socket) => {
    const server = socket.connectToServer();
    const delayed = new Set<string>();
    let closed = false;
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (request.method === "agents.list") delayed.add(request.id);
      server.send(message);
    });
    server.onMessage(async (message) => {
      const response = JSON.parse(String(message));
      if (delayed.delete(response.id)) await Bun.sleep(500);
      if (!closed) socket.send(message);
    });
    socket.onClose(() => {
      closed = true;
      server.close();
    });
  });
  try {
    for (const theme of ["light", "dark"]) {
      await rpc.request("approvals.setRules", {
        rules: [
          ...previous.filter((rule) => rule.agentId !== bot.id),
          {
            id: crypto.randomUUID(),
            agentId: bot.id,
            pattern: "switch_geometry_check",
            action: "ask",
          },
        ],
      });
      await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
      await page.evaluate((value) => localStorage.setItem("upbot.theme", value), theme);
      await page.reload();
      await page.locator(".panel").waitFor();
      const permissions = page.locator('[data-od-id="panel-perms"]');
      for (const name of ["Agir sem perguntar", "switch_geometry_check"]) {
        const control = permissions.getByRole("switch", { name, exact: true });
        for (const checked of [false, true, false]) {
          if ((await control.getAttribute("aria-checked")) !== String(checked)) {
            await control.click();
          }
          await permissions.getByRole("switch", { name, exact: true, checked }).waitFor();
          await expectSwitchGeometry(control);
        }
      }
      await permissions.getByRole("switch", { name: "switch_geometry_check", exact: true }).click();
      await permissions
        .getByRole("switch", { name: "switch_geometry_check", checked: true })
        .waitFor();
      await expectSwitchGeometry(
        permissions.getByRole("switch", { name: "switch_geometry_check" }),
      );
      if (out) await permissions.screenshot({ path: join(out, `switch-runpanel-${theme}.png`) });
    }
  } finally {
    await page.close();
    await rpc.request("approvals.setRules", { rules: previous });
  }
}, 30000);

test("app requests, permissions dialog and sensitive conversation decisions stay synchronized", async () => {
  for (const theme of ["light", "dark"] as const) {
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await page.evaluate((theme) => localStorage.setItem("upbot.theme", theme), theme);
    await page.reload();
    await page
      .locator(".main-head")
      .getByRole("heading", { name: bot.name, exact: true })
      .waitFor();
    if (await page.locator(".panel").isVisible()) await page.keyboard.press("Meta+.");
    await rpc.request("chat.send", { agentId: bot.id, text: "mcp:notas-create_note {}" });
    await page.getByTestId("approval").waitFor();
    await page.keyboard.press("Meta+,");
    await page.getByRole("tab", { name: "Apps", exact: true }).click();
    const requests = page.getByRole("region", { name: "Pedidos de apps conectados" });
    await requests.getByRole("button", { name: "Permitir", exact: true }).waitFor();
    expect(
      await requests
        .getByText(`${bot.name} quer criar uma nota em Notas.`, { exact: true })
        .isVisible(),
    ).toBe(true);
    expect(await requests.getByText("Notas · Criar e editar", { exact: false }).isVisible()).toBe(
      true,
    );
    await capture(`apps-pending-${theme}`);
    await page.getByRole("button", { name: "Permissões", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Permissões de Notas", exact: true });
    await dialog.waitFor();
    for (const kind of ["Enviar", "Pagar", "Reservar", "Excluir"]) {
      expect(
        await dialog
          .getByRole("group", { name: kind, exact: true })
          .getByRole("button", { name: "Sempre", exact: true })
          .isDisabled(),
      ).toBe(true);
    }
    expect(await dialog.getByText("sempre pedem aprovação", { exact: false }).isVisible()).toBe(
      true,
    );
    const read = dialog.getByRole("group", { name: "Ler", exact: true });
    await read.getByRole("button", { name: "Perguntar", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('fieldset[aria-label="Ler"] button[aria-pressed="true"]')
          ?.textContent === "Perguntar",
    );
    expect(((await rpc.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.read).toBe(
      "ask",
    );
    await read.getByRole("button", { name: "Sempre", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('fieldset[aria-label="Ler"] button[aria-pressed="true"]')
          ?.textContent === "Sempre",
    );
    await capture(`permissions-dialog-${theme}`);
    await dialog.getByRole("button", { name: "Desconectar", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Desconectar Notas?", exact: true });
    await confirm.waitFor();
    expect(await confirm.getByText("segredos salvos", { exact: false }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await confirm.count()).toBe(0);
    expect(await dialog.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await dialog.count()).toBe(0);
    await requests.getByRole("button", { name: "Recusar", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Pedido recusado." }).waitFor();
    expect(await page.getByRole("button", { name: "Desfazer", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Fechar aviso" }).click();
    await page.keyboard.press("Meta+1");
    await rpc.request("chat.send", { agentId: bot.id, text: "mcp:notas-send_message {}" });
    const sensitive = page.getByTestId("approval");
    await sensitive.getByRole("button", { name: "Aprovar e enviar", exact: true }).waitFor();
    expect(await sensitive.getByRole("button", { name: "Permitir", exact: true }).count()).toBe(0);
    expect(
      await sensitive.getByRole("button", { name: "Só nesta tarefa", exact: true }).count(),
    ).toBe(0);
    await capture(`sensitive-conversation-${theme}`);
    await sensitive.getByRole("button", { name: "Aprovar e enviar", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Ação aprovada para execução uma vez." })
      .waitFor();
    expect(await page.getByRole("button", { name: "Desfazer", exact: true }).count()).toBe(0);
    expect(((await rpc.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.send).toBe(
      "ask",
    );
    await page.getByRole("button", { name: "Fechar aviso" }).click();
    await page.getByText("tool-ok:message-sent", { exact: true }).last().waitFor();
  }
}, 60000);

test("group header owner selection and nested actions remain clickable in its drag region", async () => {
  const members = (await rpc.request("agents.list", {})) as Agent[];
  const other = members.find((member) => member.id !== bot.id)!;
  const channel = (await rpc.request("channels.create", {
    name: "Revisão em grupo",
    memberIds: [bot.id, other.id],
    ownerId: bot.id,
  })) as { id: string };
  await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
  await page.getByRole("button", { name: "Revisão em grupo", exact: false }).click();
  const header = page.locator(".channel-head");
  const owner = header.getByRole("combobox", { name: "Dono" });
  await owner.click();
  await page.keyboard.press("Escape");
  await owner.selectOption(other.id);
  let ownerId: string | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    const channels = (await rpc.request("channels.list", {})) as { id: string; ownerId: string }[];
    ownerId = channels.find((item) => item.id === channel.id)?.ownerId;
    if (ownerId === other.id) break;
    await Bun.sleep(20);
  }
  expect(ownerId).toBe(other.id);
  await header.getByRole("button", { name: "Parar", exact: true }).click();
  await header.getByRole("button", { name: "Retomar", exact: true }).waitFor();
  const channels = (await rpc.request("channels.list", {})) as { id: string; status: string }[];
  expect(channels.find((item) => item.id === channel.id)?.status).toBe("stopped");
}, 15000);

test("sidebar navigation, real approval counts, routines, groups, profile and theme", async () => {
  await page.setViewportSize({ width: 1568, height: 1089 });
  await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
  await page.addStyleTag({ content: "*{transition:none!important;animation:none!important}" });
  const side = page.locator(".side");
  await side.getByRole("button", { name: "Início", exact: true }).click();
  await page.getByRole("heading", { name: "Escolha um bot ou crie um novo." }).waitFor();
  await side.getByRole("button", { name: "Nova tarefa" }).click();
  await page.locator("dialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await side.getByRole("button", { name: "Agendadas", exact: true }).click();
  await page.getByText("Nenhuma rotina ainda.", { exact: false }).waitFor();
  const routine = (await rpc.request("routines.create", {
    agentId: bot.id,
    name: "Resumo diário",
    prompt: "echo:resumo",
    schedule: "daily 09:00",
  })) as Routine;
  await page.getByRole("button", { name: /Resumo diário/ }).waitFor();
  await page.getByRole("button", { name: /Resumo diário/ }).click();
  await page.locator(".main-head").getByRole("heading", { name: bot.name, exact: true }).waitFor();
  await side.getByRole("button", { name: "Configurações", exact: true }).click();
  await page.getByRole("heading", { name: "Configurações", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Seu nome", exact: true }).fill("Marina");
  expect(await side.locator(".side-who b").textContent()).toBe("Marina");
  await side.getByRole("button", { name: "Buscar", exact: false }).click();
  await page
    .getByRole("option")
    .filter({ has: page.getByText("Páginas", { exact: true }) })
    .click();
  await page.getByText("Nenhuma página ainda.", { exact: false }).waitFor();
  await page.keyboard.press("Meta+k");
  await page.getByRole("option", { name: /Nova conversa em grupo/ }).click();
  await page.getByRole("heading", { name: "New group chat", exact: true }).waitFor();
  const group = (await rpc.request("channels.create", {
    name: "Planejamento",
    memberIds: [bot.id],
  })) as { id: string };
  const groupRow = side.getByRole("button", { name: /# Planejamento/ });
  await groupRow.click();
  expect(await groupRow.getAttribute("aria-current")).toBe("true");

  const make = async (name: string) =>
    (await rpc.request("agents.create", {
      name,
      provider: "devin",
      instructions: "Fixture de estado real.",
    })) as Agent;
  const waiting = await make("Despesas de outubro");
  const running = await make("Caixa de entrada");
  const failed = await make("Viagem a Recife");
  const queued = await make("Revisão de notas");
  await rpc.request("chat.send", { agentId: bot.id, text: "echo:Relatório concluído." });
  await side.getByRole("button", { name: /Relatório semanal Concluído/ }).waitFor();
  const apps = (await rpc.request("apps.list", {})) as ConnectedApp[];
  const notes = apps.find((app) => app.name === "Notas");
  if (!notes) throw new Error("Notas fixture missing");
  await rpc.request("apps.update", { id: notes.id, permissions: { write: "ask" } });
  await rpc.request("chat.send", { agentId: waiting.id, text: "mcp:notas-create_note {}" });
  await rpc.request("chat.send", { agentId: running.id, text: "watchdog-idle" });
  await rpc.request("chat.send", { agentId: failed.id, text: "crash" });
  await rpc.request("queue.pause", { agentId: queued.id });
  await rpc.request("chat.send", { agentId: queued.id, text: "echo:revisão" });
  await side
    .getByRole("button", { name: /Despesas de outubro Aguardando sua aprovação/ })
    .waitFor();
  await side.getByRole("button", { name: /Caixa de entrada Em execução/ }).waitFor();
  await side.locator(".side-bot").filter({ hasText: failed.name }).locator(".s-err").waitFor();
  await side.getByRole("button", { name: /Revisão de notas 1 na fila/ }).waitFor();
  await side.getByRole("status", { name: "1 pedido pendente" }).waitFor();
  await side.getByRole("button", { name: "Apps conectados", exact: false }).click();
  await page.getByRole("heading", { name: "Apps conectados", exact: true }).waitFor();
  await side.locator(".side-bot").filter({ hasText: failed.name }).click();
  const selected = side.locator('.side-bot[aria-current="true"]');
  expect(await selected.locator("b").textContent()).toBe(failed.name);
  expect(
    await selected.evaluate((element) => {
      const probe = document.createElement("i");
      probe.style.background = "var(--fg)";
      document.body.append(probe);
      const ink = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(element).backgroundColor === ink;
    }),
  ).toBe(true);
  expect(await side.locator(".side-bot").last().locator("b").textContent()).toBe("# Planejamento");
  expect(
    await side
      .getByRole("heading", { name: "SEUS AGENTES", exact: true })
      .evaluate((element) => getComputedStyle(element).textTransform),
  ).toBe("uppercase");
  for (const theme of ["light", "dark"] as const) {
    await side
      .getByRole("button", { name: theme === "light" ? "Tema claro" : "Tema escuro", exact: true })
      .click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    expect(await page.evaluate(() => localStorage.getItem("upbot.theme"))).toBe(theme);
    for (const status of ["idle", "queue", "wait", "run", "err", "ok"]) {
      const row = side
        .locator(".side-bot")
        .filter({ has: page.locator(`.dot.s-${status}`) })
        .first();
      await row.click();
      expect(await row.getAttribute("aria-current")).toBe("true");
      const result = await row.evaluate((element, status) => {
        const dot = element.querySelector(".dot");
        if (!dot) throw new Error("Missing status dot");
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Missing canvas context");
        const pixel = (color: string) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const background = pixel(getComputedStyle(element).backgroundColor);
        const foreground = pixel(getComputedStyle(dot).backgroundColor);
        const luminance = (rgb: number[]) => {
          const linear = rgb.map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        };
        const a = luminance(background);
        const b = luminance(foreground);
        const neutral = status === "idle" || status === "queue";
        const probe = document.createElement("i");
        probe.style.background = neutral
          ? "color-mix(in oklch, var(--bg) 70%, var(--fg))"
          : `var(--st-${status})`;
        element.append(probe);
        const matchesToken =
          getComputedStyle(probe).backgroundColor === getComputedStyle(dot).backgroundColor;
        probe.remove();
        return { contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), matchesToken };
      }, status);
      expect(result.matchesToken).toBe(true);
      expect(result.contrast).toBeGreaterThanOrEqual(
        status === "idle" || status === "queue" ? 3 : 1.4,
      );
    }
    await side.locator(".side-bot").filter({ hasText: failed.name }).click();
    const dir = process.env.SIDEBAR_SCREEN_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(dir, `main-${theme}.png`) });
    }
  }
  await side.getByRole("button", { name: "Tema escuro", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  const pending = (await rpc.request("approvals.list", {})) as Approval[];
  const approval = pending.find((item) => item.agentId === waiting.id && item.status === "pending");
  if (!approval) throw new Error("Expected pending fixture approval");
  await rpc.request("approvals.respond", { id: approval.id, decision: "deny" });
  await side.locator(".side-count").waitFor({ state: "detached" });
  await rpc.request("chat.cancel", { agentId: running.id });
  await rpc.request("routines.delete", { id: routine.id });
  await rpc.request("channels.archive", { channelId: group.id });
}, 30000);

test("Buscar matches instructions without exposing them and shows live overview tasks", async () => {
  const agent = (await rpc.request("agents.create", {
    name: "Farol",
    provider: "devin",
    instructions:
      "Especialista em logística reversa.\nPrioriza fornecedores regionais.\ntoken sk-test-123",
  })) as Agent;
  const target = await browser.newPage();
  try {
    await target.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await target.locator(".side-bot").filter({ hasText: agent.name }).waitFor();
    await target.getByRole("button", { name: "Buscar", exact: false }).click();
    const input = target.getByRole("textbox", { name: "Buscar comandos" });
    const result = target
      .getByRole("option")
      .filter({ has: target.getByText(agent.name, { exact: true }) });
    const palette = target.getByRole("dialog", { name: "Buscar", exact: true });
    for (const phrase of [
      "LOGÍSTICA REVERSA",
      "fornecedores regionais",
      "sk-test",
      "Farol",
      "Devin",
    ]) {
      await input.fill(phrase);
      await result.waitFor();
      expect(await result.textContent()).toContain("Farol");
      expect(await result.textContent()).toContain("Devin");
      const html = await palette.evaluate((element) => element.outerHTML);
      expect(html).not.toContain("sk-test-123");
      expect(html).not.toContain("Especialista em logística reversa.");
      expect(html).not.toContain("Prioriza fornecedores regionais.");
    }
    await input.fill("nenhum bot corresponde a esta consulta");
    await target.getByText("Nenhum resultado.", { exact: true }).waitFor();
    await input.fill("");
    await result.waitFor();
    expect(await result.textContent()).toContain("Devin");
    await input.fill("CONCILIAR FATURAS TRIMESTRAIS");
    await target.getByText("Nenhum resultado.", { exact: true }).waitFor();
    const { queueId } = (await rpc.request("chat.send", {
      agentId: agent.id,
      text: "echo:Conciliar faturas trimestrais",
    })) as { queueId: string };
    await rpc.waitForEventWhere("turn.ended", (event) => (event as Turn).queueId === queueId);
    await result.waitFor();
    expect(await result.textContent()).toContain("Conciliar faturas trimestrais");
    await result.click();
    await target
      .locator(".main-head")
      .getByRole("heading", { name: agent.name, exact: true })
      .waitFor();
  } finally {
    await target.close();
    await rpc.request("agents.delete", { id: agent.id });
  }
}, 15000);

test("chat uses a single composer row and anonymous left/right bubbles in both themes", async () => {
  const agent = (await rpc.request("agents.create", {
    name: "Rascunhos",
    provider: "devin",
    instructions: "Organiza ideias para a semana.",
  })) as Agent;
  const target = await browser.newPage({ viewport: { width: 1568, height: 1089 } });
  target.setDefaultTimeout(5000);
  try {
    await target.addInitScript((id) => {
      localStorage.setItem("upbot.agent", id);
      localStorage.setItem("upbot.view", "chat");
    }, agent.id);
    for (const theme of ["light", "dark"]) {
      await target.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
      await target.evaluate((value) => localStorage.setItem("upbot.theme", value), theme);
      await target.reload();
      const prompt = target.getByRole("textbox", { name: "Mensagem para o bot", exact: true });
      await prompt.waitFor();
      const composer = target.locator("form.composer");
      expect(await target.locator(".side-settings svg").innerHTML()).toBe(
        await target
          .locator(".main-head button svg")
          .filter({ has: target.locator('path[d^="M19.4 15"]') })
          .innerHTML(),
      );
      const send = composer.getByRole("button", { name: "Enviar", exact: true });
      expect(await send.isDisabled()).toBe(true);
      expect(await composer.locator(".ctx, #ctxChip, .composer-bar").count()).toBe(0);
      expect(await composer.getByRole("button", { name: "Escolher ferramentas" }).count()).toBe(0);
      expect(await composer.textContent()).not.toContain("ferramenta");
      const attach = composer.getByRole("button", { name: "Anexar arquivo" });
      await composer.locator('input[type="file"]').setInputFiles({
        name: "ideias.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Ideias para revisão."),
      });
      await target.getByTitle("Remover anexo", { exact: true }).waitFor();
      expect(await send.isEnabled()).toBe(true);
      await target.getByTitle("Remover anexo", { exact: true }).click();
      expect(await send.isDisabled()).toBe(true);
      await prompt.fill(`echo:As ideias estão organizadas para revisão em tema ${theme}.`);
      await send.click();
      await target
        .locator(".msg-agent .md")
        .filter({ hasText: `revisão em tema ${theme}.` })
        .waitFor();
      await prompt.fill("");
      expect(await target.locator(".thread .mono-av").count()).toBe(0);
      expect((await target.locator(".thread .who").allTextContents()).join(" ")).not.toContain(
        agent.name,
      );
      const user = await target.locator(".msg-user").last().boundingBox();
      const reply = await target.locator(".msg-agent").last().boundingBox();
      expect(user).not.toBeNull();
      expect(reply).not.toBeNull();
      if (!user || !reply) throw new Error("Mensagens não visíveis");
      expect(user.x).toBeGreaterThan(reply.x);
      expect(await target.locator(".thread .msg-agent .who").count()).toBe(0);
      for (const bubble of [
        target.locator(".msg-user").last(),
        target.locator(".msg-agent .body").last(),
      ]) {
        const details = await bubble.evaluate((element) => {
          const time = element.querySelector("time");
          const text = element.querySelector("p");
          if (!time || !text) throw new Error("Mensagem sem texto ou horário");
          const style = getComputedStyle(time);
          return {
            below: time.getBoundingClientRect().top >= text.getBoundingClientRect().bottom,
            numeric: style.fontVariantNumeric,
            font: style.fontFamily,
            color: style.color,
            muted: getComputedStyle(element).getPropertyValue("--muted").trim(),
            padding: getComputedStyle(element).padding,
          };
        });
        expect(details.below).toBe(true);
        expect(details.numeric).toBe("tabular-nums");
        expect(details.font).toContain("monospace");
        expect(details.padding).toBe("10px 14px");
      }
      const checkRow = async () => {
        const boxes = await Promise.all([
          attach.boundingBox(),
          prompt.boundingBox(),
          send.boundingBox(),
        ]);
        const [a, t, s] = boxes;
        if (!a || !t || !s) throw new Error("Compositor não visível");
        expect(a.x + a.width).toBeLessThanOrEqual(t.x);
        expect(t.x + t.width).toBeLessThanOrEqual(s.x);
        expect(Math.abs(a.y + a.height - s.y - s.height)).toBeLessThan(1);
        expect(Math.abs(t.y + t.height - s.y - s.height)).toBeLessThan(1);
        for (const box of [a, s]) {
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
        }
      };
      await checkRow();
      await prompt.fill("Primeira linha\nSegunda linha\nTerceira linha");
      await checkRow();
      await prompt.focus();
      expect(await prompt.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe(
        "0px",
      );
      expect(await composer.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe(
        "2px",
      );
      expect(await composer.evaluate((element) => getComputedStyle(element).outlineOffset)).toBe(
        "3px",
      );
      await capture(`chat-${theme}`, target);
      await prompt.fill("");
      await capture(`chat-empty-${theme}`, target);
      await target.setViewportSize({ width: 700, height: 900 });
      await checkRow();
      await target.setViewportSize({ width: 1568, height: 1089 });
    }
  } finally {
    await target.close();
    await rpc.request("agents.delete", { id: agent.id });
  }
}, 30000);

test("group chat keeps only speaker names and its composer stays on one row", async () => {
  const channel = (await rpc.request("channels.create", {
    name: "Ideias em grupo",
    memberIds: [bot.id],
    ownerId: bot.id,
  })) as { id: string };
  const target = await browser.newPage();
  try {
    await target.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await target.getByRole("button", { name: "Ideias em grupo", exact: false }).click();
    const prompt = target.getByRole("textbox", {
      name: "Mensagem para #Ideias em grupo",
      exact: true,
    });
    const reply = rpc.waitForEventWhere("channel.message", (event) => {
      const message = event as ChannelMessage;
      return message.channelId === channel.id && message.authorKind === "agent";
    });
    await prompt.fill("echo:Podemos revisar juntos.");
    await target
      .locator(".channel-composer")
      .getByRole("button", { name: "Enviar", exact: true })
      .click();
    await reply;
    await target.locator(".msg-agent .md").filter({ hasText: "Podemos revisar juntos." }).waitFor();
    expect(await target.locator(".msg-agent .who").textContent()).toContain(bot.name);
    expect(await target.locator(".thread .mono-av").count()).toBe(0);
    const input = await prompt.boundingBox();
    const send = await target.locator(".channel-composer .send").boundingBox();
    expect(input).not.toBeNull();
    expect(send).not.toBeNull();
    if (!input || !send) throw new Error("Compositor não visível");
    expect(Math.abs(input.y + input.height - send.y - send.height)).toBeLessThan(1);
  } finally {
    await target.close();
    await rpc.request("channels.archive", { channelId: channel.id });
  }
}, 15000);

test("scheduled routines show recoverable RPC errors", async () => {
  const target = await browser.newPage();
  let fail = true;
  await target.routeWebSocket(/\/ws\?/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (fail && request.method === "routines.list")
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: "internal", message: "Falha de teste" },
          }),
        );
      else server.send(message);
    });
  });
  try {
    await target.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await target.getByRole("button", { name: "Agendadas", exact: true }).click();
    await target
      .getByRole("alert")
      .getByText("Não foi possível carregar as rotinas: Falha de teste")
      .waitFor();
    fail = false;
    await target.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    await target.getByText("Nenhuma rotina ainda.", { exact: false }).waitFor();
  } finally {
    await target.close();
  }
}, 15000);

test("capture matching prototype states when visual verification is requested", async () => {
  if (!out || !process.env.PHASE2_PROTOTYPE) return;
  const prototype = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  prototype.setDefaultTimeout(5000);
  const file = process.env.PHASE2_PROTOTYPE;
  for (const theme of ["light", "dark"]) {
    await prototype.goto(`file://${file}#inbox`);
    await prototype.reload();
    await prototype
      .getByRole("button", { name: theme === "light" ? "Tema claro" : "Tema escuro", exact: true })
      .click();
    await prototype.locator('[data-act="details"]').first().click();
    await capture(`prototype-chat-${theme}`, prototype);
    await prototype.locator('[data-agent="despesas"]').click();
    await capture(`prototype-approval-${theme}`, prototype);
    await prototype.locator('[data-act="approve-send"]').click();
    await capture(`prototype-toast-${theme}`, prototype);
    await prototype.locator('[data-act="details"]').first().click();
    await capture(`prototype-details-${theme}`, prototype);
    await prototype.keyboard.press("Meta+k");
    await capture(`prototype-palette-${theme}`, prototype);
    await prototype.keyboard.press("Escape");
    await prototype.keyboard.press("Meta+,");
    await capture(`prototype-settings-${theme}`, prototype);
    await prototype.keyboard.press("Escape");
    await prototype.locator('[data-view="apps"]').first().click();
    await capture(`prototype-apps-${theme}`, prototype);
    await prototype.locator('[data-app="sheets"]').click();
    await capture(`prototype-permissions-dialog-${theme}`, prototype);
  }
  await prototype.close();
}, 30000);

test("Pages and group chat use the active theme; settings tabs support arrow navigation", async () => {
  await rpc.request("channels.create", { name: "Revisão", memberIds: [bot.id] });
  for (const theme of ["light", "dark"]) {
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await page.evaluate((value) => localStorage.setItem("upbot.theme", value), theme);
    await page.reload();
    await page.locator(".side").waitFor();
    await page.keyboard.press("Meta+p");
    await page.getByText("Nenhuma página ainda.", { exact: false }).waitFor();
    await capture(`pages-${theme}`);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      theme,
    );
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Buscar", exact: true });
    await palette.getByRole("textbox").fill("Revisão");
    await palette
      .getByRole("option")
      .filter({ has: page.getByText("# Revisão", { exact: true }) })
      .click();
    await page.getByRole("textbox", { name: "Mensagem para #Revisão", exact: true }).waitFor();
    await capture(`group-chat-${theme}`);
    await page.keyboard.press("Meta+,");
    const general = page.getByRole("tab", { name: "Geral", exact: true });
    await general.click();
    await page.keyboard.press("ArrowRight");
    expect(
      await page.getByRole("tab", { name: "Apps", exact: true }).getAttribute("aria-selected"),
    ).toBe("true");
    await page.keyboard.press("Home");
    expect(await general.getAttribute("aria-selected")).toBe("true");
  }
}, 30000);
