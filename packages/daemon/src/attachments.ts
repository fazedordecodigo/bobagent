import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, win32 } from "node:path";
import type { ChatAttachment } from "@boto/protocol";
import { RpcError } from "./runtime/agent-runtime";

// Attachments sent with a chat message are written into the agent workspace
// (attachments/<id>/<name>) and referenced in the prompt by absolute path. ZIPs are extracted.

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function validExtraFields(data: Buffer, start: number, length: number): boolean {
  const end = start + length;
  if (end > data.length) return false;
  while (start < end) {
    if (start + 4 > end) return false;
    const id = data.readUInt16LE(start);
    const extraLength = data.readUInt16LE(start + 2);
    if (start + 4 + extraLength > end || id === 0x0001) return false;
    start += 4 + extraLength;
  }
  return true;
}

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

export function zipEntries(data: Buffer): { name: string; symlink: boolean }[] | null {
  try {
    const minOffset = Math.max(0, data.length - 65_557);
    let end = -1;
    for (let offset = data.length - 22; offset >= minOffset; offset--) {
      if (
        data.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + data.readUInt16LE(offset + 20) === data.length
      ) {
        end = offset;
        break;
      }
    }
    if (end < 0) return null;

    const disk = data.readUInt16LE(end + 4);
    const directoryDisk = data.readUInt16LE(end + 6);
    const diskEntries = data.readUInt16LE(end + 8);
    const totalEntries = data.readUInt16LE(end + 10);
    const directorySize = data.readUInt32LE(end + 12);
    const directoryOffset = data.readUInt32LE(end + 16);
    if (
      disk !== 0 ||
      directoryDisk !== 0 ||
      diskEntries === 0xffff ||
      totalEntries === 0xffff ||
      diskEntries !== totalEntries ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff ||
      directoryOffset + directorySize > end
    ) {
      return null;
    }

    const entries: {
      name: string;
      symlink: boolean;
      localOffset: number;
      localNameLength: number;
      localExtraLength: number;
      compressedSize: number;
      generalFlags: number;
    }[] = [];
    const names = new Set<string>();
    let offset = directoryOffset;
    const directoryEnd = directoryOffset + directorySize;
    for (let i = 0; i < totalEntries; i++) {
      if (offset + 46 > directoryEnd || data.readUInt32LE(offset) !== 0x02014b50) return null;
      const generalFlags = data.readUInt16LE(offset + 8);
      const compressionMethod = data.readUInt16LE(offset + 10);
      const crc32 = data.readUInt32LE(offset + 16);
      const compressedSize = data.readUInt32LE(offset + 20);
      const uncompressedSize = data.readUInt32LE(offset + 24);
      const nameLength = data.readUInt16LE(offset + 28);
      const extraLength = data.readUInt16LE(offset + 30);
      const commentLength = data.readUInt16LE(offset + 32);
      const startDisk = data.readUInt16LE(offset + 34);
      const externalAttrs = data.readUInt32LE(offset + 38);
      const localOffset = data.readUInt32LE(offset + 42);
      const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
      if (
        entryEnd > directoryEnd ||
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        startDisk === 0xffff ||
        localOffset === 0xffffffff
      ) {
        return null;
      }

      const nameStart = offset + 46;
      const nameBytes = data.subarray(nameStart, nameStart + nameLength);
      const centralExtraStart = nameStart + nameLength;
      if (!validExtraFields(data, centralExtraStart, extraLength)) return null;
      const name = nameBytes.toString("utf8");
      const normalizedName = name.replace(/\\/g, "/").toLowerCase();
      if (names.has(normalizedName)) return null;
      names.add(normalizedName);

      const localHeaderEnd = localOffset + 30;
      if (localHeaderEnd > directoryOffset || data.readUInt32LE(localOffset) !== 0x04034b50) {
        return null;
      }
      const localFlags = data.readUInt16LE(localOffset + 6);
      const localMethod = data.readUInt16LE(localOffset + 8);
      const localNameLength = data.readUInt16LE(localOffset + 26);
      const localExtraLength = data.readUInt16LE(localOffset + 28);
      const localNameStart = localHeaderEnd;
      const localNameEnd = localNameStart + localNameLength;
      const localExtraStart = localNameEnd;
      if (
        localExtraStart + localExtraLength > directoryOffset ||
        ((localFlags ^ generalFlags) & 0x0008) !== 0 ||
        localMethod !== compressionMethod ||
        ((localFlags & 0x0008) === 0 &&
          (data.readUInt32LE(localOffset + 14) !== crc32 ||
            data.readUInt32LE(localOffset + 18) !== compressedSize ||
            data.readUInt32LE(localOffset + 22) !== uncompressedSize)) ||
        !data.subarray(localNameStart, localNameEnd).equals(nameBytes) ||
        !validExtraFields(data, localExtraStart, localExtraLength)
      ) {
        return null;
      }
      entries.push({
        name,
        symlink: ((externalAttrs >>> 16) & 0o170000) === 0o120000,
        localOffset,
        localNameLength,
        localExtraLength,
        compressedSize,
        generalFlags,
      });
      offset = entryEnd;
    }
    if (offset !== directoryEnd) return null;

    const localEntries = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    if (localEntries.length === 0) return directoryOffset === 0 ? [] : null;
    if (localEntries[0]?.localOffset !== 0) return null;
    for (let i = 0; i < localEntries.length; i++) {
      const entry = localEntries[i];
      if (!entry || (i > 0 && localEntries[i - 1]?.localOffset === entry.localOffset)) return null;
      let end =
        entry.localOffset +
        30 +
        entry.localNameLength +
        entry.localExtraLength +
        entry.compressedSize;
      if ((entry.generalFlags & 0x0008) !== 0) {
        if (end + 12 > directoryOffset) return null;
        end += data.readUInt32LE(end) === 0x08074b50 ? 16 : 12;
      }
      if (end > directoryOffset || end !== (localEntries[i + 1]?.localOffset ?? directoryOffset)) {
        return null;
      }
    }
    return entries.map(({ name, symlink }) => ({ name, symlink }));
  } catch {
    return null;
  }
}

function hasSymlink(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return (
      stat.isSymbolicLink() ||
      (stat.isDirectory() && readdirSync(path).some((name) => hasSymlink(join(path, name))))
    );
  } catch {
    return true;
  }
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
      const windows = process.platform === "win32";
      const entries = zipEntries(f.data);
      const unsafe = entries?.some(
        ({ name: entry, symlink }) =>
          symlink ||
          isAbsolute(entry) ||
          win32.isAbsolute(entry) ||
          /^[A-Za-z]:/.test(entry) ||
          entry.includes("\0") ||
          entry.split(/[\\/]/).includes(".."),
      );
      if (entries && !unsafe) {
        if (windows) mkdirSync(out, { recursive: true });
        const command = windows
          ? win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
          : "unzip";
        const args = windows ? ["-xf", path, "-C", out] : ["-qq", "-o", path, "-d", out];
        const r = Bun.spawnSync([command, ...args], {
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: windows,
        });
        if (r.exitCode === 0) {
          if (hasSymlink(out)) rmSync(out, { recursive: true, force: true });
          else att.extractedTo = out;
        }
      }
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
