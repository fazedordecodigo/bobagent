import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { resolveCommandIn, spawnEnv } from "./env/login-path";
import { spawnChild } from "./env/spawn";
import { envOverride } from "./env/vars";

// Voice: text-to-speech with macOS `say` (or UPBOT_TTS_COMMAND, text on stdin) and
// speech-to-text with UPBOT_STT_COMMAND (JSON array, "{file}" = recorded audio path,
// transcript on stdout) or the `whisper` CLI when it is on PATH.

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
    return envOverride("UPBOT_TTS_COMMAND") ?? (process.platform === "darwin" ? ["say"] : null);
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
      stt: envOverride("UPBOT_STT_COMMAND") !== null || this.whisper() !== null,
    };
  }

  async speak(text: string): Promise<void> {
    const cmd = this.tts();
    if (!cmd) throw new Error("text-to-speech is not available");
    this.stop();
    const bin = this.resolve(cmd[0]!);
    if (!bin) throw new Error(`text-to-speech command not found: ${cmd[0]}`);
    const p = spawnChild(bin, cmd.slice(1), {
      stdio: ["pipe", "ignore", "ignore"],
      env: spawnEnv(undefined, process.platform, this.pathEnv()),
    });
    this.speaking = p;
    p.stdin?.on("error", () => {});
    p.on("error", () => {
      if (this.speaking === p) this.speaking = null;
    });
    p.once("close", () => {
      if (this.speaking === p) this.speaking = null;
    });
    const spawned = new Promise<void>((resolve, reject) => {
      p.once("spawn", resolve);
      p.once("error", reject);
    });
    p.stdin?.end(text.slice(0, 20_000));
    await spawned;
  }

  stop(): void {
    this.speaking?.kill();
    this.speaking = null;
  }

  async transcribe(audioBase64: string, mime: string): Promise<string> {
    const id = crypto.randomUUID();
    const work = join(this.dir, id);
    mkdirSync(work, { recursive: true });
    const file = join(work, `audio.${EXT[mime.split(";")[0]!.trim()] ?? "webm"}`);
    writeFileSync(file, Buffer.from(audioBase64, "base64"));
    try {
      const custom = envOverride("UPBOT_STT_COMMAND");
      const whisper = custom ? null : this.whisper();
      if (!custom && !whisper)
        throw new Error(
          "speech-to-text is not available (install whisper or set UPBOT_STT_COMMAND)",
        );
      const cmd = custom
        ? custom.map((a) => a.replaceAll("{file}", file))
        : [whisper!, file, "--model", "base", "--output_format", "txt", "--output_dir", work];
      const bin = this.resolve(cmd[0]!);
      if (!bin) throw new Error(`speech-to-text command not found: ${cmd[0]}`);
      const p = spawnChild(bin, cmd.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv(undefined, process.platform, this.pathEnv()),
      });
      const timer = setTimeout(() => p.kill(), 120_000);
      try {
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
        if (code !== 0) throw new Error(`transcription failed: ${err.trim().slice(0, 300)}`);
        if (custom) return out.trim();
        return (await Bun.file(join(work, "audio.txt")).text()).trim();
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
