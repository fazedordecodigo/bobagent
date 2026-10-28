import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--port", "1421"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch("http://localhost:1421")).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: "chrome" }),
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto("http://localhost:1421/#/kit");
  await page.getByRole("heading", { name: "Controles", exact: true }).waitFor();
}, 30000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
  if (server) await server.exited;
});

test("fields expose labels, empty, invalid, multiline and disabled states", async () => {
  expect(await page.getByLabel("Enviar relatório para").inputValue()).toBe(
    "marina.costa@empresa.com.br",
  );
  const empty = page.getByLabel("Buscar tarefa");
  expect(await empty.inputValue()).toBe("");
  await empty.fill("Relatório");
  expect(await empty.inputValue()).toBe("Relatório");
  const invalid = page.getByLabel("Limite por despesa");
  expect(await invalid.getAttribute("aria-invalid")).toBe("true");
  const hint = await invalid.getAttribute("aria-describedby");
  expect(await page.locator(`[id="${hint}"]`).textContent()).toBe(
    "Informe um valor acima de zero.",
  );
  expect(await page.getByLabel("Conta conectada").isDisabled()).toBe(true);
  await page.getByLabel("Instruções").fill("Uma tarefa\nDuas etapas");
  expect(await page.getByLabel("Instruções").inputValue()).toContain("\n");
});

test("switches, segments and buttons work with keyboard and preserve disabled state", async () => {
  const daily = page.getByRole("switch", { name: "Resumo diário às 8h" });
  expect(await daily.getAttribute("aria-checked")).toBe("false");
  await daily.focus();
  await page.keyboard.press("Space");
  expect(await daily.getAttribute("aria-checked")).toBe("true");
  expect(await page.getByRole("switch", { name: "Resumo por e-mail" }).isDisabled()).toBe(true);
  await page.getByRole("button", { name: "Ativas", exact: true }).click();
  expect(
    await page.getByRole("button", { name: "Ativas", exact: true }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    await page.getByRole("button", { name: "Todas", exact: true }).getAttribute("aria-pressed"),
  ).toBe("false");
  await page.getByRole("button", { name: "Selecionado", exact: true }).click();
  expect(
    await page
      .getByRole("button", { name: "Selecionado", exact: true })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  await page.getByRole("button", { name: "Aprovar e enviar", exact: true }).click();
  expect(await page.getByRole("status").textContent()).toBe(
    "Exemplo demonstrado. Nenhum relatório foi enviado.",
  );
});

test("theme persists, focus is visible, colors invert, reduced motion stops pulse", async () => {
  await page.getByRole("button", { name: "Tema escuro" }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("upbot.theme"))).toBe("dark");
  await page.reload();
  await page.getByRole("heading", { name: "Controles", exact: true }).waitFor();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  const selected = page.getByRole("button", { name: "Selecionado", exact: true });
  await selected.focus();
  const style = await selected.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      outline: css.outlineWidth,
      offset: css.outlineOffset,
      background: css.backgroundColor,
      color: css.color,
    };
  });
  expect(style.outline).toBe("2px");
  expect(style.offset).toBe("3px");
  expect(style.background).not.toBe(style.color);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .getByText("Em execução", { exact: true })
      .first()
      .locator("span")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  await page.getByRole("button", { name: "Tema claro" }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
});
