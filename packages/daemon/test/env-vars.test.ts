import { afterEach, describe, expect, test } from "bun:test";
import { envNumber, envOverride, envPositiveNumber, envStringArray } from "../src/env/vars";

const NAME = "BOTO_TEST_ENV_VARS";

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

describe("envNumber", () => {
  test("returns the fallback when unset, empty, or non-numeric", () => {
    expect(envNumber(NAME, 42)).toBe(42);
    for (const raw of ["abc", "oito", "10x", "Infinity", "NaN", "", "   "]) {
      process.env[NAME] = raw;
      expect(envNumber(NAME, 42)).toBe(42);
    }
  });

  test("requires a positive number by default", () => {
    for (const raw of ["0", "-5", "-0.1"]) {
      process.env[NAME] = raw;
      expect(envNumber(NAME, 42)).toBe(42);
    }
    process.env[NAME] = "7";
    expect(envNumber(NAME, 42)).toBe(7);
    process.env[NAME] = "0.5";
    expect(envNumber(NAME, 42)).toBe(0.5);
  });

  test("honors zero when min is 0", () => {
    process.env[NAME] = "0";
    expect(envNumber(NAME, 42, { min: 0 })).toBe(0);
    process.env[NAME] = "-1";
    expect(envNumber(NAME, 42, { min: 0 })).toBe(42);
  });

  test("rejects values above max", () => {
    process.env[NAME] = "2";
    expect(envNumber(NAME, 0.85, { max: 1 })).toBe(0.85);
    process.env[NAME] = "1";
    expect(envNumber(NAME, 0.85, { max: 1 })).toBe(1);
    process.env[NAME] = "0.5";
    expect(envNumber(NAME, 0.85, { max: 1 })).toBe(0.5);
  });

  test("requires an integer when integer is true", () => {
    for (const raw of ["1.5", "0.1"]) {
      process.env[NAME] = raw;
      expect(envNumber(NAME, 8, { integer: true })).toBe(8);
    }
    process.env[NAME] = "4";
    expect(envNumber(NAME, 8, { integer: true })).toBe(4);
  });

  test("trims surrounding whitespace", () => {
    process.env[NAME] = "  25  ";
    expect(envNumber(NAME, 42)).toBe(25);
  });
});
