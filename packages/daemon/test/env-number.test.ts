import { afterEach, describe, expect, test } from "bun:test";
import { envNumber } from "../src/env/config";

const NAME = "UPBOT_TEST_ENV_NUMBER";
const saved = process.env[NAME];

afterEach(() => {
  if (saved === undefined) delete process.env[NAME];
  else process.env[NAME] = saved;
});

describe("envNumber", () => {
  test("returns the fallback when unset or empty", () => {
    delete process.env[NAME];
    expect(envNumber(NAME, 42)).toBe(42);
    process.env[NAME] = "";
    expect(envNumber(NAME, 42)).toBe(42);
    process.env[NAME] = "   ";
    expect(envNumber(NAME, 42)).toBe(42);
  });

  test("returns the fallback for non-numeric values instead of NaN", () => {
    for (const bad of ["abc", "oito", "10x", "Infinity", "NaN"]) {
      process.env[NAME] = bad;
      expect(envNumber(NAME, 42)).toBe(42);
    }
  });

  test("requires a positive value by default", () => {
    for (const bad of ["0", "-5", "-0.1"]) {
      process.env[NAME] = bad;
      expect(envNumber(NAME, 42)).toBe(42);
    }
    process.env[NAME] = "7";
    expect(envNumber(NAME, 42)).toBe(7);
    process.env[NAME] = "0.5";
    expect(envNumber(NAME, 42)).toBe(0.5);
  });

  test("min: 0 honors an explicit zero", () => {
    process.env[NAME] = "0";
    expect(envNumber(NAME, 42, { min: 0 })).toBe(0);
    process.env[NAME] = "-1";
    expect(envNumber(NAME, 42, { min: 0 })).toBe(42);
  });

  test("max rejects values above the bound", () => {
    process.env[NAME] = "1.5";
    expect(envNumber(NAME, 0.85, { max: 1 })).toBe(0.85);
    process.env[NAME] = "1";
    expect(envNumber(NAME, 0.85, { max: 1 })).toBe(1);
  });

  test("integer: true rejects fractional values", () => {
    process.env[NAME] = "3.5";
    expect(envNumber(NAME, 8, { integer: true })).toBe(8);
    process.env[NAME] = "4";
    expect(envNumber(NAME, 8, { integer: true })).toBe(4);
  });
});
