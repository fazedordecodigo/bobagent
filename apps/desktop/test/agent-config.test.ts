import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const blueCounts: Record<string, number> = {};

async function capture(name: string, target = page, fullPage = false) {
  await target.addStyleTag({ content: "*{transition:none!important;animation:none!important}" });
  await target.evaluate(() => document.fonts.ready);
  if (shots) await target.screenshot({ path: join(shots, name), fullPage });
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
    FAKE_ACP_STATE_DIR: fake,
    FAKE_ACP_EFFORT: "1",
    UPBOT_COMPUTER_DRYRUN: join(state, "computer.log"),
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  agent = (await rpc.request("agents.create", {
    name: "Agente de teste",
    provider: "devin",
    instructions: "Instruções iniciais.",
  })) as Agent;
  await rpc.request("memories.add", { agentId: agent.id, text: "Fuso horário de Brasília" });
  await rpc.request("routines.create", {
    agentId: agent.id,
    name: "Resumo diário",
    prompt: "Escreva o resumo.",
    schedule: "daily 09:00",
    webhook: false,
  });
  try {
    await fetch("http://localhost:1422");
  } catch {
    vite = Bun.spawn(["bun", "run", "dev", "--port", "1422"], {
      cwd: join(ROOT, "apps/desktop"),
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch("http://localhost:1422")).ok) break;
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
  page = await browser.newPage({ viewport: { width: 1080, height: 900 } });
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem("upbot.agent", localStorage.getItem("upbot.agent") || id);
      localStorage.setItem("upbot.view", "chat");
    },
    { id: agent.id },
  );
  if (shots) mkdirSync(shots, { recursive: true });
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
    writeFileSync(join(state, "fake", "state.json"), JSON.stringify({ config: {} }));
    const currentAgent = (await rpc.request("agents.create", {
      name: "Agente de teste",
      provider: "devin",
      instructions: "Instruções iniciais.",
    })) as Agent;
    await rpc.request("memories.add", {
      agentId: currentAgent.id,
      text: "Fuso horário de Brasília",
    });
    await rpc.request("routines.create", {
      agentId: currentAgent.id,
      name: "Resumo diário",
      prompt: "Escreva o resumo.",
      schedule: "daily 09:00",
      webhook: true,
    });
    await rpc.request("computer.setAccess", { agentIds: [] });
    await page.goto(`http://localhost:1422/#port=${daemon.port}&token=${token}`);
    await page.evaluate(
      ({ id, color }) => {
        localStorage.setItem("upbot.agent", id);
        localStorage.setItem("upbot.theme", color === "claro" ? "light" : "dark");
      },
      { id: currentAgent.id, color: theme },
    );
    await page.reload();
    await openSettings();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:1422" });
    const name = page.getByLabel("Nome do agente");
    await name.waitFor();
    await page.waitForFunction(
      (expected) =>
        (document.querySelector("#agent-name") as HTMLInputElement | null)?.value === expected,
      currentAgent.name,
    );
    await capture(`01-pagina-inteira-${theme}.png`, page, true);

    await name.fill("Rascunho");
    await page.getByText("Alterações não salvas").waitFor();
    await page
      .locator("header")
      .filter({ hasText: "Configurações" })
      .getByText("Rascunho", { exact: true })
      .waitFor();
    await name.fill(currentAgent.name);
    expect(await page.getByText("Alterações não salvas").count()).toBe(0);

    await page.getByRole("button", { name: "Trocar ícone do agente" }).click();
    await page.getByRole("group", { name: "Ícones do agente" }).waitFor();
    await capture(`02-seletor-de-icone-${theme}.png`);
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

    await page.getByLabel("Instruções").fill("Rascunho descartado.");
    await page.getByLabel("Nova memória").fill("Rascunho descartado");
    await page.getByRole("button", { name: "Adicionar", exact: true }).click();
    await page.getByRole("button", { name: "Descartar" }).click();
    expect(await page.getByLabel("Instruções").inputValue()).toBe("Instruções iniciais.");
    expect(
      await page.getByRole("button", { name: "Remover memória: Rascunho descartado" }).count(),
    ).toBe(0);

    await page.getByRole("button", { name: "Trocar ícone do agente" }).click();
    await page.getByRole("button", { name: "Ícone chart" }).click();

    await page.getByRole("button", { name: "+ Nova rotina" }).click();
    await page.getByRole("dialog", { name: "Nova rotina" }).waitFor();
    await capture(`03-dialogo-rotina-${theme}.png`);
    await page.getByLabel("Nome", { exact: true }).fill("Rotina criada");
    await page.getByLabel("Quando").selectOption("daily");
    await page.getByRole("textbox", { name: "Horário" }).fill("inválido");
    await page.getByLabel("O que fazer").fill("Prepare o resumo da equipe.");
    await page.getByRole("button", { name: "Concluir" }).click();
    await page.getByText("Use o formato 09:00").waitFor();
    await page.getByRole("textbox", { name: "Horário" }).fill("10:30");
    await page.getByRole("button", { name: "Concluir" }).click();

    const savedRoutine = page.getByRole("button", { name: /Resumo diário/ });
    await savedRoutine.click();
    await page.getByRole("dialog", { name: "Editar rotina" }).waitFor();
    await page.getByRole("button", { name: "Copiar curl" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("curl -X POST");
    await page.getByRole("status").filter({ hasText: "Comando copiado." }).waitFor();
    await page.getByRole("button", { name: "Rodar agora" }).click();
    await page.getByRole("status").filter({ hasText: "Rotina iniciada." }).waitFor();
    await page.keyboard.press("Escape");
    expect(await savedRoutine.evaluate((button) => button === document.activeElement)).toBe(true);
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
    const restoredRoutine = page.getByRole("button", { name: /Resumo diário/ });
    await restoredRoutine.waitFor();
    expect(
      await restoredRoutine.evaluate((button) =>
        Array.from(button.parentElement?.querySelectorAll(":scope > button") ?? []).indexOf(button),
      ),
    ).toBe(savedRoutinePosition);

    await page.getByRole("switch", { name: "Usar o computador" }).click();
    await page.getByRole("dialog", { name: /Deixar .* usar o computador/ }).waitFor();
    await capture(`04-dialogo-usar-computador-${theme}.png`);
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

    const advanced = page.locator("details > summary");
    if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
    await page.getByRole("button", { name: "Excluir…" }).click();
    await page.getByRole("dialog", { name: `Excluir ${currentAgent.name}?` }).waitFor();
    expect(
      await page
        .getByRole("button", { name: "Cancelar" })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);
    await capture(`05-dialogo-excluir-${theme}.png`);
    await page.getByRole("button", { name: "Cancelar" }).click();

    await page.getByRole("button", { name: /Rotina criada/ }).waitFor();

    await page.getByLabel("Nome do agente").fill("Agente salvo");
    await page.getByLabel("Instruções").fill("Atualizadas pelo rascunho.");
    await page.getByLabel("Nova memória").fill("Prefere respostas objetivas");
    await page.getByRole("button", { name: "Adicionar", exact: true }).click();
    await page.getByRole("button", { name: "Alto" }).click();
    const model = page.getByLabel("Modelo");
    await model.selectOption("m2");
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
    expect(updated.config.model).toBe("m2");
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
    await page.setViewportSize({ width: 1080, height: 900 });

    await page.getByRole("button", { name: "Excluir…" }).click();
    await page.getByRole("button", { name: "Excluir agente" }).click();
    try {
      await page.getByText(`${updated.name} foi excluído.`).waitFor({ timeout: 3000 });
    } catch {
      const agentState = (await rpc.request("agents.list", {})) as Agent[];
      const inputName = await page
        .locator("#agent-name")
        .inputValue()
        .catch(() => null);
      throw new Error(
        `Agent deletion state missing: ${JSON.stringify({
          expected: updated.name,
          inputName,
          agentExists: agentState.some((item) => item.id === currentAgent.id),
          body: (await page.locator("body").innerText()).slice(-1000),
        })}`,
      );
    }
    await capture(`06-agente-excluido-${theme}.png`);
    await page.getByRole("button", { name: "Desfazer", exact: true }).click();
    expect(
      ((await rpc.request("agents.list", {})) as Agent[]).some(
        (item) => item.id === currentAgent.id,
      ),
    ).toBe(true);
  }

  await rpc.request("computer.setAccess", { agentIds: [] });
  const windows = await browser.newPage({
    viewport: { width: 1080, height: 900 },
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
    await windows.goto(`http://localhost:1422/#port=${daemon.port}&token=${token}`);
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
    await capture("07-dialogo-usar-computador-windows-claro.png", windows);
    await windows.getByRole("button", { name: "Agora não" }).click();
    await windows.evaluate(() => localStorage.setItem("upbot.theme", "dark"));
    await windows.reload();
    await openSettings(windows);
    await windows.getByRole("switch", { name: "Usar o computador" }).click();
    await windows.locator('[data-od-id="computer-dialog-windows"]').waitFor();
    await capture("07-dialogo-usar-computador-windows-escuro.png", windows);
    await windows.getByRole("button", { name: "Agora não" }).click();
  } finally {
    await windows.close();
  }
}, 120000);
