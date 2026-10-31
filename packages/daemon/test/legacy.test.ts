import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { migrateLegacyHome } from "../src/legacy";

const directories: string[] = [];
const databases: Database[] = [];
function temp() {
  const directory = mkdtempSync(join(tmpdir(), "boto-migration-"));
  directories.push(directory);
  return directory;
}
function database(directory = temp()) {
  const db = openDatabase(directory);
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("legacy home migration", () => {
  test.each(["UpBot", "BobAgent"])("moves ~/%s to ~/Boto and repoints workspaces", (name) => {
    const home = temp();
    const legacyWs = join(home, name, "agents", "a1");
    mkdirSync(legacyWs, { recursive: true });
    writeFileSync(join(legacyWs, "notes.txt"), "hi");
    const db = database();
    db.query(
      "INSERT INTO agents (id, name, instructions, provider, model, workspace_path, created_at, updated_at) VALUES ('a1','A','', 'devin', NULL, ?1, 0, 0)",
    ).run(legacyWs);
    db.query(
      "INSERT INTO agents (id, name, instructions, provider, model, workspace_path, created_at, updated_at) VALUES ('a2','B','', 'devin', NULL, '/elsewhere/a2', 0, 0)",
    ).run();
    migrateLegacyHome(db, join(home, "Boto", "agents"), () => {}, home);
    expect(existsSync(join(home, name))).toBe(false);
    expect(existsSync(join(home, "Boto", "agents", "a1", "notes.txt"))).toBe(true);
    const rows = db.query("SELECT id, workspace_path FROM agents ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a1", workspace_path: join(home, "Boto", "agents", "a1") },
      { id: "a2", workspace_path: "/elsewhere/a2" },
    ]);
    migrateLegacyHome(db, join(home, "Boto", "agents"), () => {}, home);
    expect(db.query("SELECT id, workspace_path FROM agents ORDER BY id").all()).toEqual(rows);
  });

  test("leaves custom agents roots alone", () => {
    const home = temp();
    mkdirSync(join(home, "BobAgent"), { recursive: true });
    const db = database();
    migrateLegacyHome(db, join(home, "custom", "agents"), () => {}, home);
    expect(existsSync(join(home, "BobAgent"))).toBe(true);
  });

  test("does not overwrite or merge an existing Boto home", () => {
    const home = temp();
    for (const name of ["UpBot", "Boto"]) {
      mkdirSync(join(home, name));
      writeFileSync(join(home, name, "notes.txt"), name);
    }
    migrateLegacyHome(database(), join(home, "Boto", "agents"), () => {}, home);
    for (const name of ["UpBot", "Boto"]) {
      expect(readFileSync(join(home, name, "notes.txt"), "utf8")).toBe(name);
    }
  });

  test("repairs paths after a home was moved before the database update", () => {
    const home = temp();
    mkdirSync(join(home, "Boto"));
    const db = database();
    const workspace = join(home, "UpBot", "agents", "a1");
    db.query(
      "INSERT INTO agents (id,name,instructions,provider,workspace_path,created_at,updated_at) VALUES ('a1','A','','devin',?,0,0)",
    ).run(workspace);
    migrateLegacyHome(db, join(home, "Boto", "agents"), () => {}, home);
    expect(db.query("SELECT workspace_path FROM agents").get()).toEqual({
      workspace_path: join(home, "Boto", "agents", "a1"),
    });
  });
});

describe("legacy database migration", () => {
  test("keeps existing records and is idempotent", () => {
    const directory = temp();
    const initial = openDatabase(directory);
    initial.query("INSERT INTO settings (key,value) VALUES ('migration.test','preserved')").run();
    initial.close();
    renameSync(join(directory, "boto.db"), join(directory, "upbot.db"));
    expect(
      database(directory).query("SELECT value FROM settings WHERE key='migration.test'").get(),
    ).toEqual({ value: "preserved" });
    expect(existsSync(join(directory, "upbot.db"))).toBe(false);
    expect(
      database(directory).query("SELECT value FROM settings WHERE key='migration.test'").get(),
    ).toEqual({ value: "preserved" });
  });

  test("checkpoints committed WAL records before moving the database", () => {
    const directory = temp();
    const file = join(directory, "upbot.db");
    const result = Bun.spawnSync([
      process.execPath,
      "-e",
      `const {Database}=require('bun:sqlite'); const db=new Database(${JSON.stringify(file)}); db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('from-wal')"); process.kill(process.pid,'SIGKILL');`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(`${file}-wal`)).toBe(true);
    expect(database(directory).query("SELECT * FROM preserved").get()).toEqual({
      value: "from-wal",
    });
  });

  test("does not replace an existing Boto database", () => {
    const directory = temp();
    database(directory);
    const legacy = new Database(join(directory, "upbot.db"));
    legacy.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('old')");
    legacy.close();
    database(directory);
    const old = new Database(join(directory, "upbot.db"));
    try {
      expect(old.query("SELECT * FROM preserved").get()).toEqual({ value: "old" });
    } finally {
      old.close();
    }
  });
});
