import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, Memory, Routine } from "@upbot/protocol";
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
let vite: ReturnType<typeof Bun.spawn> | undefined;
let state: string;
let agent: Agent;
const token = `agent-config-${crypto.randomUUID()}`;
const shots = process.env.AGENT_CONFIG_SCREEN_DIR;
const macUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const handoff = join(
  homedir(),
  "attachments",
  "20e5b3d2-04f8-4494-82fa-8b1dbee8ae61",
  "handoff",
  "upbot-config-agente-handoff",
);
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "agent-config.json"), "utf8"),
) as {
  agent: {
    name: string;
    createdAt: string;
    model: string;
    effort: string;
    instructions: string;
    memories: string[];
    routines: {
      name: string;
      when: string;
      time: string;
      prompt: string;
      hook: boolean;
    }[];
  };
};
const prototype = join(handoff, "prototipo", "upbot-config-agente.html");
const blueCounts: Record<string, number> = {};

async function newMacAppPage() {
  const target = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    userAgent: macUserAgent,
  });
  await target.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  });
  return target;
}

async function desktopServerReady() {
  try {
    const response = await fetch("http://localhost:1420");
    return response.ok && (await response.text()).includes('id="root"');
  } catch {
    return false;
  }
}

async function ensureDesktopServer() {
  if (await desktopServerReady()) return;
  if (!vite || vite.exitCode !== null) {
    vite = Bun.spawn(["bun", "run", "dev", "--port", "1420"], {
      cwd: join(ROOT, "apps/desktop"),
      stdout: "ignore",
      stderr: "inherit",
    });
  }
  for (let i = 0; i < 300; i++) {
    if (await desktopServerReady()) return;
    if (vite.exitCode !== null)
      throw new Error(`Vite exited before becoming ready (code ${vite.exitCode})`);
    await Bun.sleep(100);
  }
  throw new Error("Vite did not serve the desktop app on http://localhost:1420 within 30 seconds");
}

async function gotoApp(target: Page) {
  await ensureDesktopServer();
  await target.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
}

async function capturePrototype(name: string, fullPage = false) {
  if (!shots) return;
  const theme = name.endsWith("-escuro.png") ? "escuro" : "claro";
  const windows = name.includes("windows");
  const target = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
  });
  try {
    await target.goto(`file://${prototype}?tema=${theme}${windows ? "&so=windows" : ""}`);
    await target.addStyleTag({
      content:
        "*{transition:none!important;animation:none!important;scroll-behavior:auto!important}",
    });
    const state = name.slice(0, 2);
    if (state === "01")
      await target.locator("details").evaluate((el: HTMLDetailsElement) => (el.open = true));
    if (state === "02") {
      await target.locator("#tile").click();
      await target.locator("#iconPop").waitFor({ state: "visible" });
    }
    if (state === "03") {
      await target.locator("#name").fill("UpBot revisado");
      await target.locator("#savebar.show").waitFor();
    }
    if (state === "04") {
      await target.locator('[data-edit="1"]').click();
      await target.locator('[data-od-id="routine-dialog"]').waitFor();
    }
    if (state === "05" || state === "07") {
      await target.locator("#computer").click();
      await target
        .locator(`[data-od-id="${windows ? "computer-dialog-windows" : "computer-dialog"}"]`)
        .waitFor();
    }
    if (state === "06" || state === "08") {
      await target.locator("details").evaluate((el: HTMLDetailsElement) => (el.open = true));
      await target.locator("#del").click();
      await target.locator('[data-od-id="delete-dialog"]').waitFor();
      if (state === "08") {
        await target.locator('[data-x="yes"]').click();
        await target.locator(".gone").waitFor();
      }
    }
    await target.evaluate(() => document.fonts.ready);
    if (fullPage) {
      await target.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>("#scroll");
        const app = document.querySelector<HTMLElement>(".app");
        const head = document.querySelector<HTMLElement>(".main-head");
        if (scroll) {
          scroll.style.height = `${scroll.scrollHeight}px`;
          scroll.style.maxHeight = "none";
          scroll.style.overflow = "visible";
        }
        document.documentElement.style.height = "auto";
        document.body.style.height = "auto";
        if (app)
          app.style.height = `${Math.max(
            (scroll?.scrollHeight ?? 0) + (head?.offsetHeight ?? 0) + 1,
            innerHeight,
          )}px`;
      });
    }
    const directory = join(shots, "prototipo");
    mkdirSync(directory, { recursive: true });
    await target.screenshot({ path: join(directory, name), fullPage });
  } finally {
    await target.close();
  }
}

async function capture(name: string, target = page, fullPage = false) {
  await target.addStyleTag({ content: "*{transition:none!important;animation:none!important}" });
  await target.evaluate(() => document.fonts.ready);
  let previousStyles: string[] = [];
  if (shots) {
    if (["01", "02", "03"].includes(name.slice(0, 2)))
      await target.locator("[data-agent-config-scroll]").evaluateAll((elements) => {
        for (const element of elements) element.scrollTop = 0;
      });
    if (fullPage) {
      previousStyles = await target.evaluate(() => {
        const app = document.querySelector<HTMLElement>(".app");
        const scroll = document.querySelector<HTMLElement>("[data-agent-config-scroll]");
        const header = document.querySelector<HTMLElement>("[data-agent-config-top]");
        const nodes = [document.documentElement, document.body, app, scroll].filter(
          (element): element is HTMLElement => !!element,
        );
        const styles = nodes.map((element) => element.getAttribute("style") ?? "");
        if (scroll) {
          scroll.style.height = `${scroll.scrollHeight}px`;
          scroll.style.maxHeight = "none";
          scroll.style.overflow = "visible";
          scroll.style.flex = "none";
        }
        if (app)
          app.style.height = `${Math.max((scroll?.scrollHeight ?? 0) + (header?.offsetHeight ?? 0), innerHeight)}px`;
        document.documentElement.style.height = "auto";
        document.body.style.height = "auto";
        document.body.style.overflow = "visible";
        return styles;
      });
    }
    await target.screenshot({ path: join(shots, name), fullPage });
    await capturePrototype(name, fullPage);
    if (fullPage) {
      await target.evaluate((styles) => {
        const nodes = [
          document.documentElement,
          document.body,
          document.querySelector<HTMLElement>(".app"),
          document.querySelector<HTMLElement>("[data-agent-config-scroll]"),
        ].filter((element): element is HTMLElement => !!element);
        nodes.forEach((element, index) => {
          if (styles[index]) element.setAttribute("style", styles[index]);
          else element.removeAttribute("style");
        });
      }, previousStyles);
    }
  }
  const blueElements = await target.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return [...document.querySelectorAll("body *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight)
          return false;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") return false;
        const parent = element.parentElement && getComputedStyle(element.parentElement);
        return (
          style.backgroundColor === accent ||
          (style.color === accent && parent?.color !== accent) ||
          (style.outlineColor === accent && style.outlineStyle !== "none") ||
          style.boxShadow.includes(accent) ||
          ["Top", "Right", "Bottom", "Left"].some(
            (side) =>
              style.getPropertyValue(`border-${side.toLowerCase()}-color`) === accent &&
              Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
          )
        );
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: element.textContent?.trim().slice(0, 40),
        label: element.getAttribute("aria-label"),
        className: element.getAttribute("class"),
      }));
  });
  const count = blueElements.length;
  blueCounts[name] = count;
  if (count > 2)
    throw new Error(`Too many blue elements (${count}): ${JSON.stringify(blueElements)}`);
  expect(count).toBeLessThanOrEqual(2);
}

async function openSettings(target = page) {
  if ((await target.locator("[data-agent-config-top]").count()) > 0) return;
  const button = target.getByRole("button", { name: "Configurar bot" });
  try {
    await button.waitFor({ timeout: 5000 });
  } catch {
    const details = await target.evaluate(async () => {
      const params = new URLSearchParams(location.hash.split("?")[1] ?? location.hash.slice(1));
      const port = Number(params.get("port"));
      const token = params.get("token") ?? "";
      const socket = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
        const timer = setTimeout(() => resolve("timeout"), 1000);
        ws.onopen = () => {
          clearTimeout(timer);
          ws.close();
          resolve("open");
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve("error");
        };
      });
      return { port, hasToken: !!token, socket };
    });
    throw new Error(
      `Agent settings entry unavailable (${JSON.stringify(details)}): ${(await target.locator("body").innerText()).slice(0, 1200)}`,
    );
  }
  await button.click();
  await target.getByText("Configurações", { exact: true }).waitFor();
}

beforeAll(async () => {
  state = mkdtempSync(join(homedir(), "upbot-agent-config-"));
  const fake = join(state, "fake");
  mkdirSync(fake);
  daemon = await startDaemon(join(state, "data"), join(state, "agents"), token, {
    UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    UPBOT_ACP_COMMAND_GROK: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: fake,
    FAKE_ACP_EFFORT: "1",
    UPBOT_COMPUTER_DRYRUN: join(state, "computer.log"),
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await ensureDesktopServer();
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: "chrome" }),
    headless: true,
  });
  page = await newMacAppPage();
  if (shots) {
    mkdirSync(shots, { recursive: true });
    mkdirSync(join(shots, "prototipo"), { recursive: true });
  }
}, 60000);

afterAll(async () => {
  if (shots) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(shots, "blue-counts.json"), JSON.stringify(blueCounts, null, 2));
  }
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

test("agent settings save drafts through real daemon RPCs and expose the handoff dialogs", async () => {
  for (const theme of ["claro", "escuro"] as const) {
    if (theme === "escuro") {
      await page.close();
      page = await newMacAppPage();
      await rpc.request("agents.delete", { id: agent.id });
    }
    writeFileSync(
      join(state, "fake", "state.json"),
      JSON.stringify({ config: { model: fixture.agent.model, effort: fixture.agent.effort } }),
    );
    const currentAgent = (await rpc.request("agents.create", {
      name: fixture.agent.name,
      provider: "grok",
      instructions: fixture.agent.instructions,
    })) as Agent;
    const fixtureDb = new Database(join(state, "data", "upbot.db"));
    fixtureDb
      .query("UPDATE agents SET created_at = ?, config_json = ? WHERE id = ?")
      .run(
        new Date(`${fixture.agent.createdAt}T12:00:00`).getTime(),
        JSON.stringify({ model: fixture.agent.model, effort: fixture.agent.effort }),
        currentAgent.id,
      );
    fixtureDb.close();
    agent = currentAgent;
    for (const text of fixture.agent.memories)
      await rpc.request("memories.add", { agentId: currentAgent.id, text });
    for (const routine of fixture.agent.routines) {
      const schedule =
        routine.when === "30m"
          ? "every 30m"
          : routine.when === "weekly"
            ? `weekly fri ${routine.time.split(" ")[1]}`
            : null;
      await rpc.request("routines.create", {
        agentId: currentAgent.id,
        name: routine.name,
        prompt: routine.prompt,
        schedule,
        webhook: routine.hook,
      });
    }
    const configOptions = (await rpc.request("agents.configOptions", {
      agentId: currentAgent.id,
    })) as { configOptions: { id: string; currentValue: string }[] };
    expect(configOptions.configOptions.some((option) => option.id === "effort")).toBe(true);
    expect(configOptions.configOptions.find((option) => option.id === "effort")?.currentValue).toBe(
      fixture.agent.effort,
    );
    await rpc.request("computer.setAccess", { agentIds: [] });
    await page.addInitScript(
      ({ id, color }) => {
        localStorage.setItem("upbot.agent", id);
        localStorage.setItem("upbot.theme", color === "claro" ? "light" : "dark");
        localStorage.setItem("upbot.view", "chat");
      },
      { id: currentAgent.id, color: theme },
    );
    await gotoApp(page);
    expect(await page.evaluate(() => navigator.userAgent)).toBe(macUserAgent);
    expect(await page.evaluate(() => navigator.platform)).toBe("MacIntel");
    await page.addStyleTag({
      content:
        "*{transition:none!important;animation:none!important;scroll-behavior:auto!important}",
    });
    await openSettings();
    await page.locator('.side-bot[aria-current="true"]').getByText(currentAgent.name).waitFor();
    expect(await page.getByText(/internal error/i).count()).toBe(0);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:1420" });
    const name = page.getByLabel("Nome do agente");
    await name.waitFor();
    await page.waitForFunction(
      (expected) =>
        (document.querySelector("#agent-name") as HTMLInputElement | null)?.value === expected,
      currentAgent.name,
    );
    const advanced = page.locator("details > summary");
    if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
    await page.locator("[data-agent-config-scroll]").evaluate((element) => {
      element.scrollTop = 0;
    });
    await capture(`01-pagina-inteira-${theme}.png`, page, true);
    await advanced.click();

    const computerSwitch = page.getByRole("switch", { name: "Usar o computador" });
    await computerSwitch.click();
    await page.getByRole("dialog", { name: /Deixar .* usar o computador/ }).waitFor();
    expect(await page.getByRole("dialog").locator("footer button").allTextContents()).toEqual([
      "Agora não",
      "Permitir",
    ]);
    await capture(`05-dialogo-usar-computador-${theme}.png`);
    await page.keyboard.press("Escape");
    await advanced.click();
    await page.getByRole("button", { name: "Excluir…" }).click();
    await page.getByRole("dialog", { name: `Excluir ${currentAgent.name}?` }).waitFor();
    await capture(`06-dialogo-excluir-${theme}.png`);
    await page.getByRole("button", { name: "Cancelar" }).click();
    await advanced.click();
    const sampleRoutine = page.getByRole("button", { name: /Relatório semanal/ });
    await sampleRoutine.click();
    await page.getByRole("dialog", { name: "Editar rotina" }).waitFor();
    await page
      .getByText("O agente começa a tarefa sozinho e pergunta antes de pagar, enviar ou apagar.")
      .waitFor();
    expect(await page.getByLabel("Horário").isEnabled()).toBe(true);
    await capture(`04-dialogo-rotina-${theme}.png`);
    await page.keyboard.press("Escape");

    const windowsCapture = await browser.newPage({
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: 2,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    });
    try {
      await windowsCapture.addInitScript(
        ({ id, color }) => {
          Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
          localStorage.setItem("upbot.agent", id);
          localStorage.setItem("upbot.view", "chat");
          localStorage.setItem("upbot.theme", color === "claro" ? "light" : "dark");
        },
        { id: currentAgent.id, color: theme },
      );
      await gotoApp(windowsCapture);
      await windowsCapture.addStyleTag({
        content:
          "*{transition:none!important;animation:none!important;scroll-behavior:auto!important}",
      });
      await openSettings(windowsCapture);
      await windowsCapture.getByRole("switch", { name: "Usar o computador" }).click();
      await windowsCapture.locator('[data-od-id="computer-dialog-windows"]').waitFor();
      await capture(`07-dialogo-usar-computador-windows-${theme}.png`, windowsCapture);
    } finally {
      await windowsCapture.close();
    }

    await name.fill("UpBot revisado");
    await page.getByText("Alterações não salvas").waitFor();
    await page
      .locator("header")
      .filter({ hasText: "Configurações" })
      .getByText("UpBot revisado", { exact: true })
      .waitFor();
    await capture(`03-barra-salvar-${theme}.png`);
    await name.fill(currentAgent.name);
    expect(await page.getByText("Alterações não salvas").count()).toBe(0);

    await page.getByRole("button", { name: "Trocar ícone do agente" }).click();
    await page.getByRole("group", { name: "Ícone do agente" }).waitFor();
    await capture(`02-popover-icone-${theme}.png`);
    await page.getByRole("button", { name: "Ícone chart" }).focus();
    await page.keyboard.press("Escape");
    expect(
      await page
        .getByRole("button", { name: "Trocar ícone do agente" })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);
    await page.getByRole("button", { name: "Trocar ícone do agente" }).click();
    await page.getByRole("button", { name: "Ícone chart" }).click();
    expect(
      await page
        .getByRole("button", { name: "Trocar ícone do agente" })
        .getAttribute("aria-expanded"),
    ).toBe("false");

    if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
    await page.getByRole("button", { name: "Excluir…" }).click();
    await page.getByRole("button", { name: "Excluir agente" }).click();
    await page.getByText("UpBot foi excluído.").waitFor();
    await capture(`08-agente-excluido-${theme}.png`);
    await page.getByRole("button", { name: "Voltar ao início" }).click();
    const deletedToast = page.getByRole("status").filter({ hasText: "Agente excluído." });
    await deletedToast.getByRole("button", { name: "Desfazer", exact: true }).waitFor();
    await deletedToast.getByRole("button", { name: "Desfazer", exact: true }).click();
    await page.getByLabel("Instruções").waitFor();
    expect(
      ((await rpc.request("agents.list", {})) as Agent[]).some(
        (item) => item.id === currentAgent.id,
      ),
    ).toBe(true);
    if (theme === "escuro") {
      if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
      await page.getByRole("button", { name: "Excluir…" }).click();
      await page.getByRole("dialog", { name: `Excluir ${currentAgent.name}?` }).waitFor();
      await page.getByRole("button", { name: "Excluir agente" }).click();
      await page.getByText(`${currentAgent.name} foi excluído.`).waitFor();
      await page.getByRole("button", { name: "Voltar ao início" }).click();
      const retryToast = page.getByRole("status").filter({ hasText: "Agente excluído." });
      await retryToast.getByRole("button", { name: "Desfazer", exact: true }).waitFor();
      await rpc.request("agents.restore", { id: currentAgent.id });
      await retryToast.getByRole("button", { name: "Desfazer", exact: true }).click();
      const failureToast = page.getByRole("status").filter({ hasText: "Não deu para desfazer:" });
      await failureToast.getByRole("button", { name: "Desfazer", exact: true }).waitFor();
      continue;
    }

    await page.getByLabel("Instruções").fill("Rascunho descartado.");
    await page.getByLabel("Nova memória").fill("Rascunho descartado");
    await page.getByRole("button", { name: "Adicionar", exact: true }).click();
    await page.getByRole("button", { name: "Descartar" }).click();
    expect(await page.getByLabel("Instruções").inputValue()).toContain("Você é o UpBot");
    expect(
      await page.getByRole("button", { name: "Remover memória: Rascunho descartado" }).count(),
    ).toBe(0);

    await page.getByRole("button", { name: "Trocar ícone do agente" }).click();
    await page.getByRole("button", { name: "Ícone chart" }).click();

    await page.getByRole("button", { name: "+ Nova rotina" }).click();
    await page.getByRole("dialog", { name: "Nova rotina" }).waitFor();
    await page.getByLabel("Nome", { exact: true }).fill("Rotina criada");
    await page.getByLabel("Quando").selectOption("daily");
    await page.getByRole("switch", { name: "Também começar por webhook" }).click();
    await page.getByRole("textbox", { name: "Horário" }).fill("inválido");
    await page.getByLabel("O que fazer").fill("Prepare o resumo da equipe.");
    await page.getByRole("button", { name: "Criar rotina" }).click();
    await page.getByText("Use o formato 09:00").waitFor();
    await page.getByRole("textbox", { name: "Horário" }).fill("10:30");
    await page.getByRole("button", { name: "Criar rotina" }).click();

    await page.getByRole("button", { name: "Salvar", exact: false }).click();
    await page.getByRole("status").filter({ hasText: "Configurações salvas." }).waitFor();
    const savedRoutine = page.getByRole("button", { name: /Relatório semanal/ });
    await savedRoutine.click();
    await page.getByRole("dialog", { name: "Editar rotina" }).waitFor();
    await page.keyboard.press("Escape");
    const hookRoutine = page.getByRole("button", { name: /Rotina criada/ });
    await hookRoutine.click();
    await page.getByRole("dialog", { name: "Editar rotina" }).waitFor();
    await page.getByRole("button", { name: "Copiar curl" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("curl -X POST");
    await page.getByRole("status").filter({ hasText: "Comando copiado." }).waitFor();
    await page.getByRole("button", { name: "Rodar agora" }).click();
    await page.getByRole("status").filter({ hasText: "Rotina iniciada." }).waitFor();
    await page.keyboard.press("Escape");
    expect(await hookRoutine.evaluate((button) => button === document.activeElement)).toBe(true);
    const savedRoutinePosition = await savedRoutine.evaluate((button) =>
      Array.from(button.parentElement?.querySelectorAll(":scope > button") ?? []).indexOf(button),
    );
    await savedRoutine.click();
    await page.getByRole("dialog", { name: "Editar rotina" }).waitFor();
    await page.getByRole("button", { name: "Remover rotina" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Rotina removida." })
      .getByRole("button", { name: "Desfazer" })
      .click();
    const restoredRoutine = page.getByRole("button", { name: /Relatório semanal/ });
    await restoredRoutine.waitFor();
    expect(
      await restoredRoutine.evaluate((button) =>
        Array.from(button.parentElement?.querySelectorAll(":scope > button") ?? []).indexOf(button),
      ),
    ).toBe(savedRoutinePosition);

    await page.getByRole("switch", { name: "Usar o computador" }).click();
    await page.getByRole("dialog", { name: /Deixar .* usar o computador/ }).waitFor();
    await page.keyboard.press("Escape");
    expect(
      await page.getByRole("switch", { name: "Usar o computador" }).getAttribute("aria-checked"),
    ).toBe("false");
    await page.getByRole("switch", { name: "Usar o computador" }).click();
    await page.getByRole("button", { name: "Agora não" }).click();
    expect(
      await page.getByRole("switch", { name: "Usar o computador" }).getAttribute("aria-checked"),
    ).toBe("false");
    await page.getByRole("switch", { name: "Usar o computador" }).click();
    await page.getByRole("button", { name: "Permitir" }).click();

    if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
    await page.getByRole("button", { name: "Excluir…" }).click();
    await page.getByRole("dialog", { name: `Excluir ${currentAgent.name}?` }).waitFor();
    expect(
      await page
        .getByRole("button", { name: "Cancelar" })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);
    await page.getByRole("button", { name: "Cancelar" }).click();

    await page.getByRole("button", { name: /Rotina criada/ }).waitFor();

    await page.getByLabel("Nome do agente").fill("Agente salvo");
    await page.getByLabel("Instruções").fill("Atualizadas pelo rascunho.");
    await page.getByLabel("Nova memória").fill("Prefere respostas objetivas");
    await page.getByRole("button", { name: "Adicionar", exact: true }).click();
    await page.getByRole("button", { name: "Alto" }).click();
    const model = page.getByLabel("Modelo");
    await model.selectOption("grok-4.7");
    await page.keyboard.press("Control+s");
    await page.getByRole("status").filter({ hasText: "Configurações salvas." }).waitFor();
    const updated = ((await rpc.request("agents.list", {})) as Agent[]).find(
      (item) => item.id === currentAgent.id,
    );
    expect(updated).toBeDefined();
    if (!updated) throw new Error("Saved agent was not returned by agents.list");
    expect(updated.avatar).toEqual({ icon: "chart" });
    expect(updated.name).toBe("Agente salvo");
    expect(updated.instructions).toBe("Atualizadas pelo rascunho.");
    expect(updated.config.effort).toBe("high");
    expect(updated.config.model).toBe("grok-4.7");
    const memories = (await rpc.request("memories.list", { agentId: currentAgent.id })) as Memory[];
    expect(memories.map((item) => item.text)).toContain("Prefere respostas objetivas");
    expect(
      ((await rpc.request("computer.access", {})) as { agentIds: string[] }).agentIds,
    ).toContain(currentAgent.id);
    expect(
      ((await rpc.request("routines.list", { agentId: currentAgent.id })) as Routine[]).map(
        (item) => item.name,
      ),
    ).toContain("Rotina criada");

    await model.selectOption("");
    await page.getByRole("button", { name: "Salvar", exact: false }).click();
    await page.getByRole("status").filter({ hasText: "Configurações salvas." }).waitFor();
    expect(
      ((await rpc.request("agents.list", {})) as Agent[]).find(
        (item) => item.id === currentAgent.id,
      )?.config.model,
    ).toBeUndefined();
    await page.setViewportSize({ width: 700, height: 900 });
    expect(await page.locator("[class*='tag']").first().isVisible()).toBe(false);
    expect(
      await page
        .getByRole("button", { name: /^Remover memória:/ })
        .first()
        .isVisible(),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 860 });
  }

  const distinctAgent = (await rpc.request("agents.create", {
    name: "Agente de teste distinto",
    provider: "grok",
  })) as Agent;
  expect(distinctAgent.name).not.toBe(agent.name);
  const activeNames = ((await rpc.request("agents.list", {})) as Agent[]).map((item) => item.name);
  expect(new Set(activeNames).size).toBe(activeNames.length);

  await rpc.request("computer.setAccess", { agentIds: [] });
  const windows = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  });
  try {
    await windows.addInitScript(
      ({ id }) => {
        Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
        localStorage.setItem("upbot.agent", id);
        localStorage.setItem("upbot.view", "chat");
      },
      { id: agent.id },
    );
    await gotoApp(windows);
    await openSettings(windows);
    await windows.getByLabel("Nome do agente").fill("Rascunho Windows");
    expect(await windows.getByRole("button", { name: /Salvar/ }).textContent()).toContain("Ctrl+S");
    await windows.getByRole("switch", { name: "Usar o computador" }).click();
    await windows.locator('[data-od-id="computer-dialog-windows"]').waitFor();
    await windows.getByText(/Windows não pede permissão à parte/).waitFor();
    expect(
      await windows
        .getByRole("button", { name: "Permitir" })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);
    const windowsButtons = windows.locator('[data-od-id="computer-dialog-windows"] footer button');
    expect(await windowsButtons.allTextContents()).toEqual(["Permitir", "Agora não"]);
    const buttonWidths = await windowsButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().width),
    );
    expect(buttonWidths[0]).toBe(buttonWidths[1]);
    await windows.getByRole("button", { name: "Agora não" }).click();
    await windows.evaluate(() => localStorage.setItem("upbot.theme", "dark"));
    await windows.reload();
    await openSettings(windows);
    await windows.getByRole("switch", { name: "Usar o computador" }).click();
    await windows.locator('[data-od-id="computer-dialog-windows"]').waitFor();
    await windows.getByRole("button", { name: "Agora não" }).click();
  } finally {
    await windows.close();
  }
}, 120000);
