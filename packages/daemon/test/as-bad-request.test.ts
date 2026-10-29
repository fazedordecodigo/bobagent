import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/providers/types";
import { asBadRequest, RpcError } from "../src/runtime/agent-runtime";

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

describe("asBadRequest", () => {
  test("preserves synchronous and asynchronous return values", async () => {
    const value = { ok: true };
    const syncResult = asBadRequest(() => value);
    expect(syncResult).toBe(value);
    expect(syncResult).not.toBeInstanceOf(Promise);
    await expect(asBadRequest(async () => value)).resolves.toBe(value);
  });

  test("converts synchronous throws and asynchronous rejections", async () => {
    const syncError = caught(() =>
      asBadRequest(() => {
        throw new Error("x");
      }),
    );
    expect(syncError).toBeInstanceOf(RpcError);
    expect(syncError).toMatchObject({ code: "bad_request", message: "x" });

    await expect(
      asBadRequest(async () => {
        throw new Error("y");
      }),
    ).rejects.toMatchObject({ code: "bad_request", message: "y" });
  });

  test("passes through RpcError instances synchronously and asynchronously", async () => {
    const syncError = new RpcError("not_found", "missing");
    expect(
      caught(() =>
        asBadRequest(() => {
          throw syncError;
        }),
      ),
    ).toBe(syncError);

    const asyncError = new RpcError("not_found", "missing async");
    await expect(
      asBadRequest(async () => {
        throw asyncError;
      }),
    ).rejects.toBe(asyncError);
  });

  test("passes through ProviderError instances synchronously and asynchronously", async () => {
    const syncError = new ProviderError("auth_required", "sign in");
    expect(
      caught(() =>
        asBadRequest(() => {
          throw syncError;
        }),
      ),
    ).toBe(syncError);

    const asyncError = new ProviderError("auth_required", "sign in async");
    await expect(
      asBadRequest(async () => {
        throw asyncError;
      }),
    ).rejects.toBe(asyncError);
  });

  test("passes through non-Error throws synchronously and asynchronously", async () => {
    for (const thrown of ["unexpected", { unexpected: true }]) {
      const syncError = caught(() =>
        asBadRequest(() => {
          throw thrown;
        }),
      );
      expect(syncError).toBe(thrown);
      expect(syncError).not.toBeInstanceOf(RpcError);

      await expect(
        asBadRequest(async () => {
          throw thrown;
        }),
      ).rejects.toBe(thrown);
      expect(thrown).not.toBeInstanceOf(RpcError);
    }
  });
});
