import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [logPath, ...sshArgs] = process.argv.slice(2);
if (!logPath) throw new Error("expected a RunSpec env log path");

const child = spawn("ssh", sshArgs, { stdio: ["pipe", "inherit", "inherit"] });
const sshStdin = child.stdin;
if (!sshStdin) throw new Error("ssh wrapper stdin is unavailable");
let firstLine = Buffer.alloc(0);
let logged = false;

process.stdin.on("data", (chunk: Buffer) => {
  if (!logged) {
    firstLine = Buffer.concat([firstLine, chunk]);
    const newline = firstLine.indexOf(10);
    if (newline >= 0) {
      logged = true;
      try {
        const spec = JSON.parse(firstLine.subarray(0, newline).toString("utf8")) as {
          agentId?: string;
          cmd?: string[];
          isolation?: string;
          env?: Record<string, string>;
        };
        if (spec.agentId && Array.isArray(spec.cmd)) {
          const env = spec.env ?? {};
          const entries = Object.entries(env);
          const credentialKeys = [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "GEMINI_API_KEY",
            "CURSOR_API_KEY",
          ];
          appendFileSync(
            logPath,
            `${JSON.stringify({
              agentId: spec.agentId,
              command: spec.cmd[0],
              isolation: spec.isolation,
              envKeys: entries.map(([key]) => key).sort(),
              credentialKeys: entries
                .map(([key]) => key)
                .filter((key) => credentialKeys.includes(key))
                .sort(),
              hasFakeCredential: entries.some(
                ([key, value]) => credentialKeys.includes(key) && value.includes("-fake-"),
              ),
              upbotKeys: entries.map(([key]) => key).filter((key) => key.startsWith("UPBOT_")),
              apiKeyKeys: entries.map(([key]) => key).filter((key) => credentialKeys.includes(key)),
              hasSentinelValue: entries.some(
                ([, value]) => value === "leak" || value === "sk-sentinel-leak",
              ),
            })}\n`,
          );
        }
      } catch {}
    }
  }
  if (!sshStdin.write(chunk)) process.stdin.pause();
});
process.stdin.on("end", () => sshStdin.end());
sshStdin.on("drain", () => process.stdin.resume());
process.stdin.on("error", () => child.kill("SIGTERM"));

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.once(signal, () => child.kill(signal));

child.once("close", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
