#!/usr/bin/env bun
// UI smoke: daemon (source) + vite dev + real Chrome via playwright-core.
// Usage: bun run smoke:ui. Writes spikes/out/ui-smoke*.png + ui-smoke.json.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { readReadyPort } from "../packages/daemon/src/ready";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = join(ROOT, "packages/daemon/src/main.ts");
const FAKE_AGENT = join(ROOT, "packages/daemon/test/fixtures/fake-acp-agent.ts");
const OUT = join(ROOT, "spikes/out");
const TOKEN = `uismoke-${crypto.randomUUID()}`;

const results: { step: string; ok: boolean; ms: number; error?: string }[] = [];
function record(step: string, t0: number, error?: unknown) {
  results.push({
    step,
    ok: !error,
    ms: Date.now() - t0,
    ...(error ? { error: String(error) } : {}),
  });
}

async function waitHttp(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} not ready`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "oa-ui-data-"));
  const agentsRoot = mkdtempSync(join(tmpdir(), "oa-ui-agents-"));
  const stateDir = mkdtempSync(join(tmpdir(), "oa-ui-fake-"));

  const daemon = Bun.spawn(["bun", DAEMON, "--data-dir", dataDir, "--agents-root", agentsRoot], {
    env: {
      ...process.env,
      UPBOT_DEFAULT_BOT: "off",
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_CANCEL_GRACE_MS: "2000",
      FAKE_ACP_STATE_DIR: stateDir,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: ROOT,
  });
  const port = await readReadyPort(daemon, TOKEN, 15000);

  let vite: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await waitHttp("http://localhost:1420", 500);
  } catch {
    vite = Bun.spawn(
      [join(ROOT, "apps/desktop/node_modules/.bin/vite"), "--port", "1420", "--strictPort"],
      {
        cwd: join(ROOT, "apps/desktop"),
        env: process.env,
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    await waitHttp("http://localhost:1420", 15000);
  }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:1420/#port=${port}&token=${encodeURIComponent(TOKEN)}`);
  await page.getByText("Nenhum bot ainda.").waitFor({ timeout: 15000 });

  const step = async (name: string, fn: () => Promise<void>) => {
    const t0 = Date.now();
    try {
      await fn();
      record(name, t0);
    } catch (e) {
      record(name, t0, e);
      await page.screenshot({ path: join(OUT, `ui-smoke-fail-${name}.png`) }).catch(() => {});
    }
  };

  const type = async (text: string) => {
    // wait for the composer to clear from the previous send, then type keystrokes
    await page.waitForFunction(
      () => (document.querySelector("textarea")?.value ?? "") === "",
      null,
      { timeout: 10000 },
    );
    await page.getByLabel("Mensagem para o bot").pressSequentially(text);
  };

  await step("a-create", async () => {
    await page.locator('[aria-label="Criar bot"]').first().click();
    await page.getByLabel("O que ele faz").fill("A security researcher that reviews pull requests");
    await page.getByRole("button", { name: "Sugerir nome e instruções" }).click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#fName") as HTMLInputElement | null)?.value ===
        "Security Researcher",
      null,
      { timeout: 5000 },
    );
    await page.getByPlaceholder("Ex.: Viagens").waitFor();
    await page.screenshot({ path: join(OUT, "ui-smoke-draft.png") });
    await page.getByLabel("Devin").check();
    await page.getByRole("button", { name: "Criar e abrir" }).click();
    const bot = page.locator(".side .agent-item").filter({ hasText: "Security Researcher" });
    await bot.waitFor({ timeout: 5000 });
    await bot.locator(".mono-av").filter({ hasText: "🛡️" }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-avatar.png") });
  });

  await step("a-drawer-800", async () => {
    const originalSize = page.viewportSize();
    await page.setViewportSize({ width: 800, height: 900 });
    await page.getByRole("button", { name: "Conversas" }).click();
    await page.locator(".app.side-open .side").waitFor();
    await page.screenshot({ path: join(OUT, "ui-smoke-drawer-800.png") });
    await page.locator(".side-scrim").click();
    await page.locator(".app.side-open").waitFor({ state: "detached" });
    if (originalSize) await page.setViewportSize(originalSize);
  });

  await step("i-permissions-notice", async () => {
    const notice = page.locator(".empty > p.meta").filter({ hasText: "Permissões:" });
    await notice.waitFor({ timeout: 10000 });
    await page.getByText("~/.config/devin/config.json").waitFor({ timeout: 10000 });
    const belowSuggestions = await page.locator(".empty").evaluate((empty) => {
      const suggestions = empty.querySelector(".suggest");
      const permissionNotice = empty.querySelector("p.meta");
      return Boolean(
        suggestions &&
          permissionNotice &&
          suggestions.compareDocumentPosition(permissionNotice) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    if (!belowSuggestions) throw new Error("permission notice is not below suggestions");
  });

  await step("b-echo", async () => {
    await type("echo:hello world");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByText("hello world", { exact: false }).waitFor({ timeout: 20000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-b.png") });
  });

  await step("c-permission", async () => {
    await type("tool");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Allow once" }).click();
    await page.getByText("permission:allow_once").waitFor({ timeout: 20000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-c.png") });
  });

  await step("d-stop", async () => {
    await type("slow");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByRole("button", { name: "Parar" }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Parar" }).click();
    await page.getByRole("button", { name: "Parar" }).waitFor({ state: "hidden", timeout: 10000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-d.png") });
  });

  await step("e-reload-stop", async () => {
    await type("slow");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByRole("button", { name: "Parar" }).waitFor({ timeout: 20000 });
    await page.reload();
    await page
      .getByRole("button", { name: /Security Researcher/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Parar" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Parar" }).click();
    await page.getByRole("button", { name: "Parar" }).waitFor({ state: "hidden", timeout: 15000 });
  });

  await step("g-queue", async () => {
    await type("slow");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByRole("button", { name: "Parar" }).waitFor({ timeout: 20000 });
    await type("echo:q1");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByText("echo:q1", { exact: false }).waitFor({ timeout: 10000 });
    await type("echo:q2");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByText("echo:q2", { exact: false }).waitFor({ timeout: 10000 });
    // remove q2, stop the turn -> queue pauses with q1 left
    await page
      .locator(".chip", { hasText: "echo:q2" })
      .getByRole("button", { name: "Remover da fila" })
      .click();
    await page.screenshot({ path: join(OUT, "ui-smoke-queue.png") });
    await page.getByRole("button", { name: "Parar" }).click();
    await page.getByText("Fila pausada").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Retomar fila" }).click();
    // q1 drains and echoes "q1"
    await page.getByText("q1", { exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Parar" }).waitFor({ state: "hidden", timeout: 15000 });
  });

  await step("h-config", async () => {
    await page.getByRole("button", { name: "Configurar bot" }).click();
    await page.getByText("Opções do provedor").waitFor({ timeout: 30000 });
    await page.getByLabel("Modelo").waitFor({ timeout: 30000 });
    await page.getByLabel("Modelo").selectOption("m2");
    await page.screenshot({ path: join(OUT, "ui-smoke-config.png") });
    // reopen settings: back to chat then gear again — selection persists
    await page
      .getByRole("button", { name: /Security Researcher/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Configurar bot" }).click();
    await page.getByLabel("Modelo").waitFor({ timeout: 30000 });
    const v = await page.getByLabel("Modelo").inputValue();
    if (v !== "m2") throw new Error(`model not persisted: ${v}`);
  });

  await step("f-delete", async () => {
    await page
      .getByRole("button", { name: /Security Researcher/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Configurar bot" }).click();
    await page.getByRole("button", { name: "Excluir" }).first().click();
    await page.getByText('Excluir "Security Researcher"?').waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Excluir" }).last().click();
    await page.getByText("Nenhum bot ainda.").waitFor({ timeout: 10000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-f.png") });
  });

  await browser.close();
  vite?.kill("SIGKILL");
  daemon.kill("SIGKILL");
  await Promise.allSettled([...(vite ? [vite.exited] : []), daemon.exited]);

  mkdirSync(OUT, { recursive: true });
  const outPath = join(OUT, "ui-smoke.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`wrote ${outPath}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
