import { expect, test } from "bun:test";
import { logVersion, pendingUpdate, runUpdater, type UpdateLike } from "../src/lib/updater";

function fakeUpdate(downloadAndInstall: () => Promise<void> = async () => {}) {
  return { version: "2.10.1", downloadAndInstall } satisfies UpdateLike;
}

function logger() {
  return {
    info: () => {},
    error: () => {},
  };
}

test("install failure preserves the update and logs its phase without the message", async () => {
  const secret = "token=sk-secret-xyz";
  const update = fakeUpdate(() => Promise.reject(new Error(secret)));
  const log = {
    info: () => {},
    error: (scope: string, fields?: Record<string, unknown>) => calls.push([scope, fields]),
  };
  const calls: [string, Record<string, unknown> | undefined][] = [];

  const outcome = await runUpdater(update, async () => null, log);

  expect(outcome).toEqual({
    kind: "failed",
    phase: "install",
    update,
    error: new Error(secret),
  });
  expect(calls).toEqual([
    ["updater.failed", { phase: "install", version: "2.10.1", errorType: "Error" }],
  ]);
  expect(JSON.stringify(calls)).not.toContain(secret);
});

test("check failure reports the check phase", async () => {
  const error = new Error("password hunter2");
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const log = {
    ...logger(),
    error: (scope: string, fields?: Record<string, unknown>) => calls.push([scope, fields]),
  };

  const outcome = await runUpdater(null, () => Promise.reject(error), log);

  expect(outcome).toEqual({ kind: "failed", phase: "check", update: null, error });
  expect(calls).toEqual([
    ["updater.failed", { phase: "check", version: undefined, errorType: "Error" }],
  ]);
  expect(JSON.stringify(calls)).not.toContain("password hunter2");
});

test("checks return either the available update or null", async () => {
  const update = fakeUpdate();
  expect(await runUpdater(null, async () => update)).toEqual({ kind: "checked", update });
  expect(await runUpdater(null, async () => null)).toEqual({ kind: "checked", update: null });
});

test("successful install logs and returns the installed update", async () => {
  const update = fakeUpdate();
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const log = {
    info: (scope: string, fields?: Record<string, unknown>) => calls.push([scope, fields]),
    error: () => {},
  };

  expect(await runUpdater(update, async () => null, log)).toEqual({
    kind: "installed",
    update,
  });
  expect(calls).toEqual([["updater.installed", { version: "2.10.1" }]]);
});

test("remote version is logged only as plain x.y.z", async () => {
  const secret = "1.0.0-token=sk-secret-xyz";
  const update = { version: secret, downloadAndInstall: () => Promise.reject(new Error("x")) };
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const log = {
    info: (scope: string, fields?: Record<string, unknown>) => calls.push([scope, fields]),
    error: (scope: string, fields?: Record<string, unknown>) => calls.push([scope, fields]),
  };

  await runUpdater(update, async () => null, log);
  await runUpdater({ ...update, downloadAndInstall: async () => {} }, async () => null, log);

  expect(calls).toEqual([
    ["updater.failed", { phase: "install", version: "invalid", errorType: "Error" }],
    ["updater.installed", { version: "invalid" }],
  ]);
  expect(JSON.stringify(calls)).not.toContain("sk-secret-xyz");
  expect(logVersion("2.10.1")).toBe("2.10.1");
  expect(logVersion("2.10.1\nforged")).toBe("invalid");
  expect(logVersion(undefined)).toBeUndefined();
});

test("only a freshly checked update is installed; errors re-check", () => {
  const update = fakeUpdate();
  expect(pendingUpdate("available", update)).toBe(update);
  expect(pendingUpdate("error", update)).toBeNull();
  expect(pendingUpdate("none", null)).toBeNull();
  expect(pendingUpdate("idle", update)).toBeNull();
});
