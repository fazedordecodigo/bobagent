#!/usr/bin/env bun
// UI smoke: daemon (source) + vite dev + real Chrome via playwright-core.
// Usage: bun run smoke:ui. Writes spikes/out/ui-smoke*.png + ui-smoke.json.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

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
  const dataDir = mkdtempSync(join(tmpdir(), "oa-ui-data-"));
  const agentsRoot = mkdtempSync(join(tmpdir(), "oa-ui-agents-"));
  const stateDir = mkdtempSync(join(tmpdir(), "oa-ui-fake-"));

  const daemon = Bun.spawn(["bun", DAEMON, "--data-dir", dataDir, "--agents-root", agentsRoot], {
    env: {
      ...process.env,
      OPENAGENT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      OPENAGENT_CANCEL_GRACE_MS: "2000",
      FAKE_ACP_STATE_DIR: stateDir,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: ROOT,
  });
  const sink = daemon.stdin as { write: (s: string) => void; flush: () => void };
  sink.write(`${TOKEN}\n`);
  sink.flush();

  const reader = (daemon.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  let port = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("daemon exited");
    buf += new TextDecoder().decode(value);
    const i = buf.indexOf("\n");
    if (i < 0) continue;
    const line = buf.slice(0, i);
    if (line.startsWith("OPENAGENT_READY ")) {
      port = JSON.parse(line.slice(16)).port;
      break;
    }
  }
  reader.releaseLock();

  const vite = Bun.spawn(
    [join(ROOT, "apps/desktop/node_modules/.bin/vite"), "--port", "1420", "--strictPort"],
    {
      cwd: join(ROOT, "apps/desktop"),
      env: process.env,
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  await waitHttp("http://localhost:1420", 15000);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:1420/#port=${port}&token=${encodeURIComponent(TOKEN)}`);

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

  await step("a-create", async () => {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByPlaceholder("Name").fill("UI Smoke");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("button", { name: /UI Smoke/ }).waitFor({ timeout: 5000 });
  });

  await step("b-echo", async () => {
    await page.getByPlaceholder("Message the agent…").fill("echo:hello world");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("hello world", { exact: false }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-b.png") });
  });

  await step("c-permission", async () => {
    await page.getByPlaceholder("Message the agent…").fill("tool");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Allow once" }).click();
    await page.getByText("permission:allow_once").waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-c.png") });
  });

  await step("d-stop", async () => {
    await page.getByPlaceholder("Message the agent…").fill("slow");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-d.png") });
  });

  await step("e-reload-stop", async () => {
    await page.getByPlaceholder("Message the agent…").fill("slow");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 20000 });
    await page.reload();
    await page.getByRole("button", { name: /UI Smoke/ }).click(); // reselect after reload
    await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 15000 });
  });

  await step("f-delete", async () => {
    await page.getByTitle("Agent settings").click();
    await page.getByRole("button", { name: "Delete" }).first().click();
    await page.getByText('Delete "UI Smoke"?').waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Delete" }).last().click();
    await page.getByText("No agents yet.").waitFor({ timeout: 10000 });
    await page.screenshot({ path: join(OUT, "ui-smoke-f.png") });
  });

  await browser.close();
  vite.kill("SIGKILL");
  daemon.kill("SIGKILL");
  await Promise.allSettled([vite.exited, daemon.exited]);

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
