import { describe, expect, test } from "bun:test";
import { boundedAppError, redactValues, stderrLineBuffer } from "../src/apps";

describe("app stderr helpers", () => {
  test("joins a secret split across Buffer chunks into one line", () => {
    const buffer = stderrLineBuffer();
    buffer.push(Buffer.from("split-cred"));
    buffer.push(Buffer.from("ential\n"));
    expect(buffer.lines()).toEqual(["split-credential"]);
  });

  test("decodes multibyte characters split across Buffer chunks", () => {
    const buffer = stderrLineBuffer();
    buffer.push(Buffer.from([0xc3]));
    buffer.push(Buffer.from([0xa9, 0x0a]));
    expect(buffer.lines()).toEqual(["é"]);
  });

  test("keeps partial lines pending until newline or end", () => {
    const buffer = stderrLineBuffer();
    buffer.push("first");
    expect(buffer.lines()).toEqual([]);
    buffer.push("\nsecond");
    expect(buffer.lines()).toEqual(["first"]);
    buffer.end();
    expect(buffer.lines()).toEqual(["first", "second"]);
  });

  test("replaces over-long lines with one marker and drops their fragments", () => {
    const buffer = stderrLineBuffer(10, 5);
    buffer.push("abcdef");
    buffer.push("ignored\nkept\n");
    expect(buffer.lines()).toEqual(["[stderr line truncated]", "kept"]);
  });

  test("bounds the retained line window", () => {
    const buffer = stderrLineBuffer(3);
    buffer.push("one\ntwo\nthree\nfour\n");
    expect(buffer.lines()).toEqual(["two", "three", "four"]);
  });

  test("redacts multiline secret parts longest-first", () => {
    expect(
      redactValues("longer long\nsecret-line\nanother-secret-line", [
        "long",
        "longer",
        "prefix\n  secret-line  \nanother-secret-line\nsuffix",
      ]),
    ).toBe("[redacted] [redacted]\n[redacted]\n[redacted]");
  });

  test("keeps the stderr tail when the startup message exceeds the bound", () => {
    const result = boundedAppError("x".repeat(600), "stderr-tail-marker");
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).toEndWith("stderr-tail-marker");
  });
});
