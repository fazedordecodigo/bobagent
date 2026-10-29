import { afterEach, describe, expect, test } from "bun:test";
import { envOverride, envPositiveNumber, envStringArray } from "../src/env/vars";

const NAME = "UPBOT_TEST_ENV_VARS";

afterEach(() => {
  delete process.env[NAME];
});

describe("envStringArray", () => {
  test("returns null when unset or invalid", () => {
    expect(envStringArray(NAME)).toBeNull();
    for (const raw of ["not json", "5", '"x"', "{}", '["a", 1]', '["a", null]']) {
      process.env[NAME] = raw;
      expect(envStringArray(NAME)).toBeNull();
    }
  });

  test("returns the parsed array of strings, including an empty one", () => {
    process.env[NAME] = "[]";
    expect(envStringArray(NAME)).toEqual([]);
    process.env[NAME] = '["a", "b"]';
    expect(envStringArray(NAME)).toEqual(["a", "b"]);
  });
});

describe("envOverride", () => {
  test("treats an empty array as unset", () => {
    process.env[NAME] = "[]";
    expect(envOverride(NAME)).toBeNull();
  });

  test("returns a non-empty array of strings", () => {
    process.env[NAME] = '["a", "b"]';
    expect(envOverride(NAME)).toEqual(["a", "b"]);
    delete process.env[NAME];
    expect(envOverride(NAME)).toBeNull();
    process.env[NAME] = "not json";
    expect(envOverride(NAME)).toBeNull();
  });
});

describe("envPositiveNumber", () => {
  test("returns the fallback when unset, non-numeric, or not positive", () => {
    expect(envPositiveNumber(NAME, 30)).toBe(30);
    for (const raw of ["abc", "", "0", "-3", "Infinity", "NaN"]) {
      process.env[NAME] = raw;
      expect(envPositiveNumber(NAME, 30)).toBe(30);
    }
  });

  test("returns the parsed positive number", () => {
    process.env[NAME] = "150";
    expect(envPositiveNumber(NAME, 30)).toBe(150);
    process.env[NAME] = "2.5";
    expect(envPositiveNumber(NAME, 30)).toBe(2.5);
  });
});
