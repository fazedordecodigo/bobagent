import { expect, spyOn, test } from "bun:test";
import { readReadyPort } from "../src/ready";

const encoder = new TextEncoder();

function fakeProc(stdout: ReadableStream<Uint8Array>, written: string[]) {
  return {
    stdin: {
      write(value: string) {
        written.push(value);
      },
      flush() {},
    },
    stdout,
  };
}

test("reads a split READY line and leaves stdout available", async () => {
  const written: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled: unknown;
  const stdout = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      streamController.enqueue(encoder.encode('log\nUPBOT_READY {"po'));
      streamController.enqueue(encoder.encode('rt":4321}\n'));
    },
    cancel(reason) {
      cancelled = reason;
      return new Promise<void>(() => {});
    },
  });

  await expect(readReadyPort(fakeProc(stdout, written), "tok", 1000)).resolves.toBe(4321);
  expect(written).toEqual(["tok\n"]);
  expect(stdout.locked).toBe(false);
  expect(cancelled).toBeUndefined();

  controller?.enqueue(encoder.encode("later\n"));
  const reader = stdout.getReader();
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: encoder.encode("later\n"),
  });
  reader.releaseLock();
});

test("cancels stdout and releases its reader on timeout", async () => {
  const written: string[] = [];
  let cancelled: unknown;
  const stdout = new ReadableStream<Uint8Array>({
    pull() {},
    cancel(reason) {
      cancelled = reason;
    },
  });

  await expect(readReadyPort(fakeProc(stdout, written), "tok", 50)).rejects.toThrow(
    "daemon did not print READY",
  );
  expect(cancelled).toBeInstanceOf(Error);
  expect(stdout.locked).toBe(false);
});

test("rejects on timeout even if stdout cancellation never settles", async () => {
  let cancelled: unknown;
  const stdout = new ReadableStream<Uint8Array>({
    pull() {},
    cancel(reason) {
      cancelled = reason;
      return new Promise<void>(() => {});
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = Promise.race([
    readReadyPort(fakeProc(stdout, []), "tok", 50),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("READY rejection test timed out")), 1500);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  await expect(result).rejects.toThrow("daemon did not print READY");
  expect(cancelled).toBeInstanceOf(Error);
  expect(stdout.locked).toBe(false);
}, 2000);

test("releases its reader when stdout closes before READY", async () => {
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  await expect(readReadyPort(fakeProc(stdout, []), "tok", 1000)).rejects.toThrow(
    "daemon stdout closed before READY",
  );
  expect(stdout.locked).toBe(false);
});

test("clears its timer and releases its reader when reading fails", async () => {
  const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("boom"));
    },
  });

  try {
    await expect(readReadyPort(fakeProc(stdout, []), "tok", 50)).rejects.toThrow("boom");
    expect(stdout.locked).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  } finally {
    clearTimeoutSpy.mockRestore();
  }
});

test("cancels stdout and releases its reader for malformed READY JSON", async () => {
  let cancelled: unknown;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("UPBOT_READY {bad\n"));
    },
    cancel(reason) {
      cancelled = reason;
    },
  });

  await expect(readReadyPort(fakeProc(stdout, []), "tok", 1000)).rejects.toBeInstanceOf(
    SyntaxError,
  );
  expect(cancelled).toBeInstanceOf(SyntaxError);
  expect(stdout.locked).toBe(false);
});
