import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents";
import { openDatabase } from "../src/db";
import { DEFAULT_BOT_INSTRUCTIONS, DEFAULT_BOT_NAME, seedDefaultBot } from "../src/persona";

const saved = process.env.BOTO_DEFAULT_BOT;
afterEach(() => {
  if (saved === undefined) delete process.env.BOTO_DEFAULT_BOT;
  else process.env.BOTO_DEFAULT_BOT = saved;
});

describe("default Boto bot", () => {
  test("updates an unchanged seeded UpBot without modifying custom bots", () => {
    const db = openDatabase(mkdtempSync(join(tmpdir(), "boto-data-")));
    const store = new AgentStore(db, join(mkdtempSync(join(tmpdir(), "boto-root-")), "agents"));
    const legacy = store.create({
      name: "UpBot",
      provider: "claude",
      instructions: DEFAULT_BOT_INSTRUCTIONS.replace("You are Boto", "You are UpBot"),
    });
    const custom = store.create({
      name: "UpBot",
      provider: "claude",
      instructions: "My customized assistant",
    });
    db.query("INSERT INTO settings (key,value) VALUES ('default_bot_seeded','1')").run();
    seedDefaultBot(db, store);
    seedDefaultBot(db, store);
    expect(store.get(legacy.id)?.name).toBe("Boto");
    expect(store.get(legacy.id)?.instructions).toBe(DEFAULT_BOT_INSTRUCTIONS);
    expect(store.get(custom.id)?.name).toBe("UpBot");
    expect(store.get(custom.id)?.instructions).toBe("My customized assistant");
    db.close();
  });
  test("is created once on a fresh install", () => {
    delete process.env.BOTO_DEFAULT_BOT;
    const db = openDatabase(mkdtempSync(join(tmpdir(), "boto-data-")));
    const store = new AgentStore(db, join(mkdtempSync(join(tmpdir(), "boto-root-")), "agents"));
    seedDefaultBot(db, store);
    expect(store.list().map((a) => a.name)).toEqual([DEFAULT_BOT_NAME]);
    store.softDelete(store.list()[0]!.id);
    seedDefaultBot(db, store);
    expect(store.list()).toEqual([]);
  });

  test("is not added to an install that already has bots", () => {
    delete process.env.BOTO_DEFAULT_BOT;
    const db = openDatabase(mkdtempSync(join(tmpdir(), "boto-data-")));
    const store = new AgentStore(db, join(mkdtempSync(join(tmpdir(), "boto-root-")), "agents"));
    store.create({ name: "Mine", provider: "codex", instructions: "" });
    seedDefaultBot(db, store);
    expect(store.list().map((a) => a.name)).toEqual(["Mine"]);
  });
});
