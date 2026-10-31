import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents";
import { openDatabase } from "../src/db";
import { DEFAULT_BOT_NAME, seedDefaultBot } from "../src/persona";

const saved = process.env.BOTO_DEFAULT_BOT;
afterEach(() => {
  if (saved === undefined) delete process.env.BOTO_DEFAULT_BOT;
  else process.env.BOTO_DEFAULT_BOT = saved;
});

describe("default Boto bot", () => {
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
