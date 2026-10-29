import { appendFileSync, readFileSync } from "node:fs";

const log = process.env.FAKE_PREFLIGHT_SSH_LOG;
const output = process.env.FAKE_PREFLIGHT_OUTPUT;
if (!log || !output) throw new Error("missing preflight fixture paths");
await Bun.stdin.text();
appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\n`);
process.stdout.write(readFileSync(output, "utf8"));
