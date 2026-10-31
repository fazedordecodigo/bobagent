import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@boto/protocol";
import { z } from "zod";
import { getSetting, setSetting } from "./db/settings";

// Computer Use (macOS): screenshots via `screencapture`, mouse via CoreGraphics (JXA),
// keyboard via System Events. Off for every agent until the user allows it; macOS also asks
// for Screen Recording / Accessibility permission the first time.
// BOTO_COMPUTER_DRYRUN=<file> logs the commands instead of running them (tests).

const CLICK_JXA = `ObjC.import("CoreGraphics");
function run(argv) {
  const p = $.CGPointMake(Number(argv[0]), Number(argv[1]));
  const n = Number(argv[2]);
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, 0));
  for (let i = 1; i <= n; i++) {
    for (const t of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
      const e = $.CGEventCreateMouseEvent(null, t, p, 0);
      $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, i);
      $.CGEventPost($.kCGHIDEventTap, e);
    }
  }
}`;
const TYPE_AS = `on run argv
  tell application "System Events" to keystroke (item 1 of argv)
end run`;
const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
};
const MODIFIERS = new Set(["command", "control", "option", "shift"]);

const accessSchema = z.array(z.string());

export class ComputerUse {
  constructor(private db: Database) {}

  access(): string[] {
    return getSetting(this.db, "computer_use_agents", accessSchema, []);
  }

  setAccess(agentIds: string[]): void {
    setSetting(this.db, "computer_use_agents", [...new Set(agentIds)]);
  }

  available(): boolean {
    return process.platform === "darwin" || !!process.env.BOTO_COMPUTER_DRYRUN;
  }

  private check(agent: Agent) {
    if (!this.available()) throw new Error("Computer Use is only available on macOS");
    if (!this.access().includes(agent.id)) {
      throw new Error(
        "Computer Use is not enabled for you; the user can enable it in your agent settings",
      );
    }
  }

  private async exec(cmd: string[]): Promise<void> {
    const dry = process.env.BOTO_COMPUTER_DRYRUN;
    if (dry) {
      appendFileSync(dry, `${JSON.stringify(cmd)}\n`);
      return;
    }
    const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0)
      throw new Error(`${cmd[0]} failed: ${err.trim().slice(0, 300) || `exit ${code}`}`);
  }

  async screenshot(agent: Agent): Promise<string> {
    this.check(agent);
    const dir = join(agent.workspacePath, "computer");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `screen-${Date.now()}.png`);
    await this.exec(["screencapture", "-x", "-t", "png", file]);
    return `saved a screenshot of the main display to ${file} (click coordinates are in screen points)`;
  }

  async click(agent: Agent, x: unknown, y: unknown, double: boolean): Promise<string> {
    this.check(agent);
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0)
      throw new Error("`x`/`y` must be screen points");
    await this.exec([
      "osascript",
      "-l",
      "JavaScript",
      "-e",
      CLICK_JXA,
      String(Math.round(px)),
      String(Math.round(py)),
      double ? "2" : "1",
    ]);
    return `${double ? "double-" : ""}clicked at ${Math.round(px)},${Math.round(py)}`;
  }

  async type(agent: Agent, text: string): Promise<string> {
    this.check(agent);
    if (!text || text.length > 5000) throw new Error("`text` must be 1-5000 characters");
    await this.exec(["osascript", "-e", TYPE_AS, text]);
    return `typed ${text.length} characters`;
  }

  async key(agent: Agent, key: string, modifiers: unknown): Promise<string> {
    this.check(agent);
    const code = KEY_CODES[key.toLowerCase()];
    const single = key.length === 1 ? key.toLowerCase() : null;
    if (code === undefined && !(single && /^[a-z0-9]$/.test(single))) {
      throw new Error(
        `unsupported key; use a letter/digit or ${Object.keys(KEY_CODES).join(", ")}`,
      );
    }
    const mods = (Array.isArray(modifiers) ? modifiers : []).map(String);
    if (mods.some((m) => !MODIFIERS.has(m)))
      throw new Error("modifiers: command, control, option, shift");
    const using = mods.length ? ` using {${mods.map((m) => `${m} down`).join(", ")}}` : "";
    const action = code !== undefined ? `key code ${code}` : `keystroke "${single}"`;
    await this.exec(["osascript", "-e", `tell application "System Events" to ${action}${using}`]);
    return `pressed ${[...mods, key].join("+")}`;
  }
}
