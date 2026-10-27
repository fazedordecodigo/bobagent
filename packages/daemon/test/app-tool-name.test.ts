import { describe, expect, test } from "bun:test";
import { appToolName } from "../src/apps";

describe("appToolName", () => {
  test("returns sanitized, Grok-safe names capped at 64 characters", () => {
    const name = appToolName("microsof_learn", "microsoft_docs_search");
    const sanitized = appToolName("x", "a__b.c");
    const long = appToolName("x", "a".repeat(80));

    expect(name).toBe("microsof_learn-microsoft_docs_search");
    expect(sanitized).toBe("x-a_b_c");
    for (const value of [name, sanitized, long]) {
      expect(value).not.toContain("__");
      expect(value.length).toBeLessThanOrEqual(64);
    }
  });
});
