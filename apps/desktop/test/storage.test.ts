import { afterEach, beforeEach, expect, test } from "bun:test";
import { readStorage, writeStorage } from "../src/lib/storage";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let entries: Map<string, string>;
beforeEach(() => {
  entries = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    },
  });
});
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("migrates legacy preferences once", () => {
  entries.set("upbot.theme", "dark");
  expect(readStorage("boto.theme")).toBe("dark");
  expect(entries.has("upbot.theme")).toBe(false);
  expect(readStorage("boto.theme")).toBe("dark");
  writeStorage("boto.theme", "light");
  expect(readStorage("boto.theme")).toBe("light");
});

test("keeps current preferences and ignores unrelated legacy keys", () => {
  entries.set("upbot.theme", "dark");
  entries.set("boto.theme", "light");
  expect(readStorage("boto.theme")).toBe("light");
  expect(readStorage("other.theme")).toBe(null);
});
