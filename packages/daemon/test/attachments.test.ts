import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAttachments, zipEntries } from "../src/attachments";
import { storedZip } from "./fixtures/stored-zip";

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
      rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
