export const READY_PREFIX = "UPBOT_READY ";

/** The line the daemon prints on stdout once it is listening on 127.0.0.1. */
export function readyLine(port: number): string {
  return `${READY_PREFIX}${JSON.stringify({ port })}`;
}

/**
 * Delivers the auth token as the first stdin line, then reads stdout until the
 * READY line and resolves with the announced port. Rejects on timeout or when
 * stdout closes first.
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
    const timer = setTimeout(() => reject(new Error("daemon did not print READY")), timeoutMs);
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          reject(new Error("daemon stdout closed before READY"));
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith(READY_PREFIX)) {
            clearTimeout(timer);
            resolve(JSON.parse(line.slice(READY_PREFIX.length)).port);
            return;
          }
          idx = buf.indexOf("\n");
        }
      }
    };
    pump().catch(reject);
  });
  reader.releaseLock();
  return port;
}
