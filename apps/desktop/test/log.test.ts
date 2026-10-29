import { expect, test } from "bun:test";
import {
  DAEMON_NOT_CONNECTED,
  DAEMON_SOCKET_CLOSED,
  DAEMON_SOCKET_ERROR,
  errorFields,
} from "../src/lib/log";

test("RPC errors log only whitelisted codes", () => {
  const error = Object.assign(new Error("bad token=sk-live-123"), { code: "bad_request" });
  const fields = errorFields(error);
  expect(fields).toEqual({ code: "bad_request" });
  expect(JSON.stringify(fields)).not.toContain("bad token=sk-live-123");
  expect(JSON.stringify(fields)).not.toContain("sk-live-123");
});

test("invalid RPC error codes are replaced with a fixed value", () => {
  const fields = errorFields(Object.assign(new Error("password hunter2"), { code: "Bad Code" }));
  expect(fields).toEqual({ code: "invalid" });
  expect(JSON.stringify(fields)).not.toContain("password hunter2");
  expect(JSON.stringify(fields)).not.toContain("hunter2");
});

test("known transport errors retain their constant messages", () => {
  for (const error of [DAEMON_NOT_CONNECTED, DAEMON_SOCKET_CLOSED, DAEMON_SOCKET_ERROR]) {
    const fields = errorFields(new Error(error));
    expect(fields).toEqual({ error });
  }
});

test("generic errors and primitive values log only their type", () => {
  const error = errorFields(new Error("password hunter2"));
  const value = errorFields("secret");
  expect(error).toEqual({ errorType: "Error" });
  expect(value).toEqual({ errorType: "string" });
  const serialized = JSON.stringify([error, value]);
  expect(serialized).not.toContain("password hunter2");
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("secret");
});
