import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDatabase } from "../src/db";
import { deleteSetting, getSetting, setSetting } from "../src/db/settings";

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
    expect(() => getSetting(d, "k", schema, { enabled: false })).toThrow(/settings\.k/);
  });

  test("errors name the key on malformed JSON", () => {
    const d = db();
    d.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("k", "not-json");
    expect(() => getSetting(d, "k", z.unknown(), null)).toThrow(/settings\.k/);
  });

  test("deleteSetting removes the row", () => {
    const d = db();
    setSetting(d, "k", 1);
    deleteSetting(d, "k");
    expect(getSetting(d, "k", z.number().nullable(), null)).toBeNull();
  });
});
