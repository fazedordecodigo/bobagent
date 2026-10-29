import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/providers/types";
import { errorFields, RpcError } from "../src/runtime/agent-runtime";

describe("errorFields", () => {
  test("never includes an error message", () => {
    expect(errorFields(new Error("secret message"))).toBe("errorType=Error");
  });

  test("includes Node errno codes only", () => {
    expect(
      errorFields(Object.assign(new Error("ENOTDIR: failed at /secret/path"), { code: "ENOTDIR" })),
    ).toBe("errorType=Error code=ENOTDIR");
    expect(errorFields({ code: "sk-live-abc123" })).toBe("errorType=Object");
  });

  test("includes daemon-defined error codes without messages", () => {
    const rpc = errorFields(new RpcError("internal", "compaction failed: sk-SECRET"));
    expect(rpc).toBe("errorType=RpcError code=internal");
    expect(rpc).not.toContain("sk-SECRET");
    expect(errorFields(new ProviderError("auth_required", "provider error secret"))).toBe(
      "errorType=ProviderError code=auth_required",
    );
  });

  test("identifies non-error values", () => {
    expect(errorFields("sk-SECRET")).toBe("errorType=string");
    expect(errorFields(null)).toBe("errorType=null");
  });

  test("falls back for invalid constructor names", () => {
    const classWithName = (name: string): (new () => object) => {
      const ctor = class {};
      Object.defineProperty(ctor, "name", { value: name });
      return ctor;
    };
    const longName = classWithName("A".repeat(200));
    const invalidName = classWithName("Not-Valid");
    expect(errorFields(new longName())).toBe("errorType=object");
    expect(errorFields(new invalidName())).toBe("errorType=object");
  });
});
