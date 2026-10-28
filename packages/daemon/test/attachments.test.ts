import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAttachments, zipEntries } from "../src/attachments";

type ZipEntry = { name: string; contents?: Buffer; mode?: number };

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = entry.contents ?? Buffer.alloc(0);
    const crc = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    central.push(centralHeader, name);
    localOffset += localHeader.length + name.length + contents.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...local, directory, end]);
}

describe("zipEntries", () => {
  test("reads entries from a normal stored ZIP", () => {
    const zip = storedZip([{ name: "notes.txt", contents: Buffer.from("hello") }]);
    expect(zipEntries(zip)).toEqual([{ name: "notes.txt", symlink: false }]);
  });

  test("identifies symlink entries", () => {
    const zip = storedZip([{ name: "link", mode: 0o120777 }]);
    expect(zipEntries(zip)).toEqual([{ name: "link", symlink: true }]);
  });

  test("reads traversal entry names for extraction validation", () => {
    const zip = storedZip([{ name: "../x" }]);
    expect(zipEntries(zip)).toEqual([{ name: "../x", symlink: false }]);
  });

  test("does not extract symlink or traversal ZIPs", () => {
    const workspace = mkdtempSync(join(tmpdir(), "upbot-attachments-"));
    try {
      for (const [name, zip] of [
        ["symlink.zip", storedZip([{ name: "link", mode: 0o120777 }])],
        ["traversal.zip", storedZip([{ name: "../x" }])],
      ] as const) {
        const [attachment] = saveAttachments(workspace, [
          { name, mime: "application/zip", dataBase64: zip.toString("base64") },
        ]);
        expect(attachment?.extractedTo).toBeUndefined();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
