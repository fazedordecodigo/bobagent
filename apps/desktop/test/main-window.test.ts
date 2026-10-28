import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, ApprovalRule, ConnectedApp } from "@upbot/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  readPids,
  startDaemon,
} from "../../../packages/daemon/test/helpers";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let page: Page;
let vite: ReturnType<typeof Bun.spawn> | undefined;
let state: string;
let bot: Agent;
const token = `window-test-${crypto.randomUUID()}`;
const out = process.env.PHASE2_SCREEN_DIR;
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
    secrets: {},
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
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem("upbot.agent", id);
      localStorage.setItem("upbot.view", "chat");
    },
    { id: bot.id },
  );
  if (out) mkdirSync(out, { recursive: true });
}, 30000);

afterAll(async () => {
  if (out) writeFileSync(join(out, "blue-counts.json"), JSON.stringify(blueCounts, null, 2));
  await browser?.close();
  rpc?.close();
  daemon?.proc.kill();
  vite?.kill();
  if (state) {
    for (const pid of readPids(join(state, "fake"))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(state, { recursive: true, force: true });
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
      expect(await page.getByText("Diga o que precisa", { exact: false }).isVisible()).toBe(true);
      await send("echo:As entregas da semana estão organizadas para revisão.");
      await page
        .getByText("As entregas da semana estão organizadas para revisão.", { exact: true })
        .waitFor();
    }
    expect(
      await page.locator(".window-titlebar").evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(52);
    expect(await page.locator(".side").evaluate((el) => el.getBoundingClientRect().width)).toBe(
      248,
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
      .getByRole("button", { name: "Aprovar e executar" })
      .waitFor();
    await capture(`apps-approval-${theme}`);
    await page.getByRole("tab", { name: "Aprovações", exact: true }).click();
    await page.getByRole("button", { name: "Aprovar e executar" }).waitFor();
    await capture(`settings-approval-${theme}`);
    await page.keyboard.press("Meta+1");
    await card.waitFor();
    await card.getByRole("button", { name: "Aprovar e executar" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Ação aprovada para execução uma vez." })
      .waitFor();
    expect(await page.getByRole("button", { name: "Desfazer", exact: true }).count()).toBe(0);
    await capture(`toast-once-${theme}`);
    await page.getByRole("button", { name: "Fechar aviso" }).click();
    await page.getByRole("button", { name: "Enviar", exact: true }).waitFor();
    await send("mcp:notas-create_note {}");
    await card.waitFor();
    await card.getByRole("button", { name: "Permitir sempre" }).click();
    await page.getByRole("button", { name: "Desfazer", exact: true }).waitFor();
    await capture(`toast-always-${theme}`);
    expect(
      ((await rpc.request("approvals.rules", {})) as ApprovalRule[]).filter(
        (rule) => rule.pattern === "notas-create_note",
      ).length,
    ).toBe(1);
    await page.getByRole("button", { name: "Desfazer", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "não foi desfeita" }).waitFor();
    expect(((await rpc.request("approvals.rules", {})) as ApprovalRule[]).length).toBe(0);
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
    await page.getByRole("button", { name: /Custom MCP \(command\)/ }).click();
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
    await page.setViewportSize({ width: 740, height: 900 });
    expect(await page.locator(".side").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Abrir barra lateral", exact: true }).click();
    expect(await page.locator(".side").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator(".side").isVisible()).toBe(false);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}, 90000);

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
  }
  await prototype.close();
}, 30000);
