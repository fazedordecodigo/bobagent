import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  readPids,
  startDaemon,
  stopTestChildren,
  tmp,
  waitForExit,
  waitForPidDead,
} from "./helpers";

for (const behavior of ["resume", "unknown", "error", "close", "auth", "new-error"]) {
  test(`ACP restart: ${behavior} session load`, async () => {
    const dataDir = tmp("acp-resume-data-");
    const agentsRoot = tmp("acp-resume-agents-");
    const stateDir = tmp("acp-resume-fake-");
    const token = crypto.randomUUID();
    let daemon: DaemonHandle | undefined;
    let client: DaemonClient | undefined;
    const start = async (env: Record<string, string> = {}) => {
      daemon = await startDaemon(dataDir, agentsRoot, token, {
        UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
        FAKE_ACP_STATE_DIR: stateDir,
        ...env,
      });
      client = await DaemonClient.connect(daemon.port, token);
      return client;
    };
    const stop = async () => {
      client?.close();
      daemon?.proc.kill("SIGTERM");
      if (daemon) await waitForExit(daemon.proc, 8000);
      for (const pid of readPids(stateDir)) await waitForPidDead(pid);
    };
    const send = async (c: DaemonClient, agentId: string, text: string) => {
      const { queueId } = (await c.request("chat.send", { agentId, text })) as {
        queueId: string;
      };
      return (await c.waitForEventWhere(
        "turn.ended",
        (event) => (event as Turn).queueId === queueId,
      )) as Turn;
    };
    try {
      let c = await start();
      const agent = (await c.request("agents.create", {
        name: "Resume",
        provider: "devin",
        instructions: "",
      })) as Agent;
      expect((await send(c, agent.id, "echo:earlier conversation")).status).toBe("completed");
      const firstPrompt = readLog(stateDir).find((entry) => entry.method === "session/prompt");
      if (!firstPrompt) throw new Error("Missing first session prompt");
      const oldSessionId = (firstPrompt.params as { sessionId: string }).sessionId;
      await stop();
      if (behavior === "unknown") rmSync(join(stateDir, "sessions.json"));
      c = await start({
        FAKE_ACP_LOAD_BEHAVIOR: behavior === "new-error" ? "close" : behavior,
        FAKE_ACP_NEW_ERROR: behavior === "new-error" ? "new session unavailable" : "",
      });
      const turn = await send(c, agent.id, "history");
      const log = readLog(stateDir);
      expect(
        log.filter((entry) => entry.method === "session/load").map((entry) => entry.params),
      ).toMatchObject([{ sessionId: oldSessionId }]);
      const prompts = log
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => entry.params as { sessionId: string; prompt: { text: string }[] });
      const history = (await c.request("chat.history", { agentId: agent.id })) as {
        items: ChatItem[];
      };
      const db = new Database(join(dataDir, "upbot.db"), { readonly: true });
      try {
        const stored = db
          .query("SELECT session_id FROM agent_sessions WHERE agent_id = ?")
          .get(agent.id);
        expect(stored).toEqual(
          behavior === "new-error" ? null : { session_id: prompts[prompts.length - 1]?.sessionId },
        );
      } finally {
        db.close();
      }
      if (behavior === "auth" || behavior === "new-error") {
        expect(turn.status).toBe("failed");
        expect(turn.error).toContain(
          behavior === "auth" ? "devin auth login" : "new session unavailable",
        );
        expect(prompts).toHaveLength(1);
        expect(log.filter((entry) => entry.method === "session/new")).toHaveLength(
          behavior === "auth" ? 1 : 2,
        );
      } else {
        expect(turn.status).toBe("completed");
        expect(history.items.filter((item) => item.kind === "error")).toHaveLength(0);
        expect(prompts).toHaveLength(2);
        if (behavior === "resume") {
          expect(prompts[1]?.sessionId).toBe(oldSessionId);
          expect(prompts[1]?.prompt[0]?.text).not.toContain("<conversation_history>");
        } else {
          expect(prompts[1]?.sessionId).not.toBe(oldSessionId);
          expect(prompts[1]?.prompt[0]?.text).toContain("<conversation_history>");
          expect(prompts[1]?.prompt[0]?.text).toContain("[assistant] earlier conversation");
          await stop();
          c = await start();
          expect((await send(c, agent.id, "echo:after recovery")).status).toBe("completed");
          const loads = readLog(stateDir).filter((entry) => entry.method === "session/load");
          expect(loads[1]?.params).toMatchObject({ sessionId: prompts[1]?.sessionId });
        }
      }
      await stop();
      expect(readPids(stateDir)).toHaveLength(
        behavior === "resume" || behavior === "auth" ? 2 : behavior === "new-error" ? 3 : 4,
      );
    } finally {
      client?.close();
      daemon?.proc.kill("SIGKILL");
      if (daemon) await daemon.proc.exited;
      await stopTestChildren(stateDir);
      for (const dir of [dataDir, agentsRoot, stateDir]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }, 30000);
}
