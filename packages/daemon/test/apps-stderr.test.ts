import { describe, expect, test } from "bun:test";
import { appStderrDiagnostics, redactValues } from "../src/apps";

describe("app stderr diagnostics", () => {
  test("omits the summary when no stderr was received", () => {
    expect(appStderrDiagnostics().summary()).toBe("");
  });

  test("retains only byte counts across chunks, newlines and partial UTF-8", () => {
    const diagnostic = appStderrDiagnostics();
    diagnostic.push(Buffer.from([0xc3]));
    diagnostic.push(Buffer.from([0xa9]));
    diagnostic.push("fictional\ncredential-fragment");
    expect(diagnostic.summary()).toBe("stderr output suppressed (31 bytes)");
  });

  test("bounds the counter without retaining oversized output", () => {
    const diagnostic = appStderrDiagnostics();
    diagnostic.push("x".repeat(1_000_001));
    diagnostic.push("fictional-credential");
    expect(diagnostic.summary()).toBe("stderr output suppressed (1000000+ bytes)");
  });

  test("redacts complete tool output and multiline credentials longest-first", () => {
    expect(
      redactValues("longer long\nsecret-line\nanother-secret-line", [
        "long",
        "longer",
        "prefix\n  secret-line  \nanother-secret-line\nsuffix",
      ]),
    ).toBe("[redacted] [redacted]\n[redacted]\n[redacted]");
  });

  test("redacts short multiline secret parts in tool results", () => {
    expect(redactValues("part", ["first\npart\nlast"])).toBe("[redacted]");
  });
});
