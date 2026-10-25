// Fake `ssh` for tests: ignores options, honours `-R <unix-socket>:127.0.0.1:<port>` by
// forwarding the socket to the local TCP port, and runs the remote command locally with
// HOME=$FAKE_SSH_HOME. Each invocation is logged to $FAKE_SSH_LOG.
import { spawn } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = argv.slice(0, sep);
const [target, remoteCmd] = argv.slice(sep + 1);
const forwards: string[] = [];
for (let i = 0; i < opts.length; i++) if (opts[i] === "-R") forwards.push(opts[++i]!);
if (process.env.FAKE_SSH_LOG) {
  appendFileSync(
    process.env.FAKE_SSH_LOG,
    `${JSON.stringify({
      opts,
      target,
      remoteCmd,
      leakedEnv: Object.keys(process.env).filter((k) => k.startsWith("UPBOT_")),
    })}\n`,
  );
}
if (target?.startsWith("unreachable")) {
  process.stderr.write("ssh: connect to host example port 22: Connection refused\n");
  process.exit(255);
}
const servers = forwards.map((f) => {
  const m = /^(.+):127\.0\.0\.1:(\d+)$/.exec(f)!;
  rmSync(m[1]!, { force: true });
  const s = createServer((c) => {
    const up = createConnection({ host: "127.0.0.1", port: Number(m[2]) });
    c.pipe(up).pipe(c);
    up.on("error", () => c.destroy());
    c.on("error", () => up.destroy());
  });
  s.listen(m[1]!);
  return { s, path: m[1]! };
});
const child = spawn("sh", ["-c", remoteCmd!], {
  stdio: "inherit",
  env: { ...process.env, HOME: process.env.FAKE_SSH_HOME! },
});
child.on("exit", (code) => {
  for (const { s, path } of servers) {
    s.close();
    rmSync(path, { force: true });
  }
  process.exit(code ?? 1);
});
