import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDatabase } from "../src/db";
import {
  deleteSetting,
  getSetting,
  hasSetting,
  InvalidSettingError,
  setSetting,
} from "../src/db/settings";

const db = () => openDatabase(mkdtempSync(join(tmpdir(), "upbot-data-")));

describe("settings store", () => {
  test("round-trips JSON values and returns the fallback when absent", () => {
    const d = db();
    const schema = z.array(z.string());
    expect(getSetting(d, "k", schema, [])).toEqual([]);
    setSetting(d, "k", ["a", "b"]);
    expect(getSetting(d, "k", schema, [])).toEqual(["a", "b"]);
  });

  test("keeps unknown object keys and rejects wrong shapes, naming the key", () => {
    const d = db();
    const schema = z.looseObject({ enabled: z.boolean() });
    setSetting(d, "k", { enabled: true, extra: 1 });
    expect(getSetting(d, "k", schema, { enabled: false })).toEqual({
      enabled: true,
      extra: 1,
    });
    setSetting(d, "k", { enabled: "yes" });
    try {
      getSetting(d, "k", schema, { enabled: false });
      throw new Error("expected invalid setting");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSettingError);
      expect((e as InvalidSettingError).key).toBe("k");
      expect((e as Error).message).toMatch(/settings\.k/);
    }
  });

  test("errors name the key on malformed JSON", () => {
    const d = db();
    const stored = "not-json-secret";
    d.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("k", stored);
    try {
      getSetting(d, "k", z.unknown(), null);
      throw new Error("expected invalid setting");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSettingError);
      expect((e as InvalidSettingError).key).toBe("k");
      expect((e as Error).message).toMatch(/settings\.k/);
      expect((e as Error).message).not.toContain(stored);
      expect((e as Error).message).toContain("malformed JSON");
    }
  });

  test("checks whether a setting row is present without parsing it", () => {
    const d = db();
    expect(hasSetting(d, "k")).toBe(false);
    d.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("k", "not-json");
    expect(hasSetting(d, "k")).toBe(true);
  });

  test("deleteSetting removes the row", () => {
    const d = db();
    setSetting(d, "k", 1);
    deleteSetting(d, "k");
    expect(getSetting(d, "k", z.number().nullable(), null)).toBeNull();
  });
});
