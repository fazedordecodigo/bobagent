import { describe, expect, test } from "bun:test";
import { boundedAppError } from "../src/apps";

describe("app stderr helpers", () => {
  test("keeps the stderr tail when the startup message exceeds the bound", () => {
    const result = boundedAppError("x".repeat(600), "stderr-tail-marker");
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).toEndWith("stderr-tail-marker");
  });
});
