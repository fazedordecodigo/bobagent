import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { resolveCommandIn, spawnEnv } from "./env/login-path";
import { spawnChild } from "./env/spawn";

// Voice: text-to-speech with macOS `say` (or UPBOT_TTS_COMMAND, text on stdin) and
// speech-to-text with UPBOT_STT_COMMAND (JSON array, "{file}" = recorded audio path,
// transcript on stdout) or the `whisper` CLI when it is on PATH.

function jsonCommand(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
};

export class Voice {
  private speaking: ChildProcess | null = null;

  constructor(
    private dir: string,
    private pathEnv: () => string,
  ) {}

  private tts(): string[] | null {
    return jsonCommand("UPBOT_TTS_COMMAND") ?? (process.platform === "darwin" ? ["say"] : null);
  }

  private resolve(cmd: string): string | null {
    return resolveCommandIn(cmd, this.pathEnv().split(delimiter), {
      platform: process.platform,
      ...(process.env.PATHEXT ? { pathext: process.env.PATHEXT } : {}),
    });
  }

  private whisper(): string | null {
    return this.resolve("whisper");
  }

  status() {
    return {
      tts: this.tts() !== null,
      stt: jsonCommand("UPBOT_STT_COMMAND") !== null || this.whisper() !== null,
    };
  }

  speak(text: string): void {
    const cmd = this.tts();
    if (!cmd) throw new Error("text-to-speech is not available");
    this.stop();
    const p = spawnChild(this.resolve(cmd[0]!) ?? cmd[0]!, cmd.slice(1), {
      stdio: ["pipe", "ignore", "ignore"],
      env: spawnEnv(undefined, process.platform, this.pathEnv()),
    });
    p.stdin?.end(text.slice(0, 20_000));
    this.speaking = p;
  }

  stop(): void {
    try {
      this.speaking?.kill();
    } catch {}
    this.speaking = null;
  }

  async transcribe(audioBase64: string, mime: string): Promise<string> {
    const id = crypto.randomUUID();
    const work = join(this.dir, id);
    mkdirSync(work, { recursive: true });
    const file = join(work, `audio.${EXT[mime.split(";")[0]!.trim()] ?? "webm"}`);
    writeFileSync(file, Buffer.from(audioBase64, "base64"));
    try {
      const custom = jsonCommand("UPBOT_STT_COMMAND");
      const whisper = custom ? null : this.whisper();
      if (!custom && !whisper)
        throw new Error(
          "speech-to-text is not available (install whisper or set UPBOT_STT_COMMAND)",
        );
      const cmd = custom
        ? custom.map((a) => a.replaceAll("{file}", file))
        : [whisper!, file, "--model", "base", "--output_format", "txt", "--output_dir", work];
      const p = spawnChild(this.resolve(cmd[0]!) ?? cmd[0]!, cmd.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv(undefined, process.platform, this.pathEnv()),
      });
      const timer = setTimeout(() => p.kill(), 120_000);
      const [out, err, code] = await Promise.all([
        new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          p.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
          p.stdout?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          if (!p.stdout) resolve("");
        }),
        new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          p.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
          p.stderr?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          if (!p.stderr) resolve("");
        }),
        new Promise<number>((resolve, reject) => {
          p.once("error", reject);
          p.once("close", (exitCode) => resolve(exitCode ?? 1));
        }),
      ]);
      clearTimeout(timer);
      if (code !== 0) throw new Error(`transcription failed: ${err.trim().slice(0, 300)}`);
      if (custom) return out.trim();
      return (await Bun.file(join(work, "audio.txt")).text()).trim();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
