#!/usr/bin/env bun
// Mode probe: per provider × mode, measure which tool calls trigger permission
// requests when the client always answers allow_once.
// Usage: bun spikes/mode-probe.ts -> spikes/out/mode-probe.json

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 180_000;
const PROVIDERS: Record<string, string[]> = {
  devin: ["devin", "acp"],
  cursor: ["agent", "acp"],
  grok: ["grok", "agent", "stdio"],
  opencode: ["opencode", "acp"],
};
const SKIP_MODE = /bypass|auto.?approve|smart/i;
const PROMPT =
  "Using your tools, create a file named probe.txt containing the text hi in the current directory, then run the shell command `ls -1` and tell me its output.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms)),
  ]);
}

async function probe(provider: string, cmd: string[], mode: string | null) {
  const rec: Record<string, unknown> = {
    provider,
    mode,
    permissionRequests: [] as unknown[],
    toolCalls: [] as unknown[],
    fileCreated: false,
    stopReason: null,
    agentText: "",
    errors: [] as string[],
  };
  const cwd = mkdtempSync(join(tmpdir(), `mode-probe-${provider}-${mode ?? "none"}-`));
  const child: ChildProcess = spawn(cmd[0]!, cmd.slice(1), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stderrLines: string[] = [];
  child.stderr?.on("data", (d: Buffer) => stderrLines.push(...d.toString().split("\n")));

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  let lastPerm: { title?: string; kind?: string } | null = null;
  const app = acp
    .client({ name: "mode-probe" })
    .onRequest("session/request_permission", async (ctx) => {
      const p = ctx.params as {
        toolCall?: { title?: string; kind?: string };
        options?: { optionId: string; name: string; kind: string }[];
      };
      (rec.permissionRequests as unknown[]).push({
        title: p.toolCall?.title,
        toolKind: p.toolCall?.kind,
        options: p.options?.map((o) => o.optionId),
      });
      lastPerm = p.toolCall ?? null;
      const allow =
        p.options?.find((o) => o.optionId === "allow_once") ??
        p.options?.find((o) => o.kind?.startsWith("allow"));
      if (!allow) return { outcome: { outcome: "cancelled" } } as never;
      return { outcome: { outcome: "selected", optionId: allow.optionId } } as never;
    })
    .onNotification("session/update", async (ctx) => {
      const u = (ctx.params as { update?: Record<string, unknown> }).update ?? {};
      const k = u.sessionUpdate;
      if (k === "tool_call" || k === "tool_call_update") {
        (rec.toolCalls as unknown[]).push({
          kind: u.kind,
          title: u.title,
          status: u.status,
          precededByPermission: lastPerm !== null,
        });
      } else if (k === "agent_message_chunk") {
        const c = u.content as { type?: string; text?: string };
        if (c?.type === "text" && c.text) rec.agentText = (rec.agentText as string) + c.text;
      }
    });
  const conn = app.connect(stream);
  conn.closed.catch(() => {});
  try {
    await withTimeout(
      conn.agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "mode-probe", version: "0" },
      } as never),
      TIMEOUT,
      "initialize",
    );
    const ns = (await withTimeout(
      conn.agent.request("session/new", { cwd, mcpServers: [] } as never),
      TIMEOUT,
      "session/new",
    )) as { sessionId: string };
    if (mode !== null) {
      await withTimeout(
        conn.agent.request("session/set_config_option", {
          sessionId: ns.sessionId,
          configId: "mode",
          value: mode,
        } as never),
        TIMEOUT,
        "set_config_option",
      );
    }
    const pr = (await withTimeout(
      conn.agent.request("session/prompt", {
        sessionId: ns.sessionId,
        prompt: [{ type: "text", text: PROMPT }],
      } as never),
      TIMEOUT,
      "prompt",
    )) as { stopReason?: string };
    rec.stopReason = pr.stopReason ?? null;
  } catch (e) {
    (rec.errors as string[]).push(e instanceof Error ? e.message : String(e));
  }
  await sleep(300);
  rec.fileCreated = existsSync(join(cwd, "probe.txt"));
  rec.agentText = (rec.agentText as string).trim().slice(0, 500);
  rec.stderrTail = stderrLines.slice(-10).join("\n").slice(0, 500);
  try {
    conn.close();
  } catch {}
  try {
    child.kill("SIGKILL");
  } catch {}
  return rec;
}

async function main() {
  const results: Record<string, unknown>[] = [];
  for (const [provider, cmd] of Object.entries(PROVIDERS)) {
    // discover mode options from a quick session/new
    const cwd = mkdtempSync(join(tmpdir(), `mode-probe-disc-${provider}-`));
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const conn = acp.client({ name: "mode-probe-disc" }).connect(stream);
    conn.closed.catch(() => {});
    let modes: string[] = [];
    let defaultMode: string | null = null;
    try {
      await withTimeout(
        conn.agent.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        } as never),
        30000,
        "init",
      );
      const ns = (await withTimeout(
        conn.agent.request("session/new", { cwd, mcpServers: [] } as never),
        30000,
        "session/new",
      )) as {
        configOptions?: {
          id: string;
          category?: string;
          currentValue?: string;
          options?: ({ value: string } | { options?: { value: string }[] })[];
        }[];
      };
      const modeOpt = (ns.configOptions ?? []).find(
        (o) => o.id === "mode" || o.category === "mode",
      );
      if (modeOpt) {
        const flat = (modeOpt.options ?? []).flatMap((o) =>
          "value" in o
            ? [o.value]
            : ((o as { options?: { value: string }[] }).options ?? []).map((x) => x.value),
        );
        modes = flat.filter((v) => !SKIP_MODE.test(v));
        defaultMode = modeOpt.currentValue ?? null;
      }
    } catch (e) {
      results.push({ provider, mode: null, errors: [`discovery: ${String(e)}`] });
    }
    try {
      conn.close();
    } catch {}
    child.kill("SIGKILL");

    if (modes.length === 0) modes = [null as unknown as string];
    for (const mode of modes) {
      const r = await probe(provider, cmd, mode);
      (r as Record<string, unknown>).providerDefault = defaultMode;
      results.push(r);
      console.log(
        `done ${provider}/${mode}: file=${r.fileCreated} perms=${(r.permissionRequests as unknown[]).length} stop=${r.stopReason} err=${(r.errors as string[]).join(";").slice(0, 120)}`,
      );
    }
  }
  mkdirSync(join(ROOT, "spikes/out"), { recursive: true });
  writeFileSync(join(ROOT, "spikes/out/mode-probe.json"), JSON.stringify(results, null, 2));
  console.log("wrote spikes/out/mode-probe.json");
  process.exit(0);
}
main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
