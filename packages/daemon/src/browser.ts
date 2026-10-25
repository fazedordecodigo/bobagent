import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, BrowserTab } from "@bobagent/protocol";
import type { Subprocess } from "bun";
import type { Broadcast } from "./rpc";

// Agent-controllable browser: one Chromium-family browser (Chrome/Chromium/Edge/Brave) with
// its own profile, driven over the Chrome DevTools Protocol. Each agent gets its own tab.

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const NAV_TIMEOUT = 20_000;
const SNAPSHOT_CHARS = 15_000;

type Json = Record<string, unknown>;

export function findBrowser(): string | null {
  const override = process.env.BOBAGENT_BROWSER_PATH;
  if (override) return existsSync(override) ? override : null;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  closed = false;
  onClose: () => void = () => {};

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: Json;
        error?: { message: string };
      };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
      this.pending.clear();
      this.onClose();
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error("could not connect to the browser"));
    });
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.ws.close();
  }
}

type Tab = { agentId: string; targetId: string; sessionId: string; url: string; title: string };

const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  document.querySelectorAll("[data-bob-ref]").forEach((el) => el.removeAttribute("data-bob-ref"));
  const sel = "a[href],button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=tab],[contenteditable=true]";
  const els = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || el.disabled) continue;
    const ref = ++n; el.setAttribute("data-bob-ref", String(ref));
    const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.name || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const kind = tag === "input" ? "input[" + (el.type || "text") + "]" : (el.getAttribute("role") || tag);
    els.push("[" + ref + "] " + kind + (label ? ' "' + label + '"' : "") + (tag === "a" ? " -> " + el.getAttribute("href") : ""));
    if (n >= 300) break;
  }
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n");
  return JSON.stringify({ title: document.title, url: location.href, elements: els, text });
})()`;

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
};

export class BrowserService {
  private proc: Subprocess | null = null;
  private cdp: Cdp | null = null;
  private starting: Promise<Cdp> | null = null;
  private tabs = new Map<string, Tab>();

  constructor(
    private profileDir: string,
    private broadcast: Broadcast,
  ) {
    process.on("exit", () => this.kill());
  }

  list(): BrowserTab[] {
    return [...this.tabs.values()].map((t) => ({ agentId: t.agentId, url: t.url, title: t.title }));
  }

  running(): boolean {
    return this.cdp !== null && !this.cdp.closed;
  }

  private emit() {
    this.broadcast("browser.updated", { running: this.running(), tabs: this.list() });
  }

  private async browser(): Promise<Cdp> {
    if (this.cdp && !this.cdp.closed) return this.cdp;
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<Cdp> {
    if (process.env.BOBAGENT_BROWSER === "off") throw new Error("the agent browser is disabled");
    const exe = findBrowser();
    if (!exe)
      throw new Error(
        "no Chromium-based browser found (install Google Chrome or set BOBAGENT_BROWSER_PATH)",
      );
    mkdirSync(this.profileDir, { recursive: true });
    const portFile = join(this.profileDir, "DevToolsActivePort");
    rmSync(portFile, { force: true });
    this.kill();
    const headless = process.env.BOBAGENT_BROWSER_HEADLESS === "1";
    this.proc = Bun.spawn(
      [
        exe,
        "--remote-debugging-port=0",
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(headless ? ["--headless=new"] : []),
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    const deadline = Date.now() + 20_000;
    while (!existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2) {
      if (Date.now() > deadline || this.proc.exitCode !== null) {
        this.kill();
        throw new Error("the browser did not start");
      }
      await Bun.sleep(100);
    }
    const [port, path] = readFileSync(portFile, "utf8").split("\n");
    const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
    cdp.onClose = () => {
      this.cdp = null;
      this.tabs.clear();
      this.emit();
    };
    this.cdp = cdp;
    return cdp;
  }

  private kill() {
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
  }

  async close(): Promise<void> {
    this.cdp?.close();
    this.cdp = null;
    this.tabs.clear();
    this.kill();
    this.emit();
  }

  async closeTab(agentId: string): Promise<boolean> {
    const t = this.tabs.get(agentId);
    if (!t) return false;
    this.tabs.delete(agentId);
    await this.cdp?.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    this.emit();
    return true;
  }

  private async tab(agentId: string): Promise<{ cdp: Cdp; tab: Tab }> {
    const cdp = await this.browser();
    const existing = this.tabs.get(agentId);
    if (existing) return { cdp, tab: existing };
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const { sessionId } = (await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    await cdp.send("Page.enable", {}, sessionId);
    const tab = { agentId, targetId, sessionId, url: "about:blank", title: "" };
    this.tabs.set(agentId, tab);
    return { cdp, tab };
  }

  private async eval<T>(cdp: Cdp, tab: Tab, expression: string): Promise<T> {
    const r = (await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      tab.sessionId,
    )) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails)
      throw new Error(`page script failed: ${r.exceptionDetails.text ?? "error"}`);
    return r.result?.value as T;
  }

  private async settle(cdp: Cdp, tab: Tab) {
    const deadline = Date.now() + NAV_TIMEOUT;
    await Bun.sleep(150);
    while (Date.now() < deadline) {
      const state = await this.eval<string>(cdp, tab, "document.readyState").catch(() => "loading");
      if (state === "complete") break;
      await Bun.sleep(100);
    }
    const info = await this.eval<{ url: string; title: string }>(
      cdp,
      tab,
      "({ url: location.href, title: document.title })",
    ).catch(() => null);
    if (info) Object.assign(tab, info);
    this.emit();
  }

  async open(agent: Agent, url: string): Promise<string> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("`url` must be an absolute http(s) URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new Error("only http(s) URLs can be opened");
    const { cdp, tab } = await this.tab(agent.id);
    const r = (await cdp.send("Page.navigate", { url: u.href }, tab.sessionId)) as {
      errorText?: string;
    };
    if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
    await this.settle(cdp, tab);
    return `opened ${tab.url}${tab.title ? ` — ${tab.title}` : ""}. Use browser_snapshot to read it.`;
  }

  async snapshot(agent: Agent): Promise<string> {
    const { cdp, tab } = await this.tab(agent.id);
    const raw = await this.eval<string>(cdp, tab, SNAPSHOT_JS);
    const s = JSON.parse(raw) as { title: string; url: string; elements: string[]; text: string };
    Object.assign(tab, { url: s.url, title: s.title });
    const text =
      s.text.length > SNAPSHOT_CHARS ? `${s.text.slice(0, SNAPSHOT_CHARS)}\n[truncated]` : s.text;
    return `URL: ${s.url}\nTitle: ${s.title}\n\nInteractive elements (use the [ref] with browser_click/browser_type):\n${s.elements.join("\n") || "(none)"}\n\nPage text:\n${text}`;
  }

  private async locate(cdp: Cdp, tab: Tab, ref: unknown): Promise<{ x: number; y: number }> {
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 1)
      throw new Error("`ref` must be an element number from browser_snapshot");
    const pos = await this.eval<{ x: number; y: number } | null>(
      cdp,
      tab,
      `(() => { const el = document.querySelector('[data-bob-ref="${n}"]'); if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!pos) throw new Error(`element [${n}] not found; take a new browser_snapshot`);
    return pos;
  }

  async click(agent: Agent, ref: unknown): Promise<string> {
    const { cdp, tab } = await this.tab(agent.id);
    const { x, y } = await this.locate(cdp, tab, ref);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send(
        "Input.dispatchMouseEvent",
        { type, x, y, button: "left", clickCount: 1 },
        tab.sessionId,
      );
    }
    await this.settle(cdp, tab);
    return `clicked [${ref}]; now at ${tab.url}`;
  }

  async type(agent: Agent, ref: unknown, text: string, submit: boolean): Promise<string> {
    const { cdp, tab } = await this.tab(agent.id);
    await this.locate(cdp, tab, ref);
    await this.eval(
      cdp,
      tab,
      `(() => { const el = document.querySelector('[data-bob-ref="${Number(ref)}"]'); el.focus();
        if ("select" in el && typeof el.select === "function") el.select(); })()`,
    );
    await cdp.send("Input.insertText", { text }, tab.sessionId);
    if (submit) await this.key(cdp, tab, "Enter");
    await this.settle(cdp, tab);
    return `typed into [${ref}]${submit ? " and pressed Enter" : ""}; now at ${tab.url}`;
  }

  private async key(cdp: Cdp, tab: Tab, key: string) {
    const k = KEYS[key];
    if (!k) throw new Error(`unsupported key; use one of ${Object.keys(KEYS).join(", ")}`);
    const base = {
      key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
    };
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", ...base, ...(k.text ? { text: k.text } : {}) },
      tab.sessionId,
    );
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, tab.sessionId);
  }

  async press(agent: Agent, key: string): Promise<string> {
    const { cdp, tab } = await this.tab(agent.id);
    await this.key(cdp, tab, key);
    await this.settle(cdp, tab);
    return `pressed ${key}; now at ${tab.url}`;
  }

  async back(agent: Agent): Promise<string> {
    const { cdp, tab } = await this.tab(agent.id);
    await this.eval(cdp, tab, "history.back()");
    await this.settle(cdp, tab);
    return `went back; now at ${tab.url}`;
  }

  async screenshot(agent: Agent): Promise<string> {
    const { cdp, tab } = await this.tab(agent.id);
    const { data } = (await cdp.send(
      "Page.captureScreenshot",
      { format: "png" },
      tab.sessionId,
    )) as {
      data: string;
    };
    const dir = join(agent.workspacePath, "browser");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `screenshot-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return `saved a screenshot of ${tab.url} to ${file}`;
  }
}
