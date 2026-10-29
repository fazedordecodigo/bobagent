import { expect, test } from "bun:test";
import { runUpdater, type UpdateLike } from "../src/lib/updater";

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
