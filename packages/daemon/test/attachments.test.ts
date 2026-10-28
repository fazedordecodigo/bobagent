import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { saveAttachments, zipEntries } from "../src/attachments";
import { storedZip } from "./fixtures/stored-zip";

describe("zipEntries", () => {
  test("reads entries from stored ZIPs with and without data descriptors", () => {
    const zip = storedZip([
      { name: "notes.txt", contents: Buffer.from("hello") },
      { name: "descriptor.txt", contents: Buffer.from("world"), dataDescriptor: true },
    ]);
    expect(zipEntries(zip)).toEqual([
      { name: "notes.txt", symlink: false },
      { name: "descriptor.txt", symlink: false },
    ]);
  });

  test("identifies symlink entries", () => {
    const zip = storedZip([{ name: "link", mode: 0o120777 }]);
    expect(zipEntries(zip)).toEqual([{ name: "link", symlink: true }]);
  });

  test("reads traversal entry names for extraction validation", () => {
    const zip = storedZip([{ name: "../x" }]);
    expect(zipEntries(zip)).toEqual([{ name: "../x", symlink: false }]);
  });

  test("rejects local filenames that differ from the central directory", () => {
    const zip = storedZip([
      { name: "ok.txt", localName: "../evil.txt", contents: Buffer.from("evil") },
    ]);
    expect(zipEntries(zip)).toBeNull();
  });

  test("rejects unlisted local entries before the central directory", () => {
    const zip = storedZip([{ name: "listed.txt" }], [{ name: "hidden.txt" }]);
    expect(zipEntries(zip)).toBeNull();
  });

  test("rejects duplicate names after slash and case normalization", () => {
    const zip = storedZip([{ name: "folder\\item.txt" }, { name: "FOLDER/item.TXT" }]);
    expect(zipEntries(zip)).toBeNull();
  });

  test("rejects ZIP64 extras in local headers", () => {
    const zip = storedZip([{ name: "file.txt", localExtra: Buffer.from([1, 0, 0, 0]) }]);
    expect(zipEntries(zip)).toBeNull();
  });

  test("rejects mismatched data-descriptor flags", () => {
    const zip = storedZip([{ name: "file.txt", dataDescriptor: true, localFlags: 0 }]);
    expect(zipEntries(zip)).toBeNull();
  });

  test("rejects a local compression method that differs from the central directory", () => {
    const zip = storedZip([{ name: "file.txt", method: 8, localMethod: 0 }]);
    expect(zipEntries(zip)).toBeNull();
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

  test("does not extract a ZIP with a traversal local filename", () => {
    const workspace = mkdtempSync(join(tmpdir(), "upbot-attachments-"));
    try {
      const zip = storedZip([
        { name: "ok.txt", localName: "../evil.txt", contents: Buffer.from("evil") },
      ]);
      const attachment = saveAttachments(workspace, [
        { name: "bundle.zip", mime: "application/zip", dataBase64: zip.toString("base64") },
      ])[0];
      if (!attachment) throw new Error("attachment was not saved");
      expect(attachment.extractedTo).toBeUndefined();
      expect(existsSync(join(dirname(attachment.path), "evil.txt"))).toBe(false);
      expect(existsSync(join(workspace, "evil.txt"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("does not extract embedded local headers after a truncated local size", () => {
    const workspace = mkdtempSync(join(tmpdir(), "upbot-attachments-"));
    try {
      const evilName = "../evil.txt";
      const evilContents = Buffer.from("evil");
      const nestedLocalRecord = storedZip([{ name: evilName, contents: evilContents }]).subarray(
        0,
        30 + Buffer.byteLength(evilName) + evilContents.length,
      );
      const contents = Buffer.concat([Buffer.from("safe"), nestedLocalRecord]);
      const zip = storedZip([
        { name: "ok.txt", contents, localCompressedSize: Buffer.byteLength("safe") },
      ]);
      expect(zipEntries(zip)).toBeNull();
      const attachment = saveAttachments(workspace, [
        { name: "bundle.zip", mime: "application/zip", dataBase64: zip.toString("base64") },
      ])[0];
      if (!attachment) throw new Error("attachment was not saved");
      expect(attachment.extractedTo).toBeUndefined();
      expect(existsSync(join(dirname(attachment.path), "evil.txt"))).toBe(false);
      expect(existsSync(join(workspace, "evil.txt"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
