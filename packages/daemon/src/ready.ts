export const READY_PREFIX = "UPBOT_READY ";

/** The line the daemon prints on stdout once it is listening on 127.0.0.1. */
export function readyLine(port: number): string {
  return `${READY_PREFIX}${JSON.stringify({ port })}`;
}

/**
 * Delivers the auth token as the first stdin line, then reads stdout until the
 * READY line and resolves with the announced port. On failure, stdout is
 * cancelled and the reader is released.
 */
export async function readReadyPort(
  proc: { stdin: unknown; stdout: unknown },
  token: string,
  timeoutMs: number,
): Promise<number> {
  const sink = proc.stdin as { write: (s: string) => void; flush: () => void };
  sink.write(`${token}\n`);
  sink.flush();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (result: { port: number } | { error: unknown }) => {
      if (settled) return;
      if ("port" in result) {
        try {
          reader.releaseLock();
        } catch (error) {
          settle({ error });
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result.port);
        return;
      }
      settled = true;
      clearTimeout(timer);
      void (async () => {
        try {
          await reader.cancel(result.error).catch(() => {});
        } catch {}
        try {
          reader.releaseLock();
        } catch {}
        reject(result.error);
      })();
    };
    timer = setTimeout(() => settle({ error: new Error("daemon did not print READY") }), timeoutMs);
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            settle({ error: new Error("daemon stdout closed before READY") });
            return;
          }
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf("\n");
          while (idx >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line.startsWith(READY_PREFIX)) {
              settle({ port: JSON.parse(line.slice(READY_PREFIX.length)).port });
              return;
            }
            idx = buf.indexOf("\n");
          }
        }
      } catch (error) {
        settle({ error });
      }
    };
    void pump();
  });
  return port;
}
