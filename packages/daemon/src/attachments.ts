import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ChatAttachment } from "@upbot/protocol";
import { RpcError } from "./runtime/agent-runtime";

// Attachments sent with a chat message are written into the agent workspace
// (attachments/<id>/<name>) and referenced in the prompt by absolute path. ZIPs are extracted.

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const kindOf = (mime: string, name: string) => {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/zip" || extname(name).toLowerCase() === ".zip") return "zip archive";
  return "file";
};

function safeName(name: string): string {
  const n = basename(name.replace(/\\/g, "/"))
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+/, "_");
  return n.slice(0, 200) || "file";
}

export function saveAttachments(
  workspacePath: string,
  files: { name: string; mime: string; dataBase64: string }[],
): ChatAttachment[] {
  const decoded = files.map((f) => ({ ...f, data: Buffer.from(f.dataBase64, "base64") }));
  const total = decoded.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_TOTAL_BYTES) throw new RpcError("bad_request", "attachments exceed 25 MB");
  const dir = join(workspacePath, "attachments", crypto.randomUUID().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  return decoded.map((f) => {
    let name = safeName(f.name);
    for (let i = 2; used.has(name); i++) name = `${i}-${safeName(f.name)}`;
    used.add(name);
    const path = join(dir, name);
    writeFileSync(path, f.data);
    const att: ChatAttachment = {
      name,
      mime: f.mime || "application/octet-stream",
      size: f.data.length,
      path,
    };
    if (kindOf(att.mime, name) === "zip archive") {
      const out = join(dir, `${basename(name, extname(name))}-unzipped`);
      // unzip refuses entries escaping the target dir ("../") and absolute paths by default
      const r = Bun.spawnSync(["unzip", "-qq", "-o", path, "-d", out], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (r.exitCode === 0) att.extractedTo = out;
    }
    return att;
  });
}

export function attachmentsBlock(atts: ChatAttachment[]): string {
  if (atts.length === 0) return "";
  const lines = atts.map(
    (a) =>
      `- ${a.path} (${kindOf(a.mime, a.name)}, ${a.mime}, ${a.size} bytes${a.extractedTo ? `, extracted to ${a.extractedTo}` : ""})`,
  );
  return `<attachments>\nThe user attached these files (read them from disk):\n${lines.join("\n")}\n</attachments>\n\n`;
}
