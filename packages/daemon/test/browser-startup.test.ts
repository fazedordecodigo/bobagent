import { expect, test } from "bun:test";
import { waitForBrowserPort } from "../src/browser";

test("port discovery retries transient locks, missing and incomplete files", async () => {
  const values = ["ENOENT", "EBUSY", "EPERM", "1234", "1234\n/devtools/browser/test\n"];
  const result = await waitForBrowserPort(
    () => {
      const value = values.shift() ?? "";
      if (value.startsWith("E")) throw Object.assign(new Error(value), { code: value });
      return value;
    },
    () => true,
  );
  expect(result).toBe("1234\n/devtools/browser/test\n");
  expect(values).toEqual([]);
});

test("port discovery bounds retries and stops when Chromium exits", async () => {
  await expect(
    waitForBrowserPort(
      () => "",
      () => true,
      1,
    ),
  ).rejects.toThrow("the browser did not start");
  await expect(
    waitForBrowserPort(
      () => "",
      () => false,
    ),
  ).rejects.toThrow("the browser did not start");
});

test("port discovery does not hide unrelated filesystem errors", async () => {
  await expect(
    waitForBrowserPort(
      () => {
        throw Object.assign(new Error("disk failure"), { code: "EIO" });
      },
      () => true,
    ),
  ).rejects.toThrow("disk failure");
});
