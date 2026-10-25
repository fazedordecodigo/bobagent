import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { migrateLegacyHome } from "../src/legacy";

describe("legacy BobAgent home migration", () => {
  test("moves ~/BobAgent to ~/UpBot and repoints workspaces", () => {
    const home = mkdtempSync(join(tmpdir(), "upbot-home-"));
    const legacyWs = join(home, "BobAgent", "agents", "a1");
    mkdirSync(legacyWs, { recursive: true });
    writeFileSync(join(legacyWs, "notes.txt"), "hi");
    const db = openDatabase(mkdtempSync(join(tmpdir(), "upbot-data-")));
    db.query(
      "INSERT INTO agents (id, name, instructions, provider, model, workspace_path, created_at, updated_at) VALUES ('a1','A','', 'devin', NULL, ?1, 0, 0)",
    ).run(legacyWs);
    db.query(
      "INSERT INTO agents (id, name, instructions, provider, model, workspace_path, created_at, updated_at) VALUES ('a2','B','', 'devin', NULL, '/elsewhere/a2', 0, 0)",
    ).run();
    migrateLegacyHome(db, join(home, "UpBot", "agents"), () => {}, home);
    expect(existsSync(join(home, "BobAgent"))).toBe(false);
    expect(existsSync(join(home, "UpBot", "agents", "a1", "notes.txt"))).toBe(true);
    const rows = db.query("SELECT id, workspace_path FROM agents ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a1", workspace_path: join(home, "UpBot", "agents", "a1") },
      { id: "a2", workspace_path: "/elsewhere/a2" },
    ]);
  });

  test("leaves custom agents roots alone", () => {
    const home = mkdtempSync(join(tmpdir(), "upbot-home-"));
    mkdirSync(join(home, "BobAgent"), { recursive: true });
    const db = openDatabase(mkdtempSync(join(tmpdir(), "upbot-data-")));
    migrateLegacyHome(db, join(home, "custom", "agents"), () => {}, home);
    expect(existsSync(join(home, "BobAgent"))).toBe(true);
  });
});
